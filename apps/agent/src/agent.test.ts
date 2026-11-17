import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "./dispatch";
import { SandboxHost } from "./host";

const root = mkdtempSync(join(tmpdir(), "eaglepanel-agent-"));
const host = new SandboxHost(root);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("dispatch", () => {
  test("runs a known operation", async () => {
    expect(await dispatch({ op: "system.ping", params: {} }, host)).toEqual({
      ok: true,
      result: { pong: true, sandbox: true },
    });
  });

  test.each(["shell.exec", "constructor", "__proto__", "toString", "../../etc"])("rejects the operation %s", async (op) => {
    const response = await dispatch({ op, params: {} }, host);
    expect(response).toMatchObject({ ok: false, error: { code: "unknown_op" } });
  });

  test("rejects extra parameters", async () => {
    const response = await dispatch({ op: "system.ping", params: { command: "rm -rf /" } }, host);
    expect(response).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  test.each([undefined, null, "x", 1, [], { op: "system.ping", params: {}, extra: 1 }])("rejects the body %j", async (body) => {
    const response = await dispatch(body, host);
    expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });
});

describe("SandboxHost", () => {
  test("runs no commands and does not log the stdin content", async () => {
    const marker = join(root, "must-not-exist");
    const result = await host.run("touch", [marker], { stdin: "secreto-123" });

    expect(result.code).toBe(0);
    expect(existsSync(marker)).toBe(false);

    const log = readFileSync(join(root, "commands.log"), "utf8");
    expect(log).toContain("touch");
    expect(log).not.toContain("secreto-123");
  });

  test("writes absolute paths inside the sandbox", async () => {
    await host.writeFileAtomic("/etc/vsftpd/ejemplo", "contenido");
    expect(readFileSync(join(root, "etc", "vsftpd", "ejemplo"), "utf8")).toBe("contenido");
  });

  test("does not let .. escape the sandbox", () => {
    expect(() => host.resolvePath("/../../etc/passwd")).toThrow("outside the sandbox");
  });

  test("rejects relative paths", () => {
    expect(() => host.resolvePath("etc/passwd")).toThrow();
  });
});
