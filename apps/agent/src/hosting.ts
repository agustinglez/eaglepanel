import { siteDir, type AgentOpName, type AgentOpParams, type AgentOpResult } from "@eaglepanel/shared";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { installDeployKey } from "./apps";
import { activateRelease, appLogs, appStatus, controlApp, deployKey, fetchRepo, prepareApp, pruneReleases, releaseDir, removeApp, runBuild, saveRelease, unpackRelease, writeEnv } from "./apps";
import { CLOUDFLARE_ORIGIN_PULL_CA } from "./cloudflare-ca";
import { runFiles } from "./files-runner";
import { olsSynced, withOlsLock } from "./htaccess-watcher";
import { createExport, deleteExport } from "./exports";
import { backupAccount, forgetOld, initRepository, listSnapshots, purgeAccount, readManifest, restoreDatabase, restoreFiles } from "./backups";
import { sandboxBackupAccount, sandboxCheck, sandboxManifest, sandboxPurge, sandboxSnapshots } from "./backups-sandbox";
import { SandboxHost, type CommandResult, type Host } from "./host";
import { connectAsUser, describeTable, discardUpload, executeStatement, importDatabase, killProcess, listProcesses, listTables, readRows, rootSql, type SqlClient } from "./dbadmin";
import { sandboxConnector, sandboxSql } from "./dbadmin-sandbox";
import {
  applyBlock,
  CERTS_DIR,
  certPath,
  firstConfigError,
  HOOKS_LOG_DIR,
  hooksVhostDir,
  HTTPD_CONFIG,
  includedPanelFiles,
  PANEL_CONF_DIR,
  panelBlock,
  renderPanelConf,
  keyPath,
  listenerIsOpen,
  logrotatePath,
  LSWS,
  ORIGIN_PULL_CA_PATH,
  PHP_SYSTEM_INI,
  PHP_SYSTEM_INI_CONTENT,
  PHP_SYSTEM_INI_DIR,
  PHP_ACCOUNTS_INI_DIR,
  accountIniDir,
  accountIniPath,
  renderAccountIni,
  phpLogPath,
  removedListeners,
  renderHooksVhost,
  renderLogrotate,
  renderVhost,
  SUSPENDED_DOC_ROOT,
  userIniPath,
  vhostDir,
  vhostLogDir,
} from "./ols";
import {
  configureService,
  createDatabase,
  databaseUsage,
  deleteDatabase,
  optimizeDatabase,
  removeFtpUser,
  removeServices,
  setDatabasePassword,
  setDatabasesLocked,
  recreateDatabase,
  setDatabasesWritable,
  setFtpHash,
  setFtpPassword,
  setFtpSuspended,
  removeSiteFtp,
  renameSiteFtp,
  setSiteFtpPassword,
} from "./services";

/** Marker in GECOS: the agent only deletes or modifies users created by the panel. */
const ACCOUNT_MARKER = "eaglepanel";
const QUOTA_FILESYSTEM = "/";

type HostingOp = Exclude<AgentOpName, "system.ping" | "system.info" | `packages.${string}` | `panel.${string}` | `wordpress.${string}` | `mail.${string}` | `mysql.${string}`>;
export type HostingHandlers = {
  [N in HostingOp]: (params: AgentOpParams<N>, host: Host) => Promise<AgentOpResult<N>>;
};

async function must(host: Host, command: string, args: string[], stdin?: string): Promise<CommandResult> {
  const result = await host.run(command, args, stdin === undefined ? {} : { stdin });
  if (result.code !== 0) {
    throw new Error(`${command} failed (code ${result.code}): ${result.stderr.trim().slice(0, 300)}`);
  }
  return result;
}

/** `null` if it does not exist. getent returns 2 when it does not find the user. */
async function passwdEntry(host: Host, username: string): Promise<string | null> {
  const { stdout } = await host.run("getent", ["passwd", username]);
  return stdout.trim() || null;
}

function assertManaged(entry: string, username: string): void {
  if (entry.split(":")[4] !== ACCOUNT_MARKER) {
    throw new Error(`The user ${username} exists but was not created by the panel: it is left untouched`);
  }
}

