import { DEFAULT_PHP_OPTIONS, ORIGIN_PULL_CA_EXPIRES_AT } from "@eaglepanel/shared";
import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { CLOUDFLARE_ORIGIN_PULL_CA } from "./cloudflare-ca";
import { dispatch } from "./dispatch";
import type { CommandResult, Host, RunOptions } from "./host";
import { stopOlsFully } from "./hosting";
import { applyBlock, CERTS_DIR, HTTPD_CONFIG, logrotatePath, ORIGIN_PULL_CA_PATH, PHP_SYSTEM_INI, PHP_SYSTEM_INI_DIR, removedListeners, renderLogrotate, renderVhost, SUSPENDED_DOC_ROOT } from "./ols";
import { ftpUserFile } from "./services";

const PASSWORD = "AbCdEfGh_ijklmnop-1234";
const MANAGED = "acme:x:1001:1001:eaglepanel:/home/acme:/usr/sbin/nologin\n";
const FOREIGN = "acme:x:1000:1000:Otro:/home/acme:/bin/bash\n";

class FakeHost implements Host {
  readonly sandbox = false;
  readonly commands: { command: string; args: string[]; stdin?: string }[] = [];
  readonly files = new Map<string, string>();
  /** Response per command, or based on the SQL received in the case of mysql. */
  respond: (command: string, stdin?: string) => Partial<CommandResult> = (command) => {
    if (command === "getent") return { stdout: MANAGED };
    if (command === "openssl") return { stdout: "$6$salt$hash\n" };
    return {};
  };

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    this.commands.push({ command, args, stdin: options.stdin });
    return { code: 0, stdout: "", stderr: "", ...this.respond(command, options.stdin) };
  }

  async writeFileAtomic(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  sql(): string {
    return this.commands.filter(({ command }) => command === "mysql").map(({ stdin }) => stdin).join("\n");
  }
}

const call = (host: Host, op: string, params: unknown) => dispatch({ op, params }, host);

