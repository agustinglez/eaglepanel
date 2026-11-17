import { describe, expect, test } from "bun:test";
import { containerArgs, containersConf, renderAppUnit, renderEnvFile, renderFirewall, renderNetnsUnit, renderSlotNft, timing } from "./apps";
import { dispatch } from "./dispatch";
import type { CommandResult, Host, RunOptions } from "./host";
import { applyBlock, renderHooksVhost, renderVhost } from "./ols";
import { DEFAULT_PHP_OPTIONS } from "@eaglepanel/shared";

// The real wait for in-flight requests is 5 s: tests do not need it.
timing.drainMs = 0;

const MANAGED = "acme:x:1001:1001:eaglepanel:/home/acme:/usr/sbin/nologin\n";

class FakeHost implements Host {
  readonly sandbox = false;
  readonly commands: { command: string; args: string[] }[] = [];
  readonly files = new Map<string, { content: string; mode?: number }>();
  respond: (command: string, args: string[]) => Partial<CommandResult> = (command, args) => {
    if (command === "getent") return { stdout: MANAGED };
    if (command === "sysctl") return { stdout: "1\n" };
    if (command === "iptables") return { stdout: "-A ufw-before-forward -i ep+ -o ens3 -j ACCEPT\n" };
    if (command === "ip") return { stdout: "default via 1.2.3.1 dev ens3 proto static\n" };
    if (command === "id" && (args[0] === "-u" || args[0] === "-g") && args.at(-1) === "acme") return { stdout: "1001\n" };
    if (command === "id") return { stdout: "65534\n" };
    if (command === "curl") return { stdout: "200" };
    if (command === "systemctl" && args[0] === "show" && args.includes("RuntimeDirectoryPreserve")) return { stdout: "yes\n" };
    return {};
  };

  async run(command: string, args: string[], _options: RunOptions = {}): Promise<CommandResult> {
    this.commands.push({ command, args });
    return { code: 0, stdout: "", stderr: "", ...this.respond(command, args) };
  }

  async writeFileAtomic(path: string, content: string, mode?: number): Promise<void> {
    this.files.set(path, { content, mode });
  }

  async readFile(path: string): Promise<string | null> {
    if (path.endsWith("httpd_config.conf")) return "user nobody\n";
    return this.files.get(path)?.content ?? null;
  }

  find(command: string) {
    return this.commands.find((entry) => entry.command === command);
  }

  lines() {
    return this.commands.map(({ command, args }) => `${command} ${args.join(" ")}`);
  }
}

const call = (host: Host, op: string, params: unknown) => dispatch({ op, params }, host);
const base = { appId: 7, username: "acme", fqdn: "api.example.com" };
const activate = { ...base, release: 3, startCommand: "bun run start", memoryMb: 256, healthPath: "/health", sinceMs: 1_793_000_000_000 } as const;
const BUILD = "/srv/eaglepanel/apps/acme/api.example.com/build";

