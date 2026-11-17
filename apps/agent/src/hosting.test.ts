import { DEFAULT_PHP_OPTIONS } from "@eaglepanel/shared";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "./dispatch";
import type { CommandResult, Host, RunOptions } from "./host";
import { applyBlock, firstConfigError, HTTPD_CONFIG, renderVhost } from "./ols";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "testdata", name), "utf8");

/** In-memory host: simulates real system responses, which the sandbox does not do. */
class FakeHost implements Host {
  readonly sandbox = false;
  readonly commands: { command: string; args: string[]; stdin?: string }[] = [];
  readonly files = new Map<string, { content: string; mode?: number }>();
  responses = new Map<string, Partial<CommandResult>>();

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    this.commands.push({ command, args, stdin: options.stdin });
    const response = this.responses.get(command.split("/").at(-1) ?? command);
    return { code: 0, stdout: "", stderr: "", ...response };
  }

  async writeFileAtomic(path: string, content: string, mode?: number): Promise<void> {
    this.files.set(path, { content, mode });
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path)?.content ?? null;
  }

  ran(command: string): boolean {
    return this.commands.some((entry) => entry.command.endsWith(command));
  }
}

const MANAGED = "acme:x:1001:1001:eaglepanel:/home/acme:/usr/sbin/nologin\n";
const FOREIGN = "ubuntu2:x:1000:1000:Otro:/home/ubuntu2:/bin/bash\n";

async function call(host: Host, op: string, params: unknown) {
  return dispatch({ op, params }, host);
}

describe("accounts", () => {
  test("creates the home directory with the OLS group and applies the quota in KB", async () => {
    const host = new FakeHost();
    expect(await call(host, "account.create", { username: "acme", quotaMb: 100 })).toMatchObject({ ok: true });

    const useradd = host.commands.find((entry) => entry.command === "useradd");
    expect(useradd?.args).toContain("/usr/sbin/nologin");
    expect(useradd?.args).toContain("eaglepanel");

    const homeDir = host.commands.find((entry) => entry.args.at(-1) === "/home/acme");
    expect(homeDir?.args).toEqual(["-d", "-o", "acme", "-g", "nogroup", "-m", "750", "/home/acme"]);

    const quota = host.commands.find((entry) => entry.command === "setquota");
    expect(quota?.args).toEqual(["-u", "acme", "102400", "102400", "0", "0", "/"]);
  });

  test("never adds the account to the nogroup group", async () => {
    const host = new FakeHost();
    await call(host, "account.create", { username: "acme", quotaMb: 100 });
    expect(host.ran("usermod")).toBe(false);
    expect(host.commands.find((entry) => entry.command === "useradd")?.args).not.toContain("nogroup");
  });

  test("does not adopt an existing user not created by the panel", async () => {
    const host = new FakeHost();
    host.responses.set("getent", { stdout: FOREIGN });
    const response = await call(host, "account.create", { username: "acme", quotaMb: 100 });
    expect(response).toMatchObject({ ok: false, error: { code: "op_failed" } });
    expect(host.ran("setquota")).toBe(false);
  });

  test("does not delete a user not created by the panel", async () => {
    const host = new FakeHost();
    host.responses.set("getent", { stdout: FOREIGN });
    const response = await call(host, "account.delete", { username: "acme" });
    expect(response).toMatchObject({ ok: false });
    expect(host.ran("userdel")).toBe(false);
  });

  test("deletes an own account and its services", async () => {
    const host = new FakeHost();
    host.responses.set("getent", { stdout: MANAGED });
    expect(await call(host, "account.delete", { username: "acme" })).toMatchObject({ ok: true });
    expect(host.ran("userdel")).toBe(true);
    expect(host.commands.find((entry) => entry.command === "systemctl")?.args).toContain("eaglepanel-redis@acme");
  });

  test("deleting a missing account does not fail: rollback must be idempotent", async () => {
    const host = new FakeHost();
    host.responses.set("getent", { code: 2 });
    expect(await call(host, "account.delete", { username: "acme" })).toMatchObject({ ok: true });
    expect(host.ran("userdel")).toBe(false);
  });

  test.each(["root", "ubuntu", "../../etc", "a;rm -rf /", "Acme"])("rejects the name %s", async (username) => {
    const host = new FakeHost();
    const response = await call(host, "account.delete", { username });
    expect(response).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(host.commands).toHaveLength(0);
  });

  test("reports when setquota fails", async () => {
    const host = new FakeHost();
    host.responses.set("setquota", { code: 1, stderr: "no quotas" });
    const response = await call(host, "account.create", { username: "acme", quotaMb: 100 });
    expect(response).toMatchObject({ ok: false, error: { message: expect.stringContaining("no quotas") } });
  });
});