describe("FTP", () => {
  test("stores only the hash, the password goes through stdin and the root is the home directory", async () => {
    const host = new FakeHost();
    expect(await call(host, "ftp.setPassword", { username: "acme", password: PASSWORD })).toMatchObject({ ok: true });

    const openssl = host.commands.find(({ command }) => command === "openssl");
    expect(openssl?.args).toEqual(["passwd", "-6", "-stdin"]);
    expect(openssl?.stdin).toBe(PASSWORD);
    expect(host.commands.some(({ args }) => args.includes(PASSWORD))).toBe(false);

    expect(host.files.get("/etc/eaglepanel/ftp/users.txt")).toBe("acme\n$6$salt$hash\n");
    expect(host.files.get(ftpUserFile("acme"))).toBe("guest_username=acme\nlocal_root=/home/acme\n");
    const load = host.commands.find(({ command }) => command === "db_load");
    expect(load?.args.at(-1)).toBe("/etc/eaglepanel/ftp/users.db.new");
    expect(host.commands.find(({ command }) => command === "mv")?.args).toEqual(["-f", "/etc/eaglepanel/ftp/users.db.new", "/etc/eaglepanel/ftp/users.db"]);
  });

  test("changing a password keeps the other accounts", async () => {
    const host = new FakeHost();
    host.files.set("/etc/eaglepanel/ftp/users.txt", "otra\n$6$otra\nacme\n$6$vieja\n");
    await call(host, "ftp.setPassword", { username: "acme", password: PASSWORD });
    expect(host.files.get("/etc/eaglepanel/ftp/users.txt")).toBe("otra\n$6$otra\nacme\n$6$salt$hash\n");
  });

  test("fails if it cannot get the hash, and does not touch the database", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, stdin) => (command === "openssl" ? { stdout: "" } : respond(command, stdin));
    expect(await call(host, "ftp.setPassword", { username: "acme", password: PASSWORD })).toMatchObject({ ok: false });
    expect(host.commands.some(({ command }) => command === "db_load")).toBe(false);
  });

  test("does not touch users not created by the panel", async () => {
    const host = new FakeHost();
    host.respond = () => ({ stdout: FOREIGN });
    expect(await call(host, "ftp.setPassword", { username: "acme", password: PASSWORD })).toMatchObject({ ok: false });
    expect(host.files.size).toBe(0);
  });

  test("on a migration, stores the hash from the backup and rejects anything else", async () => {
    const hash = `$6$abcdefgh$${"A".repeat(86)}`;
    const host = new FakeHost();
    expect(await call(host, "migrate.ftpHash", { username: "acme", hash })).toMatchObject({ ok: true });
    expect(host.files.get("/etc/eaglepanel/ftp/users.txt")).toBe(`acme\n${hash}\n`);
    expect(host.commands.some(({ command }) => command === "openssl")).toBe(false);
    for (const bad of ["$1$viejo$hash", `${hash}\nroot`, "texto plano"]) {
      expect(await call(new FakeHost(), "migrate.ftpHash", { username: "acme", hash: bad })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    }
  });

  test("rejects a password outside the generated alphabet", async () => {
    const host = new FakeHost();
    expect(await call(host, "ftp.setPassword", { username: "acme", password: "corta'; DROP--aaaaaaaa" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(host.commands).toEqual([]);
  });

  test("deleting the account removes its FTP access and its services", async () => {
    const host = new FakeHost();
    host.files.set("/etc/eaglepanel/ftp/users.txt", "otra\n$6$otra\nacme\n$6$acme\n");
    expect(await call(host, "account.delete", { username: "acme" })).toMatchObject({ ok: true });
    expect(host.files.get("/etc/eaglepanel/ftp/users.txt")).toBe("otra\n$6$otra\n");
    const systemctl = host.commands.filter(({ command }) => command === "systemctl").map(({ args }) => args.join(" "));
    expect(systemctl).toContain("disable --now eaglepanel-redis@acme");
    expect(systemctl).toContain("disable --now eaglepanel-memcached@acme");
    expect(host.commands.some(({ command, args }) => command === "rm" && args.includes(ftpUserFile("acme")))).toBe(true);
  });

  test("deleting the last account removes the database instead of leaving an empty one", async () => {
    const host = new FakeHost();
    host.files.set("/etc/eaglepanel/ftp/users.txt", "acme\n$6$acme\n");
    await call(host, "account.delete", { username: "acme" });
    expect(host.commands.some(({ command }) => command === "db_load")).toBe(false);
    expect(host.commands.some(({ command, args }) => command === "rm" && args.includes("/etc/eaglepanel/ftp/users.db"))).toBe(true);
  });
});

describe("MySQL", () => {
  test("creates database and user, with the _ escaped in the GRANT and without GRANT OPTION", async () => {
    const host = new FakeHost();
    expect(await call(host, "db.create", { username: "acme", name: "tienda", password: PASSWORD })).toMatchObject({ ok: true });
    const sql = host.sql();
    expect(sql).toContain("CREATE DATABASE IF NOT EXISTS `acme_tienda`");
    expect(sql).toContain("WITH MAX_USER_CONNECTIONS 20");
    expect(sql).toContain("GRANT ALL ON `acme\\_tienda`.* TO 'acme_tienda'@'localhost';");
    expect(sql).not.toContain("GRANT OPTION");
    // stdin only: in the arguments it would be visible in `ps`.
    expect(host.commands.some(({ args }) => args.join(" ").includes(PASSWORD))).toBe(false);
  });

  test("a MySQL error does not leak the SQL with the password", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, stdin) => (command === "mysql" ? { code: 1, stderr: `ERROR near '${PASSWORD}'` } : respond(command, stdin));
    const response = await call(host, "db.create", { username: "acme", name: "tienda", password: PASSWORD });
    expect(response).toMatchObject({ ok: false });
    expect(JSON.stringify(response)).not.toContain(PASSWORD);
  });

  test.each([["../etc"], ["a;b"], ["a`b"], ["a'b"], ["A"], ["1a"], ["a_b"], ["abcdefghijklmnop"]])("rejects the name %s without running anything", async (name) => {
    const host = new FakeHost();
    expect(await call(host, "db.create", { username: "acme", name, password: PASSWORD })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(host.commands).toEqual([]);
  });

  test("blocking leaves only read and delete, and closes open connections", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, stdin) => (stdin?.includes("PROCESSLIST") ? { stdout: "12\n34\n" } : respond(command, stdin));
    expect(await call(host, "db.setWritable", { databases: ["acme_tienda"], writable: false })).toMatchObject({ ok: true });
    const sql = host.sql();
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON `acme\\_tienda`.* FROM 'acme_tienda'@'localhost';");
    expect(sql).toContain("GRANT SELECT, DELETE, DROP, SHOW VIEW, LOCK TABLES ON `acme\\_tienda`.*");
    expect(sql).toContain("KILL 12;");
    expect(sql).toContain("KILL 34;");
  });

  test("releasing restores the privileges and disconnects nobody", async () => {
    const host = new FakeHost();
    await call(host, "db.setWritable", { databases: ["acme_tienda"], writable: true });
    const sql = host.sql();
    expect(sql).toContain("GRANT ALL ON `acme\\_tienda`.*");
    expect(sql).not.toContain("KILL");
  });

  test("optimizes as root and a table name cannot close the identifier", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, stdin) => (stdin?.includes("information_schema.TABLES") ? { stdout: "pedidos\nmal`; DROP DATABASE x; --\n" } : respond(command, stdin));
    await call(host, "db.optimize", { username: "acme", name: "tienda" });
    expect(host.sql()).toContain("OPTIMIZE TABLE `acme_tienda`.`pedidos`, `acme_tienda`.`mal``; DROP DATABASE x; --`;");
  });

  test("deleting a database removes the user and closes its connections before deleting the data", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, stdin) => (stdin?.includes("PROCESSLIST") ? { stdout: "7\n" } : respond(command, stdin));
    await call(host, "db.delete", { username: "acme", name: "tienda" });
    const sql = host.sql();
    expect(sql.indexOf("DROP USER IF EXISTS 'acme_tienda'")).toBeLessThan(sql.indexOf("KILL 7"));
    expect(sql.indexOf("KILL 7")).toBeLessThan(sql.indexOf("DROP DATABASE IF EXISTS `acme_tienda`"));
  });

  test("measures database size and free disk space", async () => {
    const host = new FakeHost();
    host.respond = (command) => {
      if (command === "mysql") return { stdout: "acme_tienda\t1048576\nsys\t16384\n" };
      if (command === "df") return { stdout: "     Avail\n5368709120\n" };
      return {};
    };
    expect(await call(host, "db.usage", {})).toEqual({
      ok: true,
      result: { databases: [{ name: "acme_tienda", bytes: 1048576 }, { name: "sys", bytes: 16384 }], diskFreeBytes: 5368709120 },
    });
  });

  test("if it cannot measure the disk it returns null, not zero", async () => {
    const host = new FakeHost();
    host.respond = (command) => (command === "df" ? { code: 1, stdout: "" } : {});
    expect(await call(host, "db.usage", {})).toMatchObject({ ok: true, result: { diskFreeBytes: null } });
  });
});