describe("variables", () => {
  test("format tested on the VPS: double quotes, \\ and \" escaped, real line breaks", () => {
    expect(renderEnvFile({ A: "hola", B: 'dice "x"', C: "C:\\ruta", D: "l1\nl2", E: "$5 y ${HOME}", F: "a#b" })).toBe(
      'A="hola"\nB="dice \\"x\\""\nC="C:\\\\ruta"\nD="l1\nl2"\nE="$5 y ${HOME}"\nF="a#b"\n',
    );
  });

  test("written readable by root only, with the list of keys separately", async () => {
    const host = new FakeHost();
    expect(await call(host, "app.env", { appId: 7, runtime: { SECRET: "s" }, build: { PUBLIC: "p" } })).toMatchObject({ ok: true });
    expect(host.files.get("/etc/eaglepanel/apps/7/runtime.env")).toEqual({ content: 'SECRET="s"\n', mode: 0o600 });
    expect(host.files.get("/etc/eaglepanel/apps/7/build.env")).toEqual({ content: 'PUBLIC="p"\n', mode: 0o600 });
    expect(host.files.get("/etc/eaglepanel/apps/7/runtime.keys")).toEqual({ content: "SECRET\n", mode: 0o600 });
  });

  test.each([["PORT"], ["PATH"], ["DATA_DIR"], ["lower"], ["1A"], ["A-B"]])("rejects the key %s", async (key) => {
    const host = new FakeHost();
    expect(await call(host, "app.env", { appId: 7, runtime: { [key]: "x" }, build: {} })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });
});

describe("network and firewall", () => {
  test("namespace with the id addresses, idempotent and with the slot redirect", () => {
    const unit = renderNetnsUnit(7);
    expect(unit).toContain("ExecStart=/usr/sbin/ip addr add 10.88.0.29/30 dev epah7");
    expect(unit).toContain("ExecStart=/usr/sbin/ip -n epa7 addr add 10.88.0.30/30 dev eth0");
    expect(unit).toContain("ExecStartPre=-/usr/sbin/ip netns del epa7");
    expect(unit).toContain("ExecStartPost=-/usr/sbin/ip netns exec epa7 /usr/sbin/nft -f /etc/eaglepanel/apps/7/slot.nft");
    expect(unit).toContain("Requires=eaglepanel-apps-fw.service");
    // Interfaces of up to 15 characters: they fit even with the highest id.
    expect("epah16383".length).toBeLessThanOrEqual(15);
  });

  test("firewall: nothing to the host or private networks, and only root and OLS talk to the apps", () => {
    const rules = renderFirewall("ens3", "65534");
    expect(rules).toContain('iifname "epah*" drop');
    expect(rules).toContain('iifname "epah*" oifname "epah*" drop');
    expect(rules).toContain("192.168.0.0/16 } drop");
    expect(rules).toContain("meta skuid != { 0, 65534 } drop");
    expect(rules.startsWith("add table inet eaglepanel_apps\ndelete table inet eaglepanel_apps\n")).toBe(true);
  });

  test("prepares nothing if the server does not let apps reach the internet", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, args) => (command === "iptables" ? { stdout: "" } : respond(command, args));
    const response = await call(host, "app.prepare", { ...base, runtime: "bun", runtimeVersion: "1" });
    expect(response).toMatchObject({ ok: false, error: { message: expect.stringContaining("deploy/install.sh") } });
    expect(host.files.size).toBe(0);
  });

  test("prepares root directories, data as the account, firewall and namespace", async () => {
    const host = new FakeHost();
    expect(await call(host, "app.prepare", { ...base, runtime: "bun", runtimeVersion: "1" })).toMatchObject({ ok: true });
    const data = host.commands.find(({ command, args }) => command === "setpriv" && args.includes("/home/acme/data/api.example.com"));
    expect(data?.args.slice(0, 4)).toEqual(["--reuid=acme", "--regid=acme", "--clear-groups", "mkdir"]);
    // OLS traverses to the static files without being able to list them.
    expect(host.commands.find(({ command, args }) => command === "install" && args.includes("/srv/eaglepanel/apps/acme"))?.args).toEqual(expect.arrayContaining(["711"]));
    expect(host.files.get("/etc/eaglepanel/apps/firewall.nft")?.content).toContain('oifname "ens3" accept');
    expect(host.files.has("/etc/systemd/system/eaglepanel-netns-7.service")).toBe(true);
    expect(host.lines()).toContain("systemctl start eaglepanel-netns-7.service");
  });
});