export async function requireManaged(host: Host, username: string): Promise<void> {
  // In sandbox mode there are no real users to look up.
  if (host.sandbox) return;
  const entry = await passwdEntry(host, username);
  if (!entry) throw new Error(`The user ${username} does not exist`);
  assertManaged(entry, username);
}

async function setQuota(host: Host, username: string, quotaMb: number): Promise<void> {
  const kb = String(quotaMb * 1024);
  // setquota prints warnings for every tmpfs even when it works: only its exit code matters.
  await must(host, "setquota", ["-u", username, kb, kb, "0", "0", QUOTA_FILESYSTEM]);
}

async function makeDir(host: Host, path: string, owner: string, group: string, mode: string): Promise<void> {
  await must(host, "install", ["-d", "-o", owner, "-g", group, "-m", mode, path]);
}

const OLS_UNIT = "lshttpd";
/** Log lines are written by whoever visits the site: without this cap, a few very long ones are enough. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/**
 * Stops OLS and waits for it to exit. `systemctl restart` does not work for this: its ExecStop is `delay-stop`,
 * the new process starts with the old one alive and inherits its sockets. Measured on the VPS: 0 out of 8 runs closed them.
 */
export async function stopOlsFully(host: Host, { attempts = 90, delayMs = 500 } = {}): Promise<void> {
  await must(host, "systemctl", ["stop", OLS_UNIT]);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // pgrep exits with 1 if it finds nothing: `must` would treat that as an error.
    const { stdout } = await host.run("pgrep", ["-x", "litespeed"]);
    if (!stdout.trim()) return;
    await Bun.sleep(delayMs);
  }
  throw new Error(`OpenLiteSpeed did not stop within ${Math.round((attempts * delayMs) / 1000)} s: it was not started again`);
}

/** Checks the actual result: a port that is still open stays exposed even if it is no longer in the configuration. */
async function assertNotListening(host: Host, addresses: string[]): Promise<void> {
  const { stdout } = await must(host, "ss", ["-tlnH"]);
  const open = stdout.split("\n").map((line) => line.trim().split(/\s+/)[3] ?? "").filter(Boolean);
  const still = addresses.filter((address) => open.some((local) => listenerIsOpen(address, local)));
  if (still.length > 0) throw new Error(`OpenLiteSpeed is still listening on ${still.join(", ")} after being stopped`);
}

async function preflightChecks(host: Host) {
  const mountOptions = (await host.run("findmnt", ["-no", "OPTIONS", "/home"])).stdout;
  const quotaState = (await host.run("quotaon", ["-p", QUOTA_FILESYSTEM])).stdout;
  const ols = await host.run(`${LSWS}/bin/lswsctrl`, ["status"]);

  return [
    {
      name: "Symlinks blocked in /home",
      ok: mountOptions.includes("nosymfollow"),
      detail: "Without nosymfollow, an account can read another account's files through OLS",
    },
    {
      name: "Disk quotas enabled",
      // Per line: `quotaon -p` also reports group and project quotas.
      ok: /^user quota on .* is on$/m.test(quotaState),
      detail: "Without quotas, account disk space cannot be limited",
    },
    {
      name: "OpenLiteSpeed running",
      ok: ols.stdout.includes("is running"),
      detail: "Without OLS, sites cannot be applied",
    },
  ];
}

/** One connection per explorer operation, closed at the end. Sandbox mode answers with sample data. */
async function withSql<T>(host: Host, work: (sql: SqlClient) => Promise<T>): Promise<T> {
  const sql = host.sandbox ? sandboxSql() : await rootSql();
  try {
    return await work(sql);
  } finally {
    await sql.close();
  }
}

/** Contents of the given files; a missing file is left out. */
async function readFiles(host: Host, paths: string[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const path of paths) {
    const content = await host.readFile(path);
    if (content !== null) files.set(path, content);
  }
  return files;
}