describe("Cloudflare client certificate", () => {
  const site = { username: "acme", fqdn: "example.com", docRoot: "public_html", phpVersion: "85", phpOptions: DEFAULT_PHP_OPTIONS, certZone: "example.com", originPull: true, logLevel: "ERROR" as const, logDays: 30, suspended: false, app: null, hooks: false };
  const secure = { fqdn: "example.com", username: "acme", certZone: "example.com", originPull: true };
  const open = { fqdn: "otra.com", username: "otra", certZone: "otra.com", originPull: false };

  test("the date shown by the panel is the one of the CA bundled with the agent", () => {
    const ca = new X509Certificate(CLOUDFLARE_ORIGIN_PULL_CA);
    expect(new Date(ca.validTo).getTime()).toBe(ORIGIN_PULL_CA_EXPIRES_AT);
    expect(ca.subject).toContain("origin-pull.cloudflare.net");
  });

  test("the vhost requires the certificate inside vhssl, and redirects port 80", () => {
    const conf = renderVhost(site);
    const ssl = conf.slice(conf.indexOf("vhssl"));
    expect(ssl).toContain("clientVerify            2");
    expect(ssl).toContain("verifyDepth             2");
    expect(ssl).toContain(`CACertFile              ${ORIGIN_PULL_CA_PATH}`);
    expect(conf).toContain("RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]");
    expect(conf).toContain("autoLoadHtaccess        1");
  });

  test("without .htaccess port 80 is also redirected", () => {
    const conf = renderVhost({ ...site, phpOptions: { ...DEFAULT_PHP_OPTIONS, htaccess: false } });
    expect(conf).toContain("RewriteRule ^ https://");
    expect(conf).not.toContain("autoLoadHtaccess");
  });

  test("with a certificate and without the requirement, it redirects port 80 but does not ask for a client certificate", () => {
    const conf = renderVhost({ ...site, originPull: false });
    expect(conf).toContain("RewriteRule ^ https://");
    expect(conf).not.toContain("clientVerify");
  });

  test("without a certificate it does not redirect: over HTTPS that environment does not exist", () => {
    const conf = renderVhost({ ...site, certZone: null, originPull: false });
    expect(conf).not.toContain("RewriteRule");
    expect(conf).not.toContain("vhssl");
  });

  test("the listener requires it if any domain requires it", () => {
    const listener = (block: string) => block.slice(block.indexOf("listener eaglepanel-https"));
    expect(listener(applyBlock("", [secure, open]))).toContain("clientVerify            2");
    expect(listener(applyBlock("", [open]))).not.toContain("clientVerify");
  });

  test("writes the CA before validating, readable by root only", async () => {
    const host = new FakeHost();
    const order: string[] = [];
    const respond = host.respond;
    host.respond = (command, stdin) => {
      if (command.endsWith("openlitespeed")) order.push(host.files.has(ORIGIN_PULL_CA_PATH) ? "with CA" : "without CA");
      return respond(command, stdin);
    };
    expect(await call(host, "ols.sync", { sites: [secure] })).toMatchObject({ ok: true });
    expect(host.files.get(ORIGIN_PULL_CA_PATH)).toBe(CLOUDFLARE_ORIGIN_PULL_CA);
    expect(order).toEqual(["with CA"]);
    expect(host.commands.find(({ args }) => args.includes(CERTS_DIR))?.args).toEqual(["-d", "-o", "root", "-g", "root", "-m", "700", CERTS_DIR]);
  });

  test("if no domain requires it, the CA is not written", async () => {
    const host = new FakeHost();
    await call(host, "ols.sync", { sites: [open] });
    expect(host.files.has(ORIGIN_PULL_CA_PATH)).toBe(false);
  });

  test("omitting the requirement is invalid: the field is mandatory", async () => {
    const host = new FakeHost();
    const { originPull: _omitted, ...withoutField } = secure;
    expect(await call(host, "ols.sync", { sites: [withoutField] })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });
});

describe("closing listeners when removing sites", () => {
  const plain = { fqdn: "example.com", username: "acme", certZone: null, originPull: false };
  const secure = { fqdn: "secure.test", username: "bravo", certZone: "secure.test", originPull: false };
  const seed = (sites: (typeof plain | typeof secure)[]) => {
    const host = new FakeHost();
    host.files.set(HTTPD_CONFIG, applyBlock("serverName test\n", sites));
    return host;
  };
  const ran = (host: FakeHost) => host.commands.map(({ command, args }) => [command.split("/").at(-1), ...args].join(" "));

  test("with no listeners removed, it uses the usual restart", async () => {
    const host = seed([plain]);
    expect(await call(host, "ols.sync", { sites: [plain, secure] })).toMatchObject({ ok: true });
    expect(ran(host)).toContain("lswsctrl restart");
    expect(ran(host)).not.toContain("systemctl stop lshttpd");
  });

  test("adding and removing sites without touching the ports disconnects nobody", async () => {
    const other = { ...secure, fqdn: "other.test", certZone: "other.test" };
    const host = seed([plain, secure, other]);
    await call(host, "ols.sync", { sites: [plain, secure] });
    expect(ran(host)).toContain("lswsctrl restart");
    expect(ran(host)).not.toContain("systemctl stop lshttpd");
  });

  test("removing the last site with a certificate stops, waits and starts, in that order", async () => {
    const host = seed([plain, secure]);
    expect(await call(host, "ols.sync", { sites: [plain] })).toMatchObject({ ok: true });
    const commands = ran(host);
    expect(commands).not.toContain("lswsctrl restart");
    const stop = commands.indexOf("systemctl stop lshttpd");
    const wait = commands.indexOf("pgrep -x litespeed");
    const start = commands.indexOf("systemctl start lshttpd");
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(wait).toBeGreaterThan(stop);
    expect(start).toBeGreaterThan(wait);
  });

  test("removing the last site does the same", async () => {
    const host = seed([plain]);
    expect(await call(host, "ols.sync", { sites: [] })).toMatchObject({ ok: true });
    expect(ran(host)).toContain("systemctl stop lshttpd");
    expect(host.files.get(HTTPD_CONFIG)).not.toContain("*:80");
  });

  test("does not start until the old process has exited", async () => {
    const host = new FakeHost();
    let checks = 0;
    const respond = host.respond;
    host.respond = (command, stdin) => {
      if (command !== "pgrep") return respond(command, stdin);
      checks += 1;
      return checks < 3 ? { stdout: "1234\n" } : { code: 1, stdout: "" };
    };
    await stopOlsFully(host, { attempts: 5, delayMs: 1 });
    expect(checks).toBe(3);
    expect(ran(host)).not.toContain("systemctl start lshttpd");
  });

  test("if the process does not exit, another one is not started on top of it", async () => {
    const host = new FakeHost();
    host.respond = (command) => (command === "pgrep" ? { stdout: "1234\n" } : {});
    await expect(stopOlsFully(host, { attempts: 3, delayMs: 1 })).rejects.toThrow("did not stop");
    expect(ran(host)).not.toContain("systemctl start lshttpd");
  });

  test("if the port is still open after exiting, it fails and restores the configuration", async () => {
    const host = seed([plain, secure]);
    const before = host.files.get(HTTPD_CONFIG);
    const respond = host.respond;
    host.respond = (command, stdin) => (command === "ss" ? { stdout: "LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:8088 0.0.0.0:*\n" } : respond(command, stdin));
    const response = await call(host, "ols.sync", { sites: [plain] });
    expect(response).toMatchObject({ ok: false, error: { message: expect.stringContaining("*:443") } });
    expect(host.files.get(HTTPD_CONFIG)).toBe(before);
  });

  test("an open port 80 is not mistaken for 443 or a similar port", async () => {
    const host = seed([plain, secure]);
    const respond = host.respond;
    host.respond = (command, stdin) => (command === "ss" ? { stdout: "LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:8443 0.0.0.0:*\n" } : respond(command, stdin));
    expect(await call(host, "ols.sync", { sites: [plain] })).toMatchObject({ ok: true });
  });

  test("if the start fails, it restores the configuration and retries with it", async () => {
    const host = seed([plain, secure]);
    const before = host.files.get(HTTPD_CONFIG);
    let starts = 0;
    const respond = host.respond;
    host.respond = (command, stdin) => {
      if (command === "systemctl" && host.commands.at(-1)?.args[0] === "start") {
        starts += 1;
        return starts === 1 ? { code: 1, stderr: "fallo" } : {};
      }
      return respond(command, stdin);
    };
    expect(await call(host, "ols.sync", { sites: [plain] })).toMatchObject({ ok: false });
    expect(host.files.get(HTTPD_CONFIG)).toBe(before);
    expect(starts).toBe(2);
  });

  test("a configuration rejected by OLS stops nothing", async () => {
    const host = seed([plain, secure]);
    const respond = host.respond;
    host.respond = (command, stdin) => (command.endsWith("openlitespeed") ? { code: 2, stdout: "[ERROR] mal" } : respond(command, stdin));
    expect(await call(host, "ols.sync", { sites: [plain] })).toMatchObject({ ok: false });
    expect(ran(host)).not.toContain("systemctl stop lshttpd");
  });

  test("looks only at the panel block, not at other listeners in the file", () => {
    const outside = "listener other {\n  address                 *:443\n}\n";
    expect(removedListeners(applyBlock(outside, [plain]), applyBlock(outside, [plain]))).toEqual([]);
    expect(removedListeners(applyBlock(outside, [secure]), applyBlock(outside, [plain]))).toEqual(["*:443"]);
  });
});

describe(".user.ini per environment", () => {
  const site = { username: "acme", fqdn: "example.com", docRoot: "public_html", phpVersion: "85", phpOptions: DEFAULT_PHP_OPTIONS, certZone: null, originPull: false, logLevel: "ERROR" as const, logDays: 30, suspended: false, app: null, hooks: false };

  test("enables .user.ini", () => {
    const conf = renderVhost(site);
    expect(conf).toContain("env                     LSPHP_ENABLE_USER_INI=on");
    expect(conf).toContain('php_admin_value user_ini.cache_ttl "5"');
  });

  test("blocks every dot file or directory, except .well-known", () => {
    const match = /^context exp:(.+) \{\n  allowBrowse             0\n\}$/m.exec(renderVhost(site));
    expect(match).not.toBeNull();
    const rule = new RegExp(match![1]!);
    for (const path of ["/.env", "/.env.backup", "/.user.ini", "/.htaccess", "/.git/config", "/sub/.env", "/sub/.oculta/x.txt", "/.oculto.php", "/.well-known/.env", "/.well-knownx"]) {
      expect(rule.test(path)).toBe(true);
    }
    for (const path of ["/", "/index.php", "/a.b.c.txt", "/sub/normal.txt", "/.well-known/security.txt", "/.well-known/acme-challenge/token", "/sub/.well-known/x"]) {
      expect(rule.test(path)).toBe(false);
    }
  });

  test("SCAN_DIR points only to the root directory: pointing to the account, a .user.ini enabled exec()", () => {
    for (const docRoot of ["public_html", "subdomains/test.example.com/public_html"]) {
      const scan = renderVhost({ ...site, docRoot }).split("\n").filter((line) => line.includes("PHP_INI_SCAN_DIR"));
      expect(scan).toEqual([`  env                     PHP_INI_SCAN_DIR=:${PHP_SYSTEM_INI_DIR}`]);
    }
    expect(PHP_SYSTEM_INI_DIR.startsWith("/home")).toBe(false);
  });

  test("disable_functions goes in the root .ini: in phpIniOverride it has no effect", async () => {
    expect(renderVhost(site)).not.toContain("disable_functions");
    const host = new FakeHost();
    await call(host, "site.write", site);
    expect(host.files.get(PHP_SYSTEM_INI)).toContain("disable_functions=exec,passthru,shell_exec,system,proc_open,popen,pcntl_exec");
    const dir = host.commands.find(({ args }) => args.includes(PHP_SYSTEM_INI_DIR));
    expect(dir?.args).toEqual(["-d", "-o", "root", "-g", "root", "-m", "755", PHP_SYSTEM_INI_DIR]);
    expect(host.commands.find(({ args }) => args.includes(SUSPENDED_DOC_ROOT))?.args).toEqual(["-d", "-o", "root", "-g", "root", "-m", "755", "/srv/eaglepanel/empty"]);
  });

  test("each environment has its own, created as the account and without overwriting the content", async () => {
    const host = new FakeHost();
    await call(host, "site.write", { ...site, fqdn: "test.example.com", docRoot: "subdomains/test.example.com/public_html" });
    expect(host.commands.find(({ command }) => command === "setpriv")?.args).toEqual([
      "--reuid=acme", "--regid=acme", "--clear-groups", "touch", "-a", "--", "/home/acme/subdomains/test.example.com/public_html/.user.ini",
    ]);
    expect(host.files.has("/home/acme/subdomains/test.example.com/public_html/.user.ini")).toBe(false);
  });

  test("restarts only that account PHP", async () => {
    const host = new FakeHost();
    expect(await call(host, "php.restart", { username: "acme" })).toEqual({ ok: true, result: { ok: true } });
    expect(host.commands.find(({ command }) => command === "pkill")?.args).toEqual(["-u", "acme", "-x", "lsphp"]);
  });

  test("no processes is not a failure, but a real error is", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, stdin) => (command === "pkill" ? { code: 1 } : respond(command, stdin));
    expect(await call(host, "php.restart", { username: "acme" })).toMatchObject({ ok: true });
    host.respond = (command, stdin) => (command === "pkill" ? { code: 3, stderr: "fatal" } : respond(command, stdin));
    expect(await call(host, "php.restart", { username: "acme" })).toMatchObject({ ok: false });
  });

  test("does not restart processes of a user not created by the panel", async () => {
    const host = new FakeHost();
    host.respond = () => ({ stdout: FOREIGN });
    expect(await call(host, "php.restart", { username: "acme" })).toMatchObject({ ok: false });
    expect(host.commands.some(({ command }) => command === "pkill")).toBe(false);
  });
});