describe("git", () => {
  test("clones without hooks or local transports, with its own key and the fingerprint accepted once", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, args) => {
      if (args.includes("rev-parse")) return { stdout: `${"a".repeat(40)}\n` };
      if (args.includes("log")) return { stdout: "Mensaje\n" };
      return respond(command, args);
    };
    expect(await call(host, "app.fetch", { appId: 7, repoUrl: "git@github.com:acme/api.git", branch: "main" })).toEqual({ ok: true, result: { commit: "a".repeat(40), message: "Mensaje" } });
    const fetch = host.commands.find(({ args }) => args.includes("fetch"));
    expect(fetch?.command).toBe("env");
    expect(fetch?.args.join(" ")).toContain("protocol.file.allow=never");
    expect(fetch?.args.join(" ")).toContain("core.hooksPath=/dev/null");
    expect(fetch?.args[0]).toContain("-i /srv/eaglepanel/keys/7 ");
    expect(fetch?.args[0]).toContain("StrictHostKeyChecking=accept-new");
    expect(fetch?.args.at(-1)).toBe("+refs/heads/main:refs/heads/main");
  });

  test("on a migration, installs the deploy key the app already had", async () => {
    const host = new FakeHost();
    const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1lZDI1NTE5\n-----END OPENSSH PRIVATE KEY-----\n";
    const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc eaglepanel-app-3";
    expect(await call(host, "migrate.deployKey", { appId: 7, privateKey, publicKey })).toEqual({ ok: true, result: { ok: true } });
    expect(host.files.get("/srv/eaglepanel/keys/7")).toEqual({ content: privateKey, mode: 0o600 });
    expect(host.files.get("/srv/eaglepanel/keys/7.pub")).toEqual({ content: `${publicKey}\n`, mode: 0o644 });
    const rsa = "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n";
    expect(await call(host, "migrate.deployKey", { appId: 7, privateKey: rsa, publicKey })).toMatchObject({ ok: false });
  });

  test("a queued commit is deployed only if it is still on the branch", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    let inBranch = true;
    host.respond = (command, args) => {
      if (args.includes("rev-parse")) return { stdout: `${"a".repeat(40)}\n` };
      if (args.includes("log")) return { stdout: "Anterior\n" };
      if (args.includes("merge-base")) return { code: inBranch ? 0 : 1 };
      return respond(command, args);
    };
    const params = { appId: 7, repoUrl: "git@github.com:acme/api.git", branch: "main", commit: "b".repeat(40) };
    expect(await call(host, "app.fetch", params)).toEqual({ ok: true, result: { commit: "b".repeat(40), message: "Anterior" } });
    expect(host.commands.find(({ args }) => args.includes("merge-base"))?.args.slice(-3)).toEqual(["--is-ancestor", "b".repeat(40), "a".repeat(40)]);
    inBranch = false;
    expect(await call(host, "app.fetch", params)).toMatchObject({ ok: false, error: { message: expect.stringContaining("no longer on main") } });
  });

  test.each([
    ["file:///etc"], ["/srv/eaglepanel/repos/1.git"], ["https://user:pass@github.com/a/b.git"], ["ext::sh -c id"], ["git@github.com:a/b.git; id"], ["--upload-pack=id"],
  ])("rejects the URL %s without running anything", async (repoUrl) => {
    const host = new FakeHost();
    expect(await call(host, "app.fetch", { appId: 7, repoUrl, branch: "main" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(host.commands).toEqual([]);
  });

  test.each([["-x"], ["a..b"], ["a b"], ["--upload-pack=id"]])("rejects the branch %s", async (branch) => {
    const host = new FakeHost();
    expect(await call(host, "app.fetch", { appId: 7, repoUrl: "https://github.com/a/b.git", branch })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  test("root builds the archive, but the account extracts it into the build directory, emptied first", async () => {
    const host = new FakeHost();
    await call(host, "app.unpack", { ...base, commit: "a".repeat(40), subdir: "apps/api" });
    expect(host.commands.find(({ args }) => args.includes("archive"))?.args.at(-1)).toBe(`${"a".repeat(40)}:apps/api`);
    expect(host.find("rm")?.args).toEqual(["-rf", "--", BUILD]);
    const extract = host.commands.find(({ command, args }) => command === "setpriv" && args.includes("tar"));
    expect(extract?.args.slice(0, 4)).toEqual(["--reuid=acme", "--regid=acme", "--clear-groups", "tar"]);
    expect(extract?.args).toContain(BUILD);
  });
});

describe("contenedores", () => {
  test("the account is the only container user, without capabilities, on its app network", () => {
    expect(containerArgs(7, "1001", "1001")).toEqual(expect.arrayContaining([
      "--init", "--network=ns:/run/netns/epa7", "--uidmap=0:1001:1", "--gidmap=0:1001:1", "--cap-drop=all", "--cgroups=disabled",
    ]));
  });

  test("no default sysctls: on a network created by root, Podman does not start with them", () => {
    expect(containersConf).toContain("default_sysctls = []");
    expect(containersConf).toContain('cgroup_manager = "cgroupfs"');
  });

  test("prepare pulls the official image of the series into the shared store", async () => {
    const host = new FakeHost();
    expect(await call(host, "app.prepare", { ...base, runtime: "bun", runtimeVersion: "1" })).toMatchObject({ ok: true });
    const pull = host.commands.find(({ args }) => args.includes("pull"));
    expect(pull?.args).toEqual(expect.arrayContaining(["CONTAINERS_STORAGE_CONF=/etc/eaglepanel/containers/storage.conf", "/usr/bin/podman", "pull", "docker.io/oven/bun:1-slim"]));
    expect(host.files.get("/etc/eaglepanel/containers/storage.conf")?.content).toContain('graphroot = "/srv/eaglepanel/containers"');
  });

  test("without Podman nothing is prepared", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, args) => (command === "test" && args.includes("/usr/bin/podman") ? { code: 1 } : respond(command, args));
    expect(await call(host, "app.prepare", { ...base, runtime: "bun", runtimeVersion: "1" })).toMatchObject({ ok: false, error: { message: expect.stringContaining("Podman") } });
    expect(host.files.size).toBe(0);
  });

  test("prepares nothing if MySQL deletes its socket directory when it stops", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, args) => (command === "systemctl" && args[0] === "show" ? { stdout: "no\n" } : respond(command, args));
    const response = await call(host, "app.prepare", { ...base, runtime: "bun", runtimeVersion: "1" });
    expect(response).toMatchObject({ ok: false, error: { message: expect.stringContaining("socket") } });
    expect(host.files.size).toBe(0);
  });
});

