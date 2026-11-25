import { DEFAULT_PHP_OPTIONS } from "@eaglepanel/shared";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "./dispatch";
import type { CommandResult, Host, RunOptions } from "./host";
import { applyBlock, CERTS_DIR, firstConfigError, HTTPD_CONFIG, includedPanelFiles, listenerIsOpen, PANEL_CONF_DIR, redirectVhostPath, renderPanelConf, renderRedirectVhost, renderVhost, type HooksSite, type RedirectSite, type SyncedSite } from "./ols";

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
    // Its PHP .ini goes with it.
    expect(host.commands.some(({ command, args }) => command === "rm" && args.includes("/etc/eaglepanel/php-accounts/acme"))).toBe(true);
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
  const site = { username: "acme", site: "web", docRoot: "public_html", phpVersion: "85", phpOptions: DEFAULT_PHP_OPTIONS, certZone: null, originPull: false, logLevel: "ERROR", logDays: 30, suspended: false, app: null, hooks: false } as const;

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
    // What the account must not change is not here: OLS ignores php_admin_value. It goes in the .ini files read at startup.
    expect(conf).not.toContain("php_admin");
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
    expect(conf).toContain("PHP_INI_SCAN_DIR=:/etc/eaglepanel/php:/etc/eaglepanel/php-accounts/acme");
    expect(conf).toContain("extUser                 acme");
    expect(conf).toContain("extGroup                acme");
    expect(conf).toContain("/usr/local/lsws/lsphp85/bin/lsphp");
    expect(conf).not.toContain("vhssl");
  });

  test("each environment has its own directory and process, named by its slug", () => {
    const conf = renderVhost({ ...site, site: "blog", docRoot: "sites/blog/public_html" });
    expect(conf).toContain("docRoot                   /home/acme/sites/blog/public_html");
    expect(conf).toContain("uds://tmp/lshttpd/blog.sock");
  });

  test("uses the certificate of its zone", () => {
    const conf = renderVhost({ ...site, site: "blog", certZone: "example.com" });
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
  const http = { site: "web", username: "acme", hostname: "example.com", certZone: null, originPull: false };
  const https = { site: "secure", username: "bravo", hostname: "secure.test", certZone: "secure.test", originPull: false };
  type Site = typeof http | typeof https | SyncedSite;
  /** The block and every file, as one text. */
  const all = (sites: Site[], hooks: HooksSite | null = null, redirects: RedirectSite[] = []) => {
    const { block, files } = renderPanelConf(sites, hooks, redirects);
    return [block, ...files.values()].join("\n");
  };
  const listener = (text: string, name: string) => {
    const start = text.indexOf(`listener ${name}`);
    return start === -1 ? "" : text.slice(start, text.indexOf("\n}", start) + 2);
  };
  /** A server already configured with these sites. */
  async function seeded(sites: Site[]) {
    const host = new FakeHost();
    const { block, files } = renderPanelConf(sites, null);
    await host.writeFileAtomic(HTTPD_CONFIG, applyBlock(BASE, block));
    for (const [path, content] of files) await host.writeFileAtomic(path, content);
    return host;
  }

  test("httpd_config.conf only gets the include lines, without touching the rest", () => {
    const { block, files } = renderPanelConf([http], null);
    const result = applyBlock(BASE, block);
    expect(result).toContain("listener Default{\n  address 127.0.0.1:8088");
    expect(result).toContain(`include ${PANEL_CONF_DIR}/sites/web.conf`);
    expect(result).toContain(`include ${PANEL_CONF_DIR}/listeners.conf`);
    expect(result).not.toContain("virtualhost");
    expect(files.get(`${PANEL_CONF_DIR}/sites/web.conf`)).toContain("allowSymbolLink         0");
    expect(files.get(`${PANEL_CONF_DIR}/listeners.conf`)).toContain("address                 *:80");
  });

  test("mail names answer only the ACME validation, and only on port 80", () => {
    const { block, files } = renderPanelConf([https], null, [], ["mail.b.com", "mail.a.com", "mail.a.com"]);
    const text = [block, ...files.values()].join("\n");
    expect(block).toContain(`include ${PANEL_CONF_DIR}/acme.conf`);
    expect(block).not.toContain("acme/vhost.conf");
    expect(listener(text, "eaglepanel-http")).toContain("map                     eaglepanel-acme mail.a.com, mail.b.com");
    expect(listener(text, "eaglepanel-https")).not.toContain("eaglepanel-acme");
    const vhost = files.get(`${PANEL_CONF_DIR}/acme/vhost.conf`)!;
    expect(vhost).toContain("context /.well-known/acme-challenge/ {");
    expect(vhost).toContain("address                 127.0.0.1:8402");
    expect(vhost).not.toContain("errorlog");
    expect(renderPanelConf([https], null).files.has(`${PANEL_CONF_DIR}/acme.conf`)).toBe(false);
  });

  test("with IPv6 each listener gets a twin on [ANY] with the same maps", () => {
    const text = [...renderPanelConf([https], null, [], ["mail.a.com"], true).files.values()].join("\n");
    for (const [name, port] of [["eaglepanel-http", 80], ["eaglepanel-https", 443]] as const) {
      const v4 = listener(text, `${name} `);
      const v6 = listener(text, `${name}-v6 `);
      expect(v4).toContain(`address                 *:${port}\n`);
      expect(v6).toContain(`address                 [ANY]:${port}\n`);
      expect(v6.split("\n").slice(2)).toEqual(v4.split("\n").slice(2));
    }
    expect([...renderPanelConf([https], null).files.values()].join("\n")).not.toContain("[ANY]");
  });

  test("a listener is open only on its own family", () => {
    expect(listenerIsOpen("*:80", "0.0.0.0:80")).toBe(true);
    expect(listenerIsOpen("*:80", "*:80")).toBe(false);
    expect(listenerIsOpen("[ANY]:80", "*:80")).toBe(true);
    expect(listenerIsOpen("[ANY]:80", "[::]:80")).toBe(true);
    expect(listenerIsOpen("[ANY]:80", "0.0.0.0:80")).toBe(false);
    expect(listenerIsOpen("[ANY]:443", "[::]:80")).toBe(false);
    expect(listenerIsOpen("127.0.0.1:8088", "127.0.0.1:8088")).toBe(true);
  });

  test("the public IPv6 is the global one it goes out from", async () => {
    const routes = (v6: string) => new (class extends FakeHost {
      override async run(_command: string, args: string[]) {
        const stdout = args[0] === "-6" ? v6 : "1.1.1.1 via 203.0.113.1 dev ens3 src 203.0.113.5 uid 0\n";
        return { code: v6 === "" && args[0] === "-6" ? 2 : 0, stdout, stderr: "" };
      }
    })();
    const ipOf = async (v6: string) => (await call(routes(v6), "system.publicIp", {})) as { result: { ip: string; ip6: string | null } };
    expect((await ipOf("2606:4700:4700::1111 from :: via fe80::1 dev ens3 src 2001:DB8:1::F32D metric 1024 pref medium\n")).result)
      .toEqual({ ip: "203.0.113.5", ip6: "2001:db8:1::f32d" });
    expect((await ipOf("")).result.ip6).toBeNull(); // no IPv6 route
    expect((await ipOf("2606:4700:4700::1111 via fe80::1 dev eth0 src fd00::5 metric 1024\n")).result.ip6).toBeNull(); // ULA
  });

  test("the vhosts are included before the listeners that map to them", () => {
    const { block } = renderPanelConf([http, https], null);
    expect(block.indexOf("listeners.conf")).toBeGreaterThan(block.indexOf("sites/web.conf"));
    expect(block.indexOf("listeners.conf")).toBeGreaterThan(block.indexOf("sites/secure.conf"));
  });

  test("replacing the block is idempotent", () => {
    const { block } = renderPanelConf([http], null);
    const once = applyBlock(BASE, block);
    expect(applyBlock(once, block)).toBe(once);
    expect(once.match(/BEGIN EAGLEPANEL/g)).toHaveLength(1);
  });

  test("without sites it does not open public ports", () => {
    const { block, files } = renderPanelConf([], null);
    expect(files.size).toBe(0);
    expect(block).not.toContain("include");
    const result = applyBlock(applyBlock(BASE, renderPanelConf([http], null).block), block);
    expect(result).not.toContain("include");
    expect(result).toContain("listener Default{");
  });

  test("a site without a certificate is not published on 443", () => {
    const httpsListener = listener(all([http, https]), "eaglepanel-https");
    expect(httpsListener).toContain("map                     secure secure.test");
    expect(httpsListener).not.toContain("example.com");
    expect(all([http])).not.toContain("*:443");
  });

  test("the vhost is named by the slug and answers for its hostname", () => {
    const result = all([{ ...http, site: "admincrm", hostname: "admin.example.com" }]);
    expect(result).toContain("virtualhost admincrm {");
    expect(result).toContain("configFile              conf/vhosts/admincrm/vhost.conf");
    expect(result).toContain("map                     admincrm admin.example.com");
  });

  test("aliases go on the same vhost; on 443 only the ones its certificate covers", () => {
    const site = { ...https, aliases: [{ fqdn: "shop.secure.test", secure: true }, { fqdn: "a.b.secure.test", secure: false }] };
    const text = all([site]);
    expect(listener(text, "eaglepanel-http")).toContain("map                     secure secure.test, shop.secure.test, a.b.secure.test");
    expect(listener(text, "eaglepanel-https")).toContain("map                     secure secure.test, shop.secure.test\n");
    expect(text.match(/virtualhost /g)).toHaveLength(1);
  });

  test("redirects: one vhost per domain, without PHP or logs, a 301 to the target keeping the path", () => {
    const redirect = {
      domain: "other.test", certZone: "other.test", originPull: false, suspended: false,
      hosts: [{ fqdn: "other.test", secure: true, target: "https://secure.test" }, { fqdn: "deep.x.other.test", secure: false, target: "https://secure.test" }],
    };
    const { block, files } = renderPanelConf([https], null, [redirect]);
    expect(block).toContain(`include ${PANEL_CONF_DIR}/redirects/other.test.conf`);
    expect(block).not.toContain("vhost.conf");
    const registration = files.get(`${PANEL_CONF_DIR}/redirects/other.test.conf`)!;
    expect(registration).toContain("virtualhost redirect_other.test {");
    expect(registration).toContain("configFile              conf/eaglepanel/redirects/other.test/vhost.conf");
    expect(registration).toContain("enableScript            0");
    const vhost = files.get(redirectVhostPath("other.test"))!;
    expect(vhost).toContain("RewriteCond %{HTTP_HOST} ^other\\.test(:\\d+)?$ [NC]\nRewriteRule ^ https://secure.test%{REQUEST_URI} [R=301,L]");
    expect(vhost).toContain("RewriteCond %{HTTP_HOST} ^deep\\.x\\.other\\.test(:\\d+)?$ [NC]");
    expect(vhost).not.toContain("log");
    expect(vhost).not.toContain("extprocessor");
    expect(vhost).toContain(`keyFile                 ${CERTS_DIR}/other.test/origin.key`);
    const text = [block, ...files.values()].join("\n");
    expect(listener(text, "eaglepanel-http")).toContain("map                     redirect_other.test other.test, deep.x.other.test");
    expect(listener(text, "eaglepanel-https")).toContain("map                     redirect_other.test other.test\n");
  });

  test("a suspended account's redirects answer 503", () => {
    const conf = renderRedirectVhost({ domain: "other.test", certZone: null, originPull: false, suspended: true, hosts: [{ fqdn: "other.test", secure: false, target: "http://example.com" }] });
    expect(conf).toContain("RewriteRule ^ - [R=503,L]");
    expect(conf).not.toContain("R=301");
    expect(conf).not.toContain("vhssl");
  });

  test("redirects alone also open 443 with their certificate", () => {
    const redirect = { domain: "other.test", certZone: "other.test", originPull: true, suspended: false, hosts: [{ fqdn: "other.test", secure: true, target: "http://example.com" }] };
    const https443 = listener(all([http], null, [redirect]), "eaglepanel-https");
    expect(https443).toContain(`keyFile                 ${CERTS_DIR}/other.test/origin.key`);
    expect(https443).toContain("clientVerify            2");
  });

  test("only files of the panel directory are taken as its own", () => {
    const { block, files } = renderPanelConf([https], null, [{ domain: "other.test", certZone: null, originPull: false, suspended: false, hosts: [{ fqdn: "other.test", secure: false, target: "http://secure.test" }] }]);
    const own = includedPanelFiles(`${block}\ninclude /etc/passwd\ninclude ${PANEL_CONF_DIR}/../httpd_config.conf`, (path) => files.get(path));
    expect(own.sort()).toEqual([...files.keys()].sort());
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
    expect(await host.readFile(`${PANEL_CONF_DIR}/sites/web.conf`)).toContain("virtualhost web {");
    expect(await host.readFile(HTTPD_CONFIG)).toContain(`include ${PANEL_CONF_DIR}/sites/web.conf`);
  });

  test("moves a block written before the included files into them", async () => {
    const host = new FakeHost();
    const legacy = `${BASE}\n# BEGIN EAGLEPANEL: generated by the panel, do not edit by hand\n\nvirtualhost web {\n  vhRoot /home/acme\n}\n\nlistener eaglepanel-http {\n  address                 *:80\n  map web example.com\n}\n\n# END EAGLEPANEL\n`;
    await host.writeFileAtomic(HTTPD_CONFIG, legacy);
    expect(await call(host, "ols.sync", { sites: [http] })).toMatchObject({ ok: true });
    const config = (await host.readFile(HTTPD_CONFIG))!;
    expect(config).not.toContain("virtualhost web {");
    expect(config).toContain(`include ${PANEL_CONF_DIR}/listeners.conf`);
    // Port 80 stays: it is only moved, so the usual restart is enough.
    expect(host.ran("lswsctrl")).toBe(true);
  });

  test("does not restart when nothing changed", async () => {
    const host = await seeded([http]);
    expect(await call(host, "ols.sync", { sites: [http] })).toEqual({ ok: true, result: { changed: false } });
    expect(host.ran("lswsctrl")).toBe(false);
  });

  test("a change only inside an included file is applied", async () => {
    const host = await seeded([http]);
    expect(await call(host, "ols.sync", { sites: [{ ...http, aliases: [{ fqdn: "shop.example.com", secure: false }] }] })).toEqual({ ok: true, result: { changed: true } });
    expect(await host.readFile(`${PANEL_CONF_DIR}/listeners.conf`)).toContain("example.com, shop.example.com");
  });

  test("deletes the files of what is no longer there", async () => {
    const host = await seeded([http, https]);
    expect(await call(host, "ols.sync", { sites: [https] })).toMatchObject({ ok: true });
    const removed = host.commands.find(({ command, args }) => command === "rm" && args[0] === "-f");
    expect(removed?.args).toContain(`${PANEL_CONF_DIR}/sites/web.conf`);
    // With the copies OLS keeps next to it.
    expect(removed?.args).toContain(`${PANEL_CONF_DIR}/sites/web.conf0,v`);
    expect(removed?.args).not.toContain(`${PANEL_CONF_DIR}/sites/secure.conf`);
  });

  test("restarts when asked, even if nothing changed", async () => {
    const host = await seeded([http]);
    expect(await call(host, "ols.sync", { sites: [http], restart: true })).toMatchObject({ ok: true });
    expect(host.ran("lswsctrl")).toBe(true);
  });

  test("if OLS rejects the configuration, it restores the previous one and does not restart", async () => {
    const host = await seeded([http]);
    const before = await host.readFile(HTTPD_CONFIG);
    const listeners = await host.readFile(`${PANEL_CONF_DIR}/listeners.conf`);
    // Returns 2 just like on the VPS: what decides is the [ERROR] line.
    host.responses.set("openlitespeed", { code: 2, stdout: "[ERROR] missing <vhRoot>\n" });

    const response = await call(host, "ols.sync", { sites: [http, https] });
    expect(response).toMatchObject({ ok: false, error: { message: expect.stringContaining("missing <vhRoot>") } });
    expect(await host.readFile(HTTPD_CONFIG)).toBe(before);
    expect(await host.readFile(`${PANEL_CONF_DIR}/listeners.conf`)).toBe(listeners);
    // The file of the new site is deleted again.
    expect(host.commands.some(({ command, args }) => command === "rm" && args.includes(`${PANEL_CONF_DIR}/sites/secure.conf`))).toBe(true);
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