describe("suspended account", () => {
  const site = { username: "acme", fqdn: "example.com", docRoot: "public_html", phpVersion: "85", phpOptions: DEFAULT_PHP_OPTIONS, certZone: "example.com", originPull: true, logLevel: "ERROR" as const, logDays: 30, suspended: true, app: null, hooks: false };
  const USERS = "/etc/eaglepanel/ftp/users.txt";
  const SUSPENDED = "/etc/eaglepanel/ftp/suspended.txt";
  const ACTIVE = "/etc/eaglepanel/ftp/users.active.txt";
  /** What db_load would receive: the file is deleted afterwards, so it is captured when it runs. */
  const capturingLogin = () => {
    const host = new FakeHost();
    const loaded: (string | null)[] = [];
    const respond = host.respond;
    host.respond = (command, stdin) => {
      if (command === "db_load") loaded.push(host.files.get(ACTIVE) ?? null);
      return respond(command, stdin);
    };
    return { host, loaded };
  };

  test("the vhost answers 503 from an empty root directory, without PHP or anything from the account", () => {
    const conf = renderVhost(site);
    expect(conf).toContain(`docRoot                   ${SUSPENDED_DOC_ROOT}`);
    expect(conf).toContain("RewriteRule ^ - [R=503,L]");
    expect(conf).not.toContain("/home/acme");
    expect(conf).not.toContain("extprocessor");
    expect(conf).not.toContain("scripthandler");
    expect(conf).not.toContain("autoLoadHtaccess");
  });

  test("keeps the certificate and the Cloudflare requirement: without them the 503 would not arrive", () => {
    const conf = renderVhost(site);
    expect(conf).toContain("vhssl  {");
    expect(conf).toContain("clientVerify            2");
    expect(conf).toContain("accesslog /var/log/eaglepanel/vhosts/example.com/access.log");
  });

  test("site.write deletes nothing from the account", async () => {
    const host = new FakeHost();
    await call(host, "site.write", site);
    expect(host.commands.some(({ command }) => command === "rm")).toBe(false);
    expect(host.commands.some(({ command, args }) => command === "install" && args.includes(SUSPENDED_DOC_ROOT))).toBe(true);
  });

  test("FTP: leaves the login database, keeps its hash and closes open sessions", async () => {
    const { host, loaded } = capturingLogin();
    host.files.set(USERS, "otra\n$6$otra\nacme\n$6$acme\n");
    expect(await call(host, "ftp.setSuspended", { username: "acme", suspended: true })).toMatchObject({ ok: true });
    expect(loaded).toEqual(["otra\n$6$otra\n"]);
    expect(host.files.get(USERS)).toBe("otra\n$6$otra\nacme\n$6$acme\n");
    expect(host.commands.find(({ command }) => command === "pkill")?.args).toEqual(["-KILL", "-u", "acme", "-x", "vsftpd"]);
  });

  test("FTP: reactivating restores the same password and disconnects nobody", async () => {
    const { host, loaded } = capturingLogin();
    host.files.set(USERS, "acme\n$6$acme\n");
    host.files.set(SUSPENDED, "acme\n");
    await call(host, "ftp.setSuspended", { username: "acme", suspended: false });
    expect(loaded).toEqual(["acme\n$6$acme\n"]);
    expect(host.commands.some(({ command }) => command === "pkill")).toBe(false);
  });

  test("FTP: regenerating the password while suspended does not enable it again", async () => {
    const { host, loaded } = capturingLogin();
    host.files.set(USERS, "otra\n$6$otra\nacme\n$6$vieja\n");
    host.files.set(SUSPENDED, "acme\n");
    await call(host, "ftp.setPassword", { username: "acme", password: PASSWORD });
    expect(loaded).toEqual(["otra\n$6$otra\n"]);
    expect(host.files.get(USERS)).toContain("acme\n$6$salt$hash");
  });

  test("FTP: if it was the only account, no login database is left", async () => {
    const host = new FakeHost();
    host.files.set(USERS, "acme\n$6$acme\n");
    await call(host, "ftp.setSuspended", { username: "acme", suspended: true });
    expect(host.commands.some(({ command }) => command === "db_load")).toBe(false);
    expect(host.commands.some(({ command, args }) => command === "rm" && args.includes("/etc/eaglepanel/ftp/users.db"))).toBe(true);
  });

  test("FTP: deleting the account also removes it from the suspended ones", async () => {
    const host = new FakeHost();
    host.files.set(USERS, "acme\n$6$acme\n");
    host.files.set(SUSPENDED, "acme\notra\n");
    await call(host, "account.delete", { username: "acme" });
    expect(host.files.get(SUSPENDED)).toBe("otra\n");
  });

  test("MySQL: blocks and closes open connections, without touching privileges", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, stdin) => (stdin?.includes("PROCESSLIST") ? { stdout: "9\n" } : respond(command, stdin));
    expect(await call(host, "db.setLocked", { databases: ["acme_tienda"], locked: true })).toMatchObject({ ok: true });
    const sql = host.sql();
    expect(sql).toContain("ALTER USER 'acme_tienda'@'localhost' ACCOUNT LOCK;");
    expect(sql).toContain("KILL 9;");
    expect(sql).not.toContain("REVOKE");
  });

  test("MySQL: unblocks without disconnecting anyone, and does nothing without databases", async () => {
    const host = new FakeHost();
    await call(host, "db.setLocked", { databases: ["acme_tienda"], locked: false });
    expect(host.sql()).toContain("ACCOUNT UNLOCK");
    expect(host.sql()).not.toContain("KILL");
    const empty = new FakeHost();
    await call(empty, "db.setLocked", { databases: [], locked: true });
    expect(empty.commands).toEqual([]);
  });

  test("MySQL: rejects names that are not panel databases", async () => {
    const host = new FakeHost();
    expect(await call(host, "db.setLocked", { databases: ["root"], locked: true })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await call(host, "db.setLocked", { databases: ["a'; DROP--_x"], locked: true })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(host.commands).toEqual([]);
  });
});