/** Leaves the panel files and `httpd_config.conf` exactly as `files` and `config`, deleting what is not in `files`. */
async function writePanelConf(host: Host, config: string, files: Map<string, string>, others: Iterable<string>) {
  for (const [path, content] of files) await host.writeFileAtomic(path, content, 0o640);
  const stale = [...others].filter((path) => !files.has(path));
  // OLS keeps a copy and an RCS history next to every configuration file it loads (measured in WSL, OLS 1.9.4).
  if (stale.length > 0) await must(host, "rm", ["-f", "--", ...stale.flatMap((path) => [path, `${path}0`, `${path}0,v`, `${path}.txt`])]);
  // Only what the panel writes there: the redirect directory of a domain that no longer has one goes too.
  const staleDirs = [...new Set(stale.filter((path) => path.endsWith("/vhost.conf")).map((path) => path.slice(0, path.lastIndexOf("/"))))];
  if (staleDirs.length > 0) await must(host, "rm", ["-rf", "--", ...staleDirs]);
  if (files.size > 0) {
    await must(host, "chown", ["-R", `--reference=${LSWS}/conf/vhosts`, PANEL_CONF_DIR]);
    await must(host, "chmod", ["-R", "u=rwX,g=rX,o=", PANEL_CONF_DIR]);
  }
  await host.writeFileAtomic(HTTPD_CONFIG, config, 0o640);
  await must(host, "chown", [`--reference=${LSWS}/conf`, HTTPD_CONFIG]);
}

async function syncOls({ sites, restart, hooks = null, redirects = [], acmeHosts = [], webmail = [] }: AgentOpParams<"ols.sync">, host: Host): Promise<AgentOpResult<"ols.sync">> {
  const current = (await host.readFile(HTTPD_CONFIG)) ?? "";
  // Without IPv6 in the kernel, a listener on [ANY] would not bind and OLS would not start.
  const ipv6 = (await host.readFile("/proc/net/if_inet6")) !== null;
  const { block, files } = renderPanelConf(sites, hooks, redirects, acmeHosts, ipv6, webmail);
  const next = applyBlock(current, block);
  // What the current block uses, to compare, to undo, and to delete what stops being used.
  const firstLevel = await readFiles(host, includedPanelFiles(panelBlock(current), () => null));
  const previous = await readFiles(host, includedPanelFiles(panelBlock(current), (path) => firstLevel.get(path)));
  const filesChanged = previous.size !== files.size || [...files].some(([path, content]) => previous.get(path) !== content);
  // Its vhost.conf can change without the block changing: the certificate, for example.
  const hooksConf = hooks ? renderHooksVhost(hooks) : null;
  const hooksChanged = hooksConf !== null && (await host.readFile(`${hooksVhostDir()}/vhost.conf`)) !== hooksConf;
  if (next === current && !filesChanged && !restart && !hooksChanged) return { changed: false };

  // Also before validating. Without a hooks domain the directory is deleted at the end, once OLS no longer uses it.
  if (hooksConf || redirects.length > 0 || acmeHosts.length > 0) {
    await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "711", "/srv/eaglepanel"]);
    await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "755", SUSPENDED_DOC_ROOT]);
  }
  if (hooksConf) {
    await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "755", "/var/log/eaglepanel"]);
    await makeDir(host, HOOKS_LOG_DIR, "root", "nogroup", "750");
    await host.writeFileAtomic(`${hooksVhostDir()}/vhost.conf`, hooksConf, 0o640);
    await must(host, "chown", ["-R", `--reference=${LSWS}/conf/vhosts`, hooksVhostDir()]);
    await must(host, "chmod", ["750", hooksVhostDir()]);
  }

  // Before validating: `openlitespeed -t` would reject a configuration pointing to a missing file.
  if (sites.some((site) => site.originPull) || redirects.some((redirect) => redirect.originPull)) {
    await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "700", CERTS_DIR]);
    await host.writeFileAtomic(ORIGIN_PULL_CA_PATH, CLOUDFLARE_ORIGIN_PULL_CA, 0o600);
  }

  const restore = () => writePanelConf(host, current, previous, files.keys());
  await writePanelConf(host, next, files, previous.keys());

  const test = await host.run(`${LSWS}/bin/openlitespeed`, ["-t"]);
  const error = firstConfigError(`${test.stdout}\n${test.stderr}`);
  if (error) {
    await restore();
    throw new Error(`OLS rejected the configuration and the previous one was restored: ${error}`);
  }

  // Before this version the listeners were inside the block itself.
  const removed = removedListeners(`${panelBlock(current)}\n${[...previous.values()].join("\n")}`, [...files.values()].join("\n"));
  if (removed.length === 0) {
    await must(host, `${LSWS}/bin/lswsctrl`, ["restart"]);
    if (!hooks) await must(host, "rm", ["-rf", "--", hooksVhostDir()]);
    return { changed: true };
  }

  try {
    await stopOlsFully(host);
    await must(host, "systemctl", ["start", OLS_UNIT]);
    await assertNotListening(host, removed);
  } catch (error) {
    await restore();
    // If it did get stopped, the sites cannot stay down. If it is still running, this does nothing.
    await host.run("systemctl", ["start", OLS_UNIT]);
    throw error;
  }
  if (!hooks) await must(host, "rm", ["-rf", "--", hooksVhostDir()]);
  return { changed: true };
}