describe("server checks", () => {
  function healthy(host: FakeHost) {
    host.responses.set("findmnt", { stdout: "rw,relatime,nosymfollow\n" });
    // Real output from the VPS, including the other quotas.
    host.responses.set("quotaon", {
      stdout: "group quota on / (/dev/sda1) is on\nuser quota on / (/dev/sda1) is on\nproject quota on / (/dev/sda1) is off\n",
    });
    host.responses.set("lswsctrl", { stdout: "litespeed is running with PID 1.\n" });
  }

  test("passes when everything is in order", async () => {
    const host = new FakeHost();
    healthy(host);
    expect(await call(host, "system.preflight", {})).toMatchObject({ ok: true, result: { ok: true } });
  });

  test("fails if only group quotas are enabled", async () => {
    const host = new FakeHost();
    healthy(host);
    host.responses.set("quotaon", {
      stdout: "group quota on / (/dev/sda1) is on\nuser quota on / (/dev/sda1) is off\n",
    });
    expect(await call(host, "system.preflight", {})).toMatchObject({ ok: true, result: { ok: false } });
  });

  test("fails if /home allows following symlinks", async () => {
    const host = new FakeHost();
    healthy(host);
    host.responses.set("findmnt", { stdout: "rw,relatime\n" });
    const response = await call(host, "system.preflight", {});
    expect(response).toMatchObject({ ok: true, result: { ok: false } });
  });
});

describe("PHP versions", () => {
  test("hides lsphp83 even if it is installed", async () => {
    const host = new FakeHost();
    host.responses.set("ls", { stdout: "bin\nconf\nlsphp83\nlsphp85\nlsphpx\n" });
    expect(await call(host, "php.versions", {})).toEqual({ ok: true, result: { versions: ["85"] } });
  });
});

