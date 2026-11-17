import { describe, expect, test } from "bun:test";
import { RestartScheduler, htaccessRoots, withOlsLock } from "./htaccess-watcher";

const vhost = (docRoot: string, htaccess: boolean) => `docRoot                   ${docRoot}
enableGzip                1
${htaccess ? "rewrite  {\n  enable                  1\n  autoLoadHtaccess        1\n}\n" : ""}`;

describe("htaccessRoots", () => {
  test("only the sites that read .htaccess", () => {
    expect(htaccessRoots([vhost("/home/acme/public_html", true), vhost("/home/beta/public_html", false)])).toEqual(["/home/acme/public_html"]);
  });

  test("a folder inside another site is not watched twice", () => {
    const roots = htaccessRoots([vhost("/home/acme/public_html/blog", true), vhost("/home/acme/public_html", true), vhost("/home/acme/public_html2", true)]);
    expect(roots).toEqual(["/home/acme/public_html", "/home/acme/public_html2"]);
  });

  test("ignores whatever is outside /home: suspended sites, the hooks vhost, the OLS example", () => {
    expect(htaccessRoots([vhost("/srv/eaglepanel/empty", true), vhost("$VH_ROOT/html/", true), vhost("/home/../etc", true)])).toEqual([]);
  });

  test("autoLoadHtaccess 0 does not count", () => {
    expect(htaccessRoots([vhost("/home/acme/app", false).replace("enableGzip", "rewrite {\n  autoLoadHtaccess        0\n}\nenableGzip")])).toEqual([]);
  });
});

function scheduler(options: ConstructorParameters<typeof RestartScheduler>[1] = {}) {
  const restarts: number[] = [];
  const s = new RestartScheduler(async () => {
    restarts.push(Date.now());
  }, { quietMs: 30, maxDelayMs: 200, minGapMs: 0, ...options });
  return { s, restarts };
}

describe("RestartScheduler", () => {
  test("many changes in a row are a single restart", async () => {
    const { s, restarts } = scheduler();
    for (let i = 0; i < 20; i += 1) s.changed();
    await Bun.sleep(80);
    expect(restarts).toHaveLength(1);
    expect(s.pending).toBe(false);
  });

  test("changes that never stop still restart within maxDelayMs", async () => {
    const { s, restarts } = scheduler({ quietMs: 50, maxDelayMs: 100 });
    const start = Date.now();
    while (Date.now() - start < 160) {
      s.changed();
      await Bun.sleep(10);
    }
    s.stop();
    expect(restarts.length).toBeGreaterThanOrEqual(1);
    expect(restarts[0]! - start).toBeLessThan(150);
  });

  test("respects the minimum gap between restarts", async () => {
    const { s, restarts } = scheduler({ quietMs: 10, minGapMs: 150 });
    s.changed();
    await Bun.sleep(40);
    s.changed();
    await Bun.sleep(40);
    expect(restarts).toHaveLength(1);
    await Bun.sleep(150);
    expect(restarts).toHaveLength(2);
    expect(restarts[1]! - restarts[0]!).toBeGreaterThanOrEqual(140);
  });

  test("a restart from ols.sync already loaded what was pending", async () => {
    const { s, restarts } = scheduler();
    s.changed();
    s.olsRestarted();
    await Bun.sleep(80);
    expect(restarts).toHaveLength(0);
  });

  test("a change during a restart gets another one", async () => {
    const restarts: number[] = [];
    let s!: RestartScheduler;
    s = new RestartScheduler(async () => {
      restarts.push(Date.now());
      if (restarts.length === 1) s.changed();
      await Bun.sleep(20);
    }, { quietMs: 10, maxDelayMs: 100, minGapMs: 0 });
    s.changed();
    await Bun.sleep(120);
    expect(restarts).toHaveLength(2);
  });

  test("a failed restart does not stop the next ones", async () => {
    let calls = 0;
    const s = new RestartScheduler(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
    }, { quietMs: 10, minGapMs: 0 });
    const original = console.error;
    console.error = () => {};
    try {
      s.changed();
      await Bun.sleep(40);
      s.changed();
      await Bun.sleep(40);
    } finally {
      console.error = original;
    }
    expect(calls).toBe(2);
  });
});

describe("withOlsLock", () => {
  test("runs one at a time, even after a failure", async () => {
    const order: string[] = [];
    const slow = withOlsLock(async () => {
      order.push("sync:start");
      await Bun.sleep(30);
      order.push("sync:end");
      throw new Error("rejected");
    });
    const restart = withOlsLock(async () => {
      order.push("restart");
    });
    const failure = await slow.then(() => null, (error: Error) => error.message);
    await restart;
    expect(failure).toBe("rejected");
    expect(order).toEqual(["sync:start", "sync:end", "restart"]);
  });
});