describe("build", () => {
  const build = { ...base, command: "bun install && bun run build -- --flag=$X", runtime: "bun", runtimeVersion: "1" } as const;
  const podmanArgs = (host: FakeHost) => {
    const args = host.find("systemd-run")?.args ?? [];
    return args.slice(args.indexOf("/usr/bin/podman"));
  };

  test("runs in an account container, on its network and with memory and time limits", async () => {
    const host = new FakeHost();
    expect(await call(host, "app.build", build)).toEqual({ ok: true, result: { code: 0, log: "" } });
    const unit = host.find("systemd-run")?.args.join(" ") ?? "";
    expect(unit).toContain("MemoryMax=1536M");
    expect(unit).toContain("RuntimeMaxSec=1200");
    expect(unit).toContain("EnvironmentFile=-/etc/eaglepanel/apps/7/build.env");
    const args = podmanArgs(host);
    expect(args).toEqual(expect.arrayContaining(["run", "--rm", "--uidmap=0:1001:1", "--network=ns:/run/netns/epa7", "docker.io/oven/bun:1-slim"]));
    expect(args).toContain(`--volume=${BUILD}:/app`);
  });

  test("the build does not see DATA_DIR: it has its own separate HOME", async () => {
    const host = new FakeHost();
    await call(host, "app.build", build);
    const args = podmanArgs(host);
    expect(args.join(" ")).not.toContain("/home/acme/data");
    expect(args).toContain("--volume=/home/acme/.build/api.example.com:/cache");
    expect(args).toContain("--env=HOME=/cache");
    // With NODE_ENV=production, the development dependencies the build needs are not installed.
    expect(args.some((arg) => arg.includes("NODE_ENV"))).toBe(false);
    // It does not reach MySQL either: the build runs repository commands before anyone reviews them.
    expect(args.join(" ")).not.toContain("/run/mysqld");
  });

  test("variables are passed by name only: values stay in the root file", async () => {
    const host = new FakeHost();
    await call(host, "app.env", { appId: 7, runtime: { SECRET: "s" }, build: { VITE_API: "https://api" } });
    await call(host, "app.build", build);
    const all = (host.find("systemd-run")?.args ?? []).join(" ");
    expect(podmanArgs(host)).toContain("--env=VITE_API");
    expect(all).not.toContain("https://api");
    expect(all).not.toContain("SECRET");
  });

  test("the command goes in a root script that the container reads", async () => {
    const host = new FakeHost();
    await call(host, "app.build", build);
    expect(host.files.get("/etc/eaglepanel/apps/7/build.sh")?.content).toContain("bun run build -- --flag=$X");
    expect(podmanArgs(host)).toContain("--volume=/etc/eaglepanel/apps/7/build.sh:/eaglepanel/build.sh:ro");
    expect(podmanArgs(host).slice(-2)).toEqual(["/bin/sh", "/eaglepanel/build.sh"]);
  });

  test("a failing build returns its code and output, not an agent error", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, args) => (command === "systemd-run" ? { code: 1, stdout: "Error: missing module\n" } : respond(command, args));
    expect(await call(host, "app.build", build)).toEqual({ ok: true, result: { code: 1, log: "Error: missing module\n" } });
  });

  test("rejects commands with line breaks", async () => {
    const host = new FakeHost();
    expect(await call(host, "app.build", { ...build, command: "bun i\nrm -rf /" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });
});

describe("versiones", () => {
  const release = { ...base, release: 3, runtime: "bun", runtimeVersion: "1" } as const;
  const DEST = "/srv/eaglepanel/apps/acme/api.example.com/releases/3";

  test("static: copies without following symlinks, without special or dot files, owned by root", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, args) => {
      if (command === "realpath") return { stdout: `${args.at(-1)}\n` };
      if (command === "find" && args.includes("-prune")) return { stdout: `${["/r/.env", "/r/.well-known", "/r/a/.git"].join("\0")}\0` };
      if (command === "sh") return { stdout: "12\n" };
      if (command === "du") return { stdout: "34567\t/r\n" };
      return respond(command, args);
    };
    expect(await call(host, "app.release", { ...release, kind: "static", outputDir: "dist" })).toEqual({ ok: true, result: { files: 12, bytes: 34567 } });
    expect(host.find("cp")?.args).toEqual(["-R", "--no-dereference", "--no-preserve=all", "--", `${BUILD}/dist/.`, DEST]);
    const removed = host.commands.filter(({ command }) => command === "rm").map(({ args }) => args.at(-1));
    expect(removed).toEqual(expect.arrayContaining(["/r/.env", "/r/a/.git", BUILD]));
    expect(removed).not.toContain("/r/.well-known");
    expect(host.commands.find(({ command }) => command === "chown")?.args).toEqual(["-R", "-P", "root:root", DEST]);
  });

  test("static: an output directory that points outside the build is not copied", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, args) => (command === "realpath" ? { stdout: args.at(-1)!.endsWith("/dist") ? "/etc/ssl/private\n" : `${args.at(-1)}\n` } : respond(command, args));
    expect(await call(host, "app.release", { ...release, kind: "static", outputDir: "dist" })).toMatchObject({ ok: false, error: { message: expect.stringContaining("did not produce the directory") } });
    expect(host.find("cp")).toBeUndefined();
  });

  test("server: one image per release, without network or pull, and the build is emptied", async () => {
    const host = new FakeHost();
    expect(await call(host, "app.release", { ...release, kind: "server", outputDir: "" })).toMatchObject({ ok: true });
    expect(host.files.get("/etc/eaglepanel/apps/7/Containerfile")?.content).toBe("FROM docker.io/oven/bun:1-slim\nCOPY . /app\nWORKDIR /app\n");
    const build = host.commands.find(({ args }) => args.includes("build"));
    expect(build?.args).toEqual(expect.arrayContaining(["--pull=never", "--network=none", "-t", "localhost/eaglepanel/app-7:3", BUILD]));
    expect(host.commands.filter(({ command }) => command === "rm").map(({ args }) => args.at(-1))).toEqual([BUILD]);
  });
});