describe("environment logs", () => {
  const site = { username: "acme", fqdn: "example.com", docRoot: "public_html", phpVersion: "85", phpOptions: DEFAULT_PHP_OPTIONS, certZone: null, originPull: false, logLevel: "WARN" as const, logDays: 14, suspended: false, app: null, hooks: false };
  const read = (host: FakeHost, source: string, lines = 50) => call(host, "logs.read", { username: "acme", fqdn: "example.com", source, lines });

  test("the vhost writes outside the home directory, without OLS rotation", () => {
    const conf = renderVhost(site);
    expect(conf).toContain("errorlog /var/log/eaglepanel/vhosts/example.com/error.log {");
    expect(conf).toContain("accesslog /var/log/eaglepanel/vhosts/example.com/access.log {");
    expect(conf).toContain("logLevel                WARN");
    expect(conf.match(/rollingSize             0/g)).toHaveLength(2);
  });

  test("OLS logs rotate daily and keep the chosen number of days", () => {
    const ols = renderLogrotate(site).split("/home/")[0]!;
    expect(ols).toContain("/var/log/eaglepanel/vhosts/example.com/*.log {");
    expect(ols).toContain("rotate 14");
    expect(ols).toContain("maxage 14");
    expect(ols).toContain("copytruncate");
  });

  test("the PHP error_log is packed at 20 MB or every month, and nothing deletes it", () => {
    const conf = renderLogrotate(site);
    const php = conf.slice(conf.indexOf("/home/acme/logs/example.com.php_error.log {"));
    expect(php).toContain("su acme acme");
    expect(php).toContain("monthly");
    expect(php).toContain("maxsize 20M");
    expect(php).toContain("rotate -1");
    expect(php).not.toContain("maxage");
    expect(php).toContain("tar -czf");
  });

  test("packing runs as the account: postrotate would run as root", () => {
    const conf = renderLogrotate(site);
    const script = conf.slice(conf.indexOf("postrotate"), conf.indexOf("endscript"));
    expect(script.trim().split(/\r?\n/)[1]?.trim()).toStartWith("/usr/bin/setpriv --reuid=acme --regid=acme --clear-groups /bin/sh -c ");
    // What the account plants is not followed, and what is already packed is not packed again.
    expect(script).toContain('[ ! -L "$f" ]');
    expect(script).toContain("*.tar.gz) continue");
    // Only its own file: it does not reach those of another environment of the same account.
    expect(script).toContain("for f in example.com.php_error.log-*;");
  });

  test("the account can change the PHP error_log", () => {
    const conf = renderVhost(site);
    expect(conf).toContain('php_value error_log "/home/acme/logs/example.com.php_error.log"');
    expect(conf).not.toContain("php_admin_value error_log");
    expect(conf).toContain("php_admin_value open_basedir");
  });

  test("site.write prepares the directories with their owners and the rotation configuration", async () => {
    const host = new FakeHost();
    expect(await call(host, "site.write", site)).toMatchObject({ ok: true });
    const args = host.commands.filter(({ command }) => command === "install").map((entry) => entry.args.join(" "));
    expect(args).toContain("-d -o acme -g acme -m 750 /home/acme/logs");
    expect(args).toContain("-d -o root -g nogroup -m 750 /var/log/eaglepanel/vhosts/example.com");
    expect(host.files.get(logrotatePath("example.com"))).toContain("rotate 14");
  });

  test("site.remove removes the rotation and the OLS logs", async () => {
    const host = new FakeHost();
    await call(host, "site.remove", { fqdn: "example.com" });
    const removed = host.commands.filter(({ command }) => command === "rm").map(({ args }) => args.at(-1));
    expect(removed).toEqual(expect.arrayContaining([logrotatePath("example.com"), "/var/log/eaglepanel/vhosts/example.com"]));
  });

  test("OLS logs are read directly, from a fixed path", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, stdin) => (command === "tail" ? { stdout: "one\ntwo\n" } : respond(command, stdin));
    expect(await read(host, "access", 50)).toEqual({ ok: true, result: { lines: ["one", "two"] } });
    expect(host.commands.find(({ command }) => command === "tail")?.args).toEqual(["-n", "50", "--", "/var/log/eaglepanel/vhosts/example.com/access.log"]);
  });

  test("the PHP log is read with the account permissions and with a time limit", async () => {
    const host = new FakeHost();
    await read(host, "php");
    expect(host.commands.find(({ command }) => command === "timeout")?.args).toEqual([
      "5", "setpriv", "--reuid=acme", "--regid=acme", "--clear-groups", "tail", "-n", "50", "--", "/home/acme/logs/example.com.php_error.log",
    ]);
    expect(host.commands.some(({ command }) => command === "tail")).toBe(false);
  });

  test("a file that does not exist yet is not an error", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, stdin) => (command === "timeout" ? { code: 1, stderr: "tail: cannot open: No such file or directory" } : respond(command, stdin));
    expect(await read(host, "php")).toEqual({ ok: true, result: { lines: [] } });
  });

  test("a hanging read (a FIFO, for example) fails instead of blocking", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, stdin) => (command === "timeout" ? { code: 124 } : respond(command, stdin));
    expect(await read(host, "php")).toMatchObject({ ok: false, error: { message: "Reading the log took too long" } });
  });

  test("a permission denied (a foreign symlink, for example) is an error", async () => {
    const host = new FakeHost();
    const respond = host.respond;
    host.respond = (command, stdin) => (command === "timeout" ? { code: 1, stderr: "Permission denied" } : respond(command, stdin));
    expect(await read(host, "php")).toMatchObject({ ok: false });
  });

  test("does not read logs of a user not created by the panel", async () => {
    const host = new FakeHost();
    host.respond = () => ({ stdout: FOREIGN });
    expect(await read(host, "php")).toMatchObject({ ok: false });
    expect(host.commands.some(({ command }) => command === "timeout")).toBe(false);
  });

  test.each([
    ["fuente desconocida", { username: "acme", fqdn: "example.com", source: "../../etc/shadow", lines: 10 }],
    ["fqdn with a path", { username: "acme", fqdn: "../../etc", source: "access", lines: 10 }],
    ["too many lines", { username: "acme", fqdn: "example.com", source: "access", lines: 100000 }],
    ["usuario con ruta", { username: "../root", fqdn: "example.com", source: "php", lines: 10 }],
  ])("rejects %s without running anything", async (_label, params) => {
    const host = new FakeHost();
    expect(await call(host, "logs.read", params)).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(host.commands).toEqual([]);
  });
});

