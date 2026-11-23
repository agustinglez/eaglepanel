import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "./dispatch";
import { SandboxHost } from "./host";
import { cleanLog } from "./panel-upgrade";

const root = mkdtempSync(join(tmpdir(), "eaglepanel-upgrade-"));
const host = new SandboxHost(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("panel upgrade", () => {
  test("the output is shown without colors or progress redraws", () => {
    expect(cleanLog("\x1b[1;32m==> Panel\x1b[0m\n10%\r50%\r100%\n\n")).toEqual(["==> Panel", "100%"]);
  });

  test("before any upgrade there is no result", async () => {
    expect(await dispatch({ op: "panel.upgradeStatus", params: {} }, host)).toEqual({
      ok: true,
      result: { running: false, version: null, startedAt: null, exitCode: null, log: [] },
    });
  });

  test("only a release version is accepted: it goes to the command line", async () => {
    for (const version of ["latest", "1.2", "1.0.0; reboot", "1.0.0+build"]) {
      expect((await dispatch({ op: "panel.upgrade", params: { version } }, host)).ok).toBe(false);
    }
  });

  test("starts and leaves its result readable after the restart", async () => {
    expect(await dispatch({ op: "panel.upgrade", params: { version: "0.3.0" } }, host)).toEqual({ ok: true, result: { ok: true } });
    const status = await dispatch({ op: "panel.upgradeStatus", params: {} }, host);
    expect(status).toMatchObject({ ok: true, result: { running: false, version: "0.3.0", exitCode: 0 } });
  });
});