describe("start", () => {
  test("the first release goes to slot a and receives traffic only once it responds", async () => {
    const host = new FakeHost();
    expect(await call(host, "app.activate", activate)).toEqual({ ok: true, result: { healthy: true, log: "" } });
    expect(host.find("curl")?.args.at(-1)).toBe("http://10.88.0.30:3001/health");
    expect(host.files.get("/etc/eaglepanel/apps/7/slot.nft")?.content).toContain("tcp dport 3000 redirect to :3001");
    expect(host.files.get("/etc/eaglepanel/apps/7/slot")?.content).toBe("a\n");
    const order = host.lines();
    const started = order.indexOf("systemctl start eaglepanel-app-7-a.service");
    const switched = order.findIndex((line) => line.includes("nft -f /etc/eaglepanel/apps/7/slot.nft"));
    expect(started).toBeGreaterThan(-1);
    expect(switched).toBeGreaterThan(started);
  });

  test("the next one goes to the other slot and stops the previous one after the switch", async () => {
    const host = new FakeHost();
    host.files.set("/etc/eaglepanel/apps/7/slot", { content: "a\n" });
    await call(host, "app.activate", { ...activate, release: 4 });
    expect(host.files.get("/etc/systemd/system/eaglepanel-app-7-b.service")?.content).toContain("localhost/eaglepanel/app-7:4");
    expect(host.files.get("/etc/eaglepanel/apps/7/slot")?.content).toBe("b\n");
    const order = host.lines();
    expect(order.indexOf("systemctl stop eaglepanel-app-7-a.service")).toBeGreaterThan(order.findIndex((line) => line.includes("nft -f")));
  });

  test("the unit runs the release image as the account, with its memory and the variables by name only", () => {
    const unit = renderAppUnit({ ...activate, slot: "b", uid: "1001", gid: "1001", envFlags: ["--env=SECRET"] });
    expect(unit).toContain("Type=notify");
    expect(unit).toContain("--sdnotify=conmon");
    expect(unit).toContain("--uidmap=0:1001:1");
    expect(unit).toContain("--env=PORT=3002");
    expect(unit).toContain("--env=SECRET");
    expect(unit).toContain("--volume=/home/acme/data/api.example.com:/data");
    expect(unit).toContain("localhost/eaglepanel/app-7:3 /bin/sh /eaglepanel/start.sh");
    expect(unit).toContain("EnvironmentFile=-/etc/eaglepanel/apps/7/runtime.env");
    expect(unit).toContain("MemoryMax=256M");
    expect(unit).toContain("StartLimitBurst=5");
    // MySQL over the socket: the directory read-only, existing even if MySQL has not started, and ordered after MySQL.
    expect(unit).toContain("--volume=/run/mysqld:/run/mysqld:ro");
    expect(unit).toContain("ExecStartPre=-/usr/bin/install -d -o mysql -g mysql -m 755 /run/mysqld");
    expect(unit.indexOf("ExecStartPre=")).toBeLessThan(unit.indexOf("ExecStart="));
    expect(unit).toMatch(/^After=.* mysql\.service$/m);
    // systemd would expand `$` and `%` in ExecStart: the account command goes in the script.
    expect(unit).not.toContain("bun run start");
  });

  test("the redirect replaces the previous one in a single load", () => {
    expect(renderSlotNft("b").startsWith("add table ip eaglepanel_slot\ndelete table ip eaglepanel_slot\n")).toBe(true);
    expect(renderSlotNft("b")).toContain('iifname "eth0" tcp dport 3000 redirect to :3002');
  });

  test("if it does not respond, the active release stays the same and the app output is reported", async () => {
    const host = new FakeHost();
    host.files.set("/etc/eaglepanel/apps/7/slot", { content: "a\n" });
    const respond = host.respond;
    host.respond = (command, args) => {
      if (command === "curl") return { stdout: "000" };
      if (command === "systemctl" && args[0] === "is-failed") return { code: 0 };
      if (command === "journalctl") return { stdout: "Error: puerto ocupado\n" };
      return respond(command, args);
    };
    expect(await call(host, "app.activate", activate)).toEqual({ ok: true, result: { healthy: false, log: "Error: puerto ocupado\n" } });
    expect(host.files.get("/etc/eaglepanel/apps/7/slot")?.content).toBe("a\n");
    expect(host.files.has("/etc/eaglepanel/apps/7/slot.nft")).toBe(false);
    expect(host.lines().filter((line) => line === "systemctl stop eaglepanel-app-7-b.service").length).toBe(2);
    // Only what came after creation: the app number may have belonged to another account.
    expect(host.find("journalctl")?.args).toEqual(expect.arrayContaining(["--since", "@1793000000"]));
  });

  test("a 404 or a 401 also means a live app; a 502 does not", async () => {
    for (const [code, healthy] of [["404", true], ["401", true]] as const) {
      const host = new FakeHost();
      const respond = host.respond;
      host.respond = (command, args) => (command === "curl" ? { stdout: code } : respond(command, args));
      expect(await call(host, "app.activate", activate)).toMatchObject({ ok: true, result: { healthy } });
    }
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, args) => {
      if (command === "curl") return { stdout: "502" };
      if (command === "systemctl" && args[0] === "is-failed") return { code: 0 };
      return respond(command, args);
    };
    expect(await call(host, "app.activate", activate)).toMatchObject({ ok: true, result: { healthy: false } });
  });

  test("stop or restart acts on the active slot", async () => {
    const host = new FakeHost();
    host.files.set("/etc/eaglepanel/apps/7/slot", { content: "b\n" });
    await call(host, "app.control", { appId: 7, action: "stop" });
    expect(host.find("systemctl")?.args).toEqual(["stop", "eaglepanel-app-7-b.service"]);
  });
});