describe("Redis and Memcached", () => {
  test("writes the memory to a drop-in and restarts to apply it", async () => {
    const host = new FakeHost();
    expect(await call(host, "service.set", { username: "acme", service: "redis", enabled: true, memoryMb: 128 })).toMatchObject({ ok: true });
    expect(host.files.get("/etc/systemd/system/eaglepanel-redis@acme.service.d/limits.conf")).toBe("[Service]\nEnvironment=SERVICE_MEMORY_MB=128\nMemoryMax=256M\n");
    const systemctl = host.commands.filter(({ command }) => command === "systemctl").map(({ args }) => args.join(" "));
    expect(systemctl).toEqual(["daemon-reload", "enable eaglepanel-redis@acme", "restart eaglepanel-redis@acme"]);
  });

  test("disabling stops it and it does not start again with the server", async () => {
    const host = new FakeHost();
    await call(host, "service.set", { username: "acme", service: "memcached", enabled: false, memoryMb: 64 });
    const systemctl = host.commands.filter(({ command }) => command === "systemctl").map(({ args }) => args.join(" "));
    expect(systemctl).toEqual(["daemon-reload", "disable --now eaglepanel-memcached@acme"]);
  });

  test("rejects services and memory outside the list", async () => {
    const host = new FakeHost();
    expect(await call(host, "service.set", { username: "acme", service: "ssh", enabled: true, memoryMb: 64 })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await call(host, "service.set", { username: "acme", service: "redis", enabled: true, memoryMb: 1 })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(host.commands).toEqual([]);
  });
});