describe("vhosts", () => {
  const site = { username: "acme", fqdn: "example.com", docRoot: "public_html", phpVersion: "85", phpOptions: DEFAULT_PHP_OPTIONS, certZone: null, originPull: false, logLevel: "ERROR", logDays: 30, suspended: false, app: null, hooks: false } as const;

  test("applies the chosen PHP options, and security always wins", () => {
    const conf = renderVhost({
      ...site,
      phpOptions: {
        ...DEFAULT_PHP_OPTIONS,
        children: 9,
        memoryMb: 1024,
        indexFiles: "index.html",
        gzip: false,
        htaccess: false,
        directives: { ...DEFAULT_PHP_OPTIONS.directives, memory_limit: "512M", error_reporting: "E_ERROR" },
        flags: { ...DEFAULT_PHP_OPTIONS.flags, display_errors: true },
      },
    });
    expect(conf).toContain("PHP_LSAPI_CHILDREN=9");
    expect(conf).toContain("maxConns                9");
    expect(conf).toContain("memSoftLimit            1024M");
    expect(conf).toContain("memHardLimit            1536M");
    expect(conf).toContain("indexFiles              index.html");
    expect(conf).toContain("enableGzip                0");
    expect(conf).not.toContain("autoLoadHtaccess");
    expect(conf).toContain('php_value memory_limit "512M"');
    // PHP does not evaluate constants in php_value.
    expect(conf).toContain('php_value error_reporting "1"');
    expect(conf).toContain("php_flag display_errors on");
    expect(conf.indexOf("php_value memory_limit")).toBeLessThan(conf.indexOf("php_admin_value open_basedir"));
  });

  test("rejects options that could open another directive in vhost.conf", async () => {
    const host = new FakeHost();
    host.responses.set("getent", { stdout: MANAGED });
    for (const phpOptions of [
      { ...DEFAULT_PHP_OPTIONS, indexFiles: "index.php\nextprocessor x {" },
      { ...DEFAULT_PHP_OPTIONS, directives: { ...DEFAULT_PHP_OPTIONS.directives, memory_limit: '1G"\n  php_admin_value open_basedir "/' } },
      { ...DEFAULT_PHP_OPTIONS, directives: { ...DEFAULT_PHP_OPTIONS.directives, "date.timezone": 'UTC" evil' } },
      { ...DEFAULT_PHP_OPTIONS, directives: { ...DEFAULT_PHP_OPTIONS.directives, open_basedir: "/" } },
    ]) {
      expect(await call(host, "site.write", { ...site, phpOptions })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    }
    expect(host.files.size).toBe(0);
  });

  test("isolates PHP in the account home directory", () => {
    const conf = renderVhost(site);
    expect(conf).toContain("docRoot                   /home/acme/public_html");
    expect(conf).toContain('php_admin_value open_basedir "/home/acme"');
    expect(conf).toContain("extUser                 acme");
    expect(conf).toContain("extGroup                acme");
    expect(conf).toContain("/usr/local/lsws/lsphp85/bin/lsphp");
    expect(conf).not.toContain("vhssl");
  });

  test("a subdomain has its own directory and process", () => {
    const conf = renderVhost({ ...site, fqdn: "blog.example.com", docRoot: "subdomains/blog.example.com/public_html" });
    expect(conf).toContain("docRoot                   /home/acme/subdomains/blog.example.com/public_html");
    expect(conf).toContain("uds://tmp/lshttpd/blog.example.com.sock");
  });

  test("uses the certificate of its zone", () => {
    const conf = renderVhost({ ...site, fqdn: "blog.example.com", certZone: "example.com" });
    expect(conf).toContain("keyFile                 /usr/local/lsws/conf/eaglepanel-certs/example.com/origin.key");
  });

  test.each(["../../etc", "/etc", "a/../..", "a b", "a\nb", "."])("rejects the directory %j", async (docRoot) => {
    const host = new FakeHost();
    const response = await call(host, "site.write", { ...site, docRoot });
    expect(response).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(host.files.size).toBe(0);
  });

  test("rejects a domain with configuration injection", async () => {
    const host = new FakeHost();
    const response = await call(host, "site.write", { ...site, fqdn: "a.com\nvirtualhost evil" });
    expect(response).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(host.files.size).toBe(0);
  });

  test("does not write a site for a foreign user", async () => {
    const host = new FakeHost();
    host.responses.set("getent", { stdout: FOREIGN });
    expect(await call(host, "site.write", site)).toMatchObject({ ok: false });
    expect(host.files.size).toBe(0);
  });

  test("fails if the PHP version is not installed", async () => {
    const host = new FakeHost();
    host.responses.set("getent", { stdout: MANAGED });
    host.responses.set("test", { code: 1 });
    expect(await call(host, "site.write", site)).toMatchObject({ ok: false });
    expect(host.files.size).toBe(0);
  });
});

describe("OLS configuration", () => {
  const BASE = "serverName glez\n\nlistener Default{\n  address 127.0.0.1:8088\n}\n";
  const http = { fqdn: "example.com", username: "acme", certZone: null, originPull: false };
  const https = { fqdn: "secure.test", username: "bravo", certZone: "secure.test", originPull: false };

  test("adds the block without touching the rest", () => {
    const result = applyBlock(BASE, [http]);
    expect(result).toContain("listener Default{\n  address 127.0.0.1:8088");
    expect(result).toContain("virtualhost example.com {");
    expect(result).toContain("allowSymbolLink         0");
    expect(result).toContain("address                 *:80");
  });

  test("replacing the block is idempotent", () => {
    const once = applyBlock(BASE, [http]);
    expect(applyBlock(once, [http])).toBe(once);
    expect(once.match(/BEGIN EAGLEPANEL/g)).toHaveLength(1);
  });

  test("without sites it does not open public ports", () => {
    const result = applyBlock(applyBlock(BASE, [http]), []);
    expect(result).not.toContain("*:80");
    expect(result).not.toContain("virtualhost");
    expect(result).toContain("listener Default{");
  });

  test("a site without a certificate is not published on 443", () => {
    const result = applyBlock(BASE, [http, https]);
    const httpsListener = result.slice(result.indexOf("listener eaglepanel-https"));
    expect(httpsListener).toContain("map                     secure.test secure.test");
    expect(httpsListener).not.toContain("example.com");
    expect(applyBlock(BASE, [http])).not.toContain("*:443");
  });

  test("warnings do not invalidate the configuration, errors do", () => {
    expect(firstConfigError("2026 [WARN] Uid of Example is 0")).toBeNull();
    expect(firstConfigError("[WARN] x\n2026 [ERROR] missing <vhRoot>\n")).toContain("missing <vhRoot>");
  });

  test("applies and restarts OLS", async () => {
    const host = new FakeHost();
    await host.writeFileAtomic(HTTPD_CONFIG, BASE);
    expect(await call(host, "ols.sync", { sites: [http] })).toEqual({ ok: true, result: { changed: true } });
    expect(host.ran("lswsctrl")).toBe(true);
  });

  test("does not restart when nothing changed", async () => {
    const host = new FakeHost();
    await host.writeFileAtomic(HTTPD_CONFIG, applyBlock(BASE, [http]));
    expect(await call(host, "ols.sync", { sites: [http] })).toEqual({ ok: true, result: { changed: false } });
    expect(host.ran("lswsctrl")).toBe(false);
  });

  test("restarts when asked, even if the block did not change", async () => {
    const host = new FakeHost();
    await host.writeFileAtomic(HTTPD_CONFIG, applyBlock(BASE, [http]));
    expect(await call(host, "ols.sync", { sites: [http], restart: true })).toMatchObject({ ok: true });
    expect(host.ran("lswsctrl")).toBe(true);
  });

  test("if OLS rejects the configuration, it restores the previous one and does not restart", async () => {
    const host = new FakeHost();
    await host.writeFileAtomic(HTTPD_CONFIG, BASE);
    // Returns 2 just like on the VPS: what decides is the [ERROR] line.
    host.responses.set("openlitespeed", { code: 2, stdout: "[ERROR] missing <vhRoot>\n" });

    const response = await call(host, "ols.sync", { sites: [http] });
    expect(response).toMatchObject({ ok: false, error: { message: expect.stringContaining("missing <vhRoot>") } });
    expect(await host.readFile(HTTPD_CONFIG)).toBe(BASE);
    expect(host.ran("lswsctrl")).toBe(false);
  });

  test("exit code 1 from -t with only warnings does not block", async () => {
    const host = new FakeHost();
    await host.writeFileAtomic(HTTPD_CONFIG, BASE);
    host.responses.set("openlitespeed", { code: 1, stdout: "[WARN] Uid of Example\n" });
    expect(await call(host, "ols.sync", { sites: [http] })).toMatchObject({ ok: true });
    expect(host.ran("lswsctrl")).toBe(true);
  });
});

describe("certificados", () => {
  const certPem = fixture("origin.crt");
  const keyPem = fixture("origin.key");

  test("stores a valid pair with restricted permissions", async () => {
    const host = new FakeHost();
    const response = await call(host, "cert.write", { zone: "example.com", certPem, keyPem });
    expect(response).toMatchObject({ ok: true, result: { names: ["example.com", "*.example.com"] } });
    expect(host.files.get("/usr/local/lsws/conf/eaglepanel-certs/example.com/origin.key")?.mode).toBe(0o600);
  });

  test("rejects a key that does not match", async () => {
    const host = new FakeHost();
    const response = await call(host, "cert.write", { zone: "example.com", certPem, keyPem: fixture("other.key") });
    expect(response).toMatchObject({ ok: false, error: { message: expect.stringContaining("does not match") } });
    expect(host.files.size).toBe(0);
  });

  test("rejects a certificate for another domain", async () => {
    const host = new FakeHost();
    const response = await call(host, "cert.write", { zone: "example.com", certPem: fixture("other.crt"), keyPem: fixture("other.key") });
    expect(response).toMatchObject({ ok: false, error: { message: expect.stringContaining("does not cover") } });
  });

  test("an invalid PEM does not leak its content in the error", async () => {
    const host = new FakeHost();
    const keyLike = `-----BEGIN PRIVATE KEY-----\n${"secretosecreto".repeat(10)}\n-----END PRIVATE KEY-----`;
    const response = await call(host, "cert.write", { zone: "example.com", certPem, keyPem: keyLike });
    expect(JSON.stringify(response)).not.toContain("secretosecreto");
    expect(response).toMatchObject({ ok: false });
  });
});