export const hostingHandlers: HostingHandlers = {
  "system.preflight": async (_params, host) => {
    if (host.sandbox) {
      return { ok: true, checks: [{ name: "Sandbox", ok: true, detail: "Server checks skipped" }] };
    }
    const checks = await preflightChecks(host);
    return { ok: checks.every((check) => check.ok), checks };
  },

  "php.versions": async (_params, host) => {
    if (host.sandbox) return { versions: ["85"] };
    const { stdout } = await must(host, "ls", ["-1", LSWS]);
    // lsphp83 is a dependency of the openlitespeed package: it is installed, but not offered.
    const hidden = new Set((process.env.EAGLEPANEL_PHP_HIDDEN ?? "83").split(",").map((value) => value.trim()));
    const versions = stdout
      .split("\n")
      .map((name) => /^lsphp(\d{2})$/.exec(name.trim())?.[1])
      .filter((version): version is string => version !== undefined && !hidden.has(version));
    return { versions: versions.sort().reverse() };
  },

  "account.create": async ({ username, quotaMb }, host) => {
    const entry = await passwdEntry(host, username);
    if (entry) {
      assertManaged(entry, username);
    } else {
      await must(host, "useradd", ["-M", "-U", "-d", `/home/${username}`, "-s", "/usr/sbin/nologin", "-c", ACCOUNT_MARKER, username]);
    }

    // The nogroup group on the home directory lets OLS in; the account does not belong to that group.
    await makeDir(host, `/home/${username}`, username, "nogroup", "750");
    // Each environment gets its directory inside sites/ when it is created: an account may start without any.
    await makeDir(host, `/home/${username}/sites`, username, username, "755");
    await makeDir(host, `/home/${username}/tmp`, username, username, "700");
    await setQuota(host, username, quotaMb);
    return { ok: true };
  },

  "account.delete": async ({ username }, host) => {
    const entry = await passwdEntry(host, username);
    if (entry) assertManaged(entry, username);

    // Also without a user: the rollback of a half-created account uses it too.
    await removeFtpUser(host, username);
    await removeServices(host, username);
    if (!entry) return { ok: true };

    await host.run("pkill", ["-KILL", "-u", username]);
    await must(host, "userdel", ["--remove", username]);
    await must(host, "rm", ["-rf", "--", accountIniDir(username)]);
    return { ok: true };
  },

  "account.setQuota": async ({ username, quotaMb }, host) => {
    await requireManaged(host, username);
    await setQuota(host, username, quotaMb);
    return { ok: true };
  },

  "system.publicIp": async (_params, host) => {
    const { stdout } = await host.run("ip", ["-4", "route", "get", "1.1.1.1"]);
    // The address it would go out from to the internet, if global: not link-local (fe80::) nor ULA (fc00::/7).
    const v6 = await host.run("ip", ["-6", "route", "get", "2606:4700:4700::1111"]);
    const ip6 = v6.code === 0 ? /\bsrc ([0-9a-f]*:[0-9a-f:]+)/i.exec(v6.stdout)?.[1]?.toLowerCase() ?? null : null;
    return {
      ip: /\bsrc (\d{1,3}(?:\.\d{1,3}){3})\b/.exec(stdout)?.[1] ?? null,
      ip6: ip6 && /^[23]/.test(ip6) ? ip6 : null,
    };
  },

  "ftp.setPassword": async ({ username, password }, host) => {
    await requireManaged(host, username);
    await setFtpPassword(host, username, password);
    return { ok: true };
  },

  "ftp.setSitePassword": async ({ username, site, password }, host) => {
    await requireManaged(host, username);
    await setSiteFtpPassword(host, username, site, password);
    return { ok: true };
  },

  "ftp.removeSite": async ({ username, site }, host) => {
    await removeSiteFtp(host, username, site);
    return { ok: true };
  },

  "db.create": async (params, host) => {
    await requireManaged(host, params.username);
    await createDatabase(host, params);
    return { ok: true };
  },

  "db.delete": async ({ username, name }, host) => {
    await deleteDatabase(host, `${username}_${name}`);
    return { ok: true };
  },

  "db.setPassword": async ({ username, name, password }, host) => {
    await setDatabasePassword(host, `${username}_${name}`, password);
    return { ok: true };
  },

  "db.optimize": async ({ username, name }, host) => {
    await optimizeDatabase(host, `${username}_${name}`);
    return { ok: true };
  },

  "db.setWritable": async ({ databases, writable }, host) => {
    await setDatabasesWritable(host, databases, writable);
    return { ok: true };
  },

  "db.usage": async (_params, host) => databaseUsage(host),

  "db.tables": ({ username, name }, host) => withSql(host, async (sql) => ({ tables: await listTables(sql, `${username}_${name}`) })),
  "db.structure": ({ username, name, table }, host) => withSql(host, (sql) => describeTable(sql, `${username}_${name}`, table)),
  "db.rows": ({ username, name, table, query }, host) => withSql(host, (sql) => readRows(sql, `${username}_${name}`, table, query)),
  "db.import": async ({ username, name, upload, replace }, host) => {
    await importDatabase(host, `${username}_${name}`, upload, replace);
    return { ok: true };
  },
  "db.execute": ({ username, name, access, request }, host) =>
    withSql(host, (sql) => executeStatement(sql, host.sandbox ? sandboxConnector : connectAsUser, `${username}_${name}`, access, request)),
  "db.processes": ({ username, name }, host) => withSql(host, async (sql) => ({ processes: await listProcesses(sql, `${username}_${name}`) })),
  "db.kill": ({ username, name, id }, host) => withSql(host, async (sql) => {
    await killProcess(sql, `${username}_${name}`, id);
    return { ok: true as const };
  }),
  "db.discardUpload": async ({ upload }, host) => {
    await discardUpload(host, upload);
    return { ok: true };
  },

  "service.set": async (params, host) => {
    await requireManaged(host, params.username);
    await configureService(host, params);
    return { ok: true };
  },

  "site.write": async (site, host) => {
    await requireManaged(host, site.username);
    if (!host.sandbox && (await host.run("test", ["-x", `${LSWS}/lsphp${site.phpVersion}/bin/lsphp`])).code !== 0) {
      throw new Error(`lsphp${site.phpVersion} is not installed`);
    }

    // An app has no files in the home directory to publish: its code lives in /srv/eaglepanel/apps.
    if (!site.app) {
      // Directory by directory: `install -d` would leave the intermediate ones owned by root.
      let path = `/home/${site.username}`;
      for (const part of site.docRoot.split("/")) {
        path += `/${part}`;
        await makeDir(host, path, site.username, site.username, "755");
      }

      // Its directory and logs/ always exist, even if docRoot points elsewhere: the PHP log and the FTP access live there.
      await makeDir(host, `/home/${site.username}/sites`, site.username, site.username, "755");
      await makeDir(host, `/home/${site.username}/${siteDir(site.site)}`, site.username, site.username, "755");
      await makeDir(host, `/home/${site.username}/${siteDir(site.site)}/logs`, site.username, site.username, "750");
    }
    await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "755", "/var/log/eaglepanel", "/var/log/eaglepanel/vhosts"]);
    // OLS opens its logs as root and hands them to its user. The group lets only that user in.
    await makeDir(host, vhostLogDir(site.site), "root", "nogroup", "750");
    await host.writeFileAtomic(logrotatePath(site.site), renderLogrotate(site), 0o644);

    await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "755", PHP_SYSTEM_INI_DIR]);
    // /srv/eaglepanel at 711: OLS traverses the directory without being able to list the rest.
    await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "711", "/srv/eaglepanel"]);
    await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "755", SUSPENDED_DOC_ROOT]);
    await host.writeFileAtomic(PHP_SYSTEM_INI, PHP_SYSTEM_INI_CONTENT, 0o644);
    // Readable by the account (its PHP runs as it), writable only by root.
    await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "755", PHP_ACCOUNTS_INI_DIR, accountIniDir(site.username)]);
    await host.writeFileAtomic(accountIniPath(site.username), renderAccountIni(site.username), 0o644);
    // It belongs to the account: created empty with its permissions and, if it already exists, its content is left alone.
    if (!site.app) await must(host, "setpriv", [`--reuid=${site.username}`, `--regid=${site.username}`, "--clear-groups", "touch", "-a", "--", userIniPath(site.username, site.docRoot)]);

    const staticRoot = site.app?.kind === "static" && site.app.release !== null ? releaseDir(site.username, site.app.id, site.app.release) : null;
    if (staticRoot && !host.sandbox && (await host.run("test", ["-d", staticRoot])).code !== 0) {
      throw new Error(`Release ${site.app?.kind === "static" ? site.app.release : ""} is no longer on the server`);
    }
    // OLS rejects a context whose directory does not exist: assets/ is cached only if the release has it.
    const immutableAssets = staticRoot !== null && !host.sandbox && (await host.run("test", ["-d", `${staticRoot}/assets`])).code === 0;

    const dir = vhostDir(site.site);
    await host.writeFileAtomic(`${dir}/vhost.conf`, renderVhost(site, { staticRoot, immutableAssets }), 0o640);
    await must(host, "chown", ["-R", `--reference=${LSWS}/conf/vhosts`, dir]);
    await must(host, "chmod", ["750", dir]);
    return { ok: true };
  },

  "site.remove": async ({ site: fqdn }, host) => {
    // The site files stay in the home directory: deleting content is a separate decision.
    await must(host, "rm", ["-rf", "--", vhostDir(fqdn)]);
    await must(host, "rm", ["-f", "--", logrotatePath(fqdn)]);
    await must(host, "rm", ["-rf", "--", vhostLogDir(fqdn)]);
    return { ok: true };
  },
  "site.rename": async ({ username, from, to }, host) => {
    await requireManaged(host, username);
    if (from === to) return { ok: true };
    const home = `/home/${username}`;
    const exists = async (path: string) => host.sandbox || (await host.run("test", ["-e", path])).code === 0;
    if (await exists(vhostDir(to)) && !host.sandbox) throw new Error(`An environment named ${to} already exists`);
    // Its files: an app has none in sites/. `mv -T` fails if the destination exists instead of moving inside it.
    if (await exists(`${home}/${siteDir(from)}`)) {
      if (!host.sandbox && (await host.run("test", ["-e", `${home}/${siteDir(to)}`])).code === 0) throw new Error(`${home}/${siteDir(to)} already exists`);
      await must(host, "mv", ["-T", "--", `${home}/${siteDir(from)}`, `${home}/${siteDir(to)}`]);
    }
    if (await exists(vhostLogDir(from))) await must(host, "mv", ["-T", "--", vhostLogDir(from), vhostLogDir(to)]);
    // site.write creates the new configuration; the old one would keep a vhost and a rotation pointing to nothing.
    await must(host, "rm", ["-rf", "--", vhostDir(from)]);
    await must(host, "rm", ["-f", "--", logrotatePath(from)]);
    await renameSiteFtp(host, username, from, to);
    return { ok: true };
  },


  "app.prepare": async (params, host) => {
    await requireManaged(host, params.username);
    await prepareApp(host, params);
    return { ok: true };
  },

  "app.deployKey": async ({ appId }, host) => ({ publicKey: await deployKey(host, appId) }),

  "app.fetch": async (params, host) => fetchRepo(host, params),

  "app.unpack": async (params, host) => {
    await requireManaged(host, params.username);
    await unpackRelease(host, params);
    return { ok: true };
  },

  "app.build": async (params, host) => {
    await requireManaged(host, params.username);
    return runBuild(host, params);
  },

  "app.release": async (params, host) => {
    await requireManaged(host, params.username);
    return saveRelease(host, params);
  },

  "app.activate": async (params, host) => {
    await requireManaged(host, params.username);
    return activateRelease(host, params);
  },

  "app.env": async (params, host) => {
    await writeEnv(host, params);
    return { ok: true };
  },

  "app.control": async ({ appId, action }, host) => {
    await controlApp(host, appId, action);
    return { ok: true };
  },

  "app.status": async ({ appId }, host) => appStatus(host, appId),

  "app.logs": async ({ appId, lines, sinceMs }, host) => ({ lines: await appLogs(host, appId, lines, sinceMs) }),

  "app.prune": async (params, host) => {
    await requireManaged(host, params.username);
    await pruneReleases(host, params);
    return { ok: true };
  },

  "app.remove": async (params, host) => {
    await removeApp(host, params);
    return { ok: true };
  },

  "ftp.setSuspended": async ({ username, suspended }, host) => {
    await requireManaged(host, username);
    await setFtpSuspended(host, username, suspended);
    return { ok: true };
  },

  "db.setLocked": async ({ databases, locked }, host) => {
    await setDatabasesLocked(host, databases, locked);
    return { ok: true };
  },

  "php.restart": async ({ username }, host) => {
    await requireManaged(host, username);
    // OLS does not restart lsphp: without this, its variables and what it read at startup stay the same. Measured on
    // the VPS: a single pkill is enough in 5 out of 5 runs. It reaches every environment of the account, and the processes come back on their own.
    const { code, stderr } = await host.run("pkill", ["-u", username, "-x", "lsphp"]);
    // 1 means there were no processes: not a failure.
    if (code > 1) throw new Error(`Could not restart PHP: ${stderr.trim().slice(0, 200)}`);
    return { ok: true };
  },

  "backup.init": async ({ repo }, host) => {
    if (host.sandbox) return { created: false };
    return initRepository(repo);
  },

  "backup.account": async (params, host) => {
    await requireManaged(host, params.username);
    if (host instanceof SandboxHost) return sandboxBackupAccount(host, params);
    return backupAccount(host, params);
  },

  "backup.forget": async ({ repo }, host) => {
    if (!host.sandbox) await forgetOld(repo);
    return { ok: true };
  },

  // Without requireManaged: the Linux user no longer exists when the backups of a deleted account are removed.
  "backup.purge": async ({ repo, username, before }, host) => (host instanceof SandboxHost ? sandboxPurge(host, username, before) : purgeAccount(repo, username, before)),

  "backup.snapshots": async ({ repo, username }, host) => ({
    snapshots: host instanceof SandboxHost ? await sandboxSnapshots(host, username) : await listSnapshots(repo, username),
  }),

  "backup.restoreFiles": async (params, host) => {
    await requireManaged(host, params.username);
    if (host instanceof SandboxHost) {
      await sandboxCheck(host, params.snapshot, params.username, "files");
      await host.run("restic", ["dump", params.snapshot, params.path, params.mode]);
      return { restoredTo: params.mode === "folder" ? `restored-sandbox/${params.path}`.replace(/\/$/, "") : params.path };
    }
    return restoreFiles(params.repo, params);
  },

  "backup.restoreDatabase": async (params, host) => {
    await requireManaged(host, params.username);
    if (host instanceof SandboxHost) {
      const found = await sandboxCheck(host, params.snapshot, params.username, "database");
      if (found.database !== params.database) throw new Error("That backup belongs to another database");
      await host.run("mysql", ["(restore)", params.database]);
      return { ok: true };
    }
    await restoreDatabase(host, params.repo, params);
    return { ok: true };
  },

  "export.create": async (params, host) => {
    await requireManaged(host, params.username);
    if (!params.databases.every((database) => database.startsWith(`${params.username}_`))) throw new Error("Some databases do not belong to this account");
    return createExport(host, params);
  },

  "export.delete": async ({ id }, host) => {
    await deleteExport(host, id);
    return { ok: true };
  },

  "migrate.userCheck": async ({ username }, host) => {
    const entry = await passwdEntry(host, username);
    return { exists: entry !== null, managed: entry !== null && entry.split(":")[4] === ACCOUNT_MARKER };
  },

  "migrate.ftpHash": async ({ username, hash }, host) => {
    await requireManaged(host, username);
    await setFtpHash(host, username, hash);
    return { ok: true };
  },

  "migrate.deployKey": async ({ appId, privateKey, publicKey }, host) => {
    await installDeployKey(host, appId, privateKey, publicKey);
    return { ok: true };
  },

  "backup.recreateDatabase": async ({ username, database, authHash }, host) => {
    await requireManaged(host, username);
    if (!database.startsWith(`${username}_`)) throw new Error("The database does not belong to this account");
    await recreateDatabase(host, database, authHash);
    return { ok: true };
  },

  "backup.manifest": async ({ repo, snapshot }, host) => ({
    manifest: host instanceof SandboxHost ? await sandboxManifest(host, snapshot) : await readManifest(repo, snapshot),
  }),

  "files.run": async ({ username, request }, host) => {
    await requireManaged(host, username);
    return runFiles(host, username, request);
  },

  "logs.read": async ({ username, site: fqdn, source, lines }, host) => {
    await requireManaged(host, username);
    const count = String(lines);
    // The PHP log lives in an account directory, where it can put anything. It is read with the account permissions,
    // not root's, and with a time limit: tested on the VPS, a FIFO would hang the read forever.
    const result = source === "php"
      ? await host.run("timeout", ["5", "setpriv", `--reuid=${username}`, `--regid=${username}`, "--clear-groups", "tail", "-n", count, "--", phpLogPath(username, fqdn)])
      : await host.run("tail", ["-n", count, "--", `${vhostLogDir(fqdn)}/${source}.log`]);

    if (result.code === 124) throw new Error("Reading the log took too long");
    // With no errors yet there is no file: not a failure.
    if (result.code !== 0 && !result.stderr.includes("No such file")) {
      throw new Error(`Could not read the log: ${result.stderr.trim().slice(0, 200)}`);
    }
    return { lines: result.stdout.slice(-MAX_LOG_BYTES).split("\n").filter(Boolean) };
  },

  "ols.sync": async (params, host) => {
    const result = await withOlsLock(() => syncOls(params, host));
    // Restarting OLS also reloads every .htaccess, and a site may now read them or not.
    olsSynced(result.changed);
    return result;
  },

  "cert.write": async ({ zone, certPem, keyPem }, host) => {
    let certificate: X509Certificate;
    let matches: boolean;
    try {
      certificate = new X509Certificate(certPem);
      matches = certificate.checkPrivateKey(createPrivateKey(keyPem));
    } catch {
      // The original error could quote the key content: it is not propagated.
      throw new Error("The certificate or the key is not in a valid PEM format");
    }
    if (!matches) throw new Error("The private key does not match this certificate");

    const notAfter = new Date(certificate.validTo).getTime();
    if (!(notAfter > Date.now())) throw new Error("The certificate has expired");

    const names = (certificate.subjectAltName ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("DNS:"))
      .map((entry) => entry.slice(4).toLowerCase());
    if (!names.includes(zone) && !names.includes(`*.${zone}`)) {
      throw new Error(`The certificate does not cover ${zone}. It includes: ${names.join(", ") || "no names"}`);
    }

    await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "700", CERTS_DIR, `${CERTS_DIR}/${zone}`]);
    await host.writeFileAtomic(certPath(zone), certPem, 0o600);
    await host.writeFileAtomic(keyPath(zone), keyPem, 0o600);
    return { names, notAfter };
  },

  "cert.remove": async ({ zone }, host) => {
    await must(host, "rm", ["-rf", "--", `${CERTS_DIR}/${zone}`]);
    return { ok: true };
  },
};