describe("OLS and cleanup", () => {
  const site = { username: "acme", fqdn: "api.example.com", docRoot: "public_html", phpVersion: "85", phpOptions: DEFAULT_PHP_OPTIONS, certZone: null, originPull: false, logLevel: "ERROR", logDays: 30, suspended: false, hooks: false } as const;

  test("the environment is a proxy to the app, with WebSocket, logs and certificate", () => {
    const conf = renderVhost({ ...site, certZone: "example.com", originPull: true, app: { kind: "server", id: 7 } });
    expect(conf).toContain("address                 10.88.0.30:3000");
    expect(conf).toContain("websocket / {");
    expect(conf).toContain("handler                 app-7");
    // Measured on OLS 1.9.4: without this the app receives X-Forwarded-Proto twice.
    expect(conf).toContain("extraHeaders            RequestHeader unset X-Forwarded-Proto");
    expect(conf).toContain("clientVerify            2");
    expect(conf).toContain("RewriteRule ^ https://");
    expect(conf).not.toContain("lsphp");
    expect(conf).not.toContain("/home/acme");
  });

  test("the proxy docRoot is not in /etc: OLS rejects it and the environment does not load", () => {
    const conf = renderVhost({ ...site, app: { kind: "server", id: 7 } });
    const docRoot = /^docRoot\s+(\S+)/m.exec(conf)?.[1] ?? "";
    expect(docRoot.startsWith("/etc/")).toBe(false);
    expect(docRoot).toBe("/srv/eaglepanel/empty");
  });

  test("static: OLS serves the release, without PHP, with the SPA only for navigations and dot files blocked", () => {
    const root = "/srv/eaglepanel/apps/acme/api.example.com/releases/3";
    const conf = renderVhost({ ...site, certZone: "example.com", app: { kind: "static", id: 7, release: 3, spaFallback: true } }, { staticRoot: root, immutableAssets: true });
    expect(conf).toContain(`docRoot                   ${root}`);
    expect(conf).toContain("RewriteCond %{HTTP_ACCEPT} text/html");
    expect(conf).toContain("RewriteRule ^ /index.html [L]");
    expect(conf).toContain("RewriteRule (^|/)\\.(?!well-known(/|$)) - [F]");
    expect(conf).toContain("context exp:(^|/)\\.(?!well-known(/|$)) {");
    expect(conf).toContain('Cache-Control "public, max-age=31536000, immutable"');
    expect(conf).toContain("RewriteRule ^ https://");
    expect(conf).not.toContain("lsphp");
    expect(conf).not.toContain("extprocessor");
  });

  test("static without SPA or assets/: no fallback and no context that OLS would reject", () => {
    const conf = renderVhost({ ...site, app: { kind: "static", id: 7, release: 3, spaFallback: false } }, { staticRoot: "/r", immutableAssets: false });
    expect(conf).not.toContain("index.html [L]");
    expect(conf).not.toContain("context /assets/");
  });

  test("static without a published release: 503, like an app before deploying", () => {
    const conf = renderVhost({ ...site, app: { kind: "static", id: 7, release: null, spaFallback: true } });
    expect(conf).toContain("R=503");
    expect(conf).toContain("docRoot                   /srv/eaglepanel/empty");
  });

  test("the account webhook domain passes only that path to the API, on any environment type", () => {
    for (const app of [null, { kind: "server", id: 7 }, { kind: "static", id: 7, release: 3, spaFallback: true }] as const) {
      const conf = renderVhost({ ...site, app, hooks: true }, { staticRoot: "/r", immutableAssets: false });
      expect(conf).toContain("context /_eaglepanel/github {");
      expect(conf).toContain("address                 127.0.0.1:8090");
      expect(renderVhost({ ...site, app, hooks: false }, { staticRoot: "/r", immutableAssets: false })).not.toContain("eaglepanel-api");
    }
    expect(renderVhost({ ...site, suspended: true, app: null, hooks: true })).not.toContain("eaglepanel-api");
  });

  test("global webhook domain: only /hooks/github, with its certificate, on both listeners", () => {
    const conf = renderHooksVhost({ certZone: "example.com" });
    expect(conf).toContain("context /hooks/github {");
    expect(conf).toContain("docRoot                   /srv/eaglepanel/empty");
    expect(conf).toContain("RewriteRule ^ https://");
    const block = applyBlock("serverName x\n", [], { fqdn: "hooks.example.com", certZone: "example.com" });
    expect(block).toContain("virtualhost eaglepanel-hooks {");
    expect(block.match(/map {21}eaglepanel-hooks hooks.example.com/g)).toHaveLength(2);
    expect(block).toContain("address                 *:443");
    expect(applyBlock("serverName x\n", [], null)).not.toContain("eaglepanel-hooks");
  });

  test("when suspended, an app also shows the 503", () => {
    for (const app of [{ kind: "server", id: 7 }, { kind: "static", id: 7, release: 3, spaFallback: true }] as const) {
      const conf = renderVhost({ ...site, suspended: true, app }, { staticRoot: "/r", immutableAssets: true });
      expect(conf).toContain("R=503");
      expect(conf).not.toContain("10.88.0.30");
      expect(conf).not.toContain("docRoot                   /r");
    }
  });

  test("delete removes units, containers, images, network, key, repo and releases; data stays in the home directory", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, args) => (args.includes("images") ? { stdout: "localhost/eaglepanel/app-7:3\nlocalhost/eaglepanel/app-7:4\n" } : respond(command, args));
    await call(host, "app.remove", base);
    const removed = host.commands.filter(({ command }) => command === "rm").map(({ args }) => args.at(-1));
    expect(removed).toEqual(expect.arrayContaining(["/srv/eaglepanel/keys/7", "/srv/eaglepanel/repos/7.git", "/srv/eaglepanel/apps/acme/api.example.com", "/etc/eaglepanel/apps/7"]));
    expect(removed.some((path) => path?.startsWith("/home/"))).toBe(false);
    const cache = host.commands.find(({ command, args }) => command === "setpriv" && args.includes("/home/acme/.build/api.example.com"));
    expect(cache?.args.slice(0, 5)).toEqual(["--reuid=acme", "--regid=acme", "--clear-groups", "rm", "-rf"]);
    expect(host.find("systemctl")?.args).toEqual(["disable", "--now", "eaglepanel-app-7-a.service", "eaglepanel-app-7-b.service", "eaglepanel-build-7.service", "eaglepanel-netns-7.service"]);
    const rmi = host.commands.filter(({ args }) => args.includes("rmi")).map(({ args }) => args.at(-1));
    expect(rmi).toEqual(["localhost/eaglepanel/app-7:3", "localhost/eaglepanel/app-7:4"]);
  });

  test("deletes only old releases, directories or images, never the ones kept", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, args) => {
      if (command === "ls") return { stdout: "1\n2\n3\n4\nnotas\n" };
      if (args.includes("images")) return { stdout: "2\n4\nlatest\n" };
      return respond(command, args);
    };
    await call(host, "app.prune", { appId: 7, username: "acme", fqdn: "api.example.com", keep: [3, 4] });
    const removed = host.commands.filter(({ command }) => command === "rm").map(({ args }) => args.at(-1));
    expect(removed).toEqual(["/srv/eaglepanel/apps/acme/api.example.com/releases/1", "/srv/eaglepanel/apps/acme/api.example.com/releases/2"]);
    expect(host.commands.filter(({ args }) => args.includes("rmi")).map(({ args }) => args.at(-1))).toEqual(["localhost/eaglepanel/app-7:2"]);
  });
});
