import { APP_PORT, appAddresses, type AgentOpParams, type AppRuntime } from "@eaglepanel/shared";
import type { CommandResult, Host } from "./host";
import { HTTPD_CONFIG } from "./ols";

/**
 * Apps in Podman containers, like Coolify but without a daemon. Validated on the VPS (2026-11-06):
 * - Root Podman with the account mapped as the container root (`--uidmap 0:<uid>:1`): processes run with the
 *   account uid, without capabilities, and what they write counts toward its quota. Without root, the shared image
 *   does not work: its root-owned files stay unmapped and the container does not start.
 * - A single copy of each base image for the whole server.
 * - The container joins the app network namespace (`--network ns:`), with its usual firewall.
 * - One image per release: the code is writable, but anything written is lost on restart.
 * - Two slots per app and a redirect inside the namespace: switching releases does not drop any request.
 * - Variables in an EnvironmentFile and `--env KEY` without a value: neither `ps` nor `systemctl show` reveal them.
 */
export const APPS_ROOT = "/srv/eaglepanel";
const REPOS = `${APPS_ROOT}/repos`;
export const KEYS = `${APPS_ROOT}/keys`;
export const APPS_CONFIG = "/etc/eaglepanel/apps";
const FIREWALL = `${APPS_CONFIG}/firewall.nft`;
const UNITS = "/etc/systemd/system";
const FIREWALL_UNIT = "eaglepanel-apps-fw";
const NFT_TABLE = "eaglepanel_apps";
const SLOT_TABLE = "eaglepanel_slot";
const BUILD_MEMORY = "1536M";
const BUILD_TIMEOUT_SEC = 1200;
const HEALTH_TRIES = 60;
/** How long in-flight requests are given to finish before the previous release is stopped. */
export const timing = { drainMs: 5000 };
const MAX_LOG = 256 * 1024;
const DNS = ["1.1.1.1", "9.9.9.9"];
/**
 * MySQL socket directory. Apps get it read-only and connect through the socket:
 * - MySQL still listens only on 127.0.0.1 and the app firewall does not change.
 * - Over the socket, the `'db'@'localhost'` users created by the panel work as they are.
 * - root cannot log in: auth_socket checks the process uid, and inside the container it is the account uid.
 * The directory is mounted, not the file: MySQL creates a new socket on every start and a mount of the file
 * would keep pointing to the old one. So that the directory is not replaced either, deploy/install.sh sets
 * `RuntimeDirectoryPreserve=yes` on mysql.service.
 */
export const MYSQL_RUN = "/run/mysqld";

// ---------------------------------------------------------------------------- Podman

export const PODMAN = "/usr/bin/podman";
const PODMAN_CONFIG = "/etc/eaglepanel/containers";
const STORAGE_CONF = `${PODMAN_CONFIG}/storage.conf`;
const CONTAINERS_CONF = `${PODMAN_CONFIG}/containers.conf`;
/** Outside /run/eaglepanel: systemd deletes that directory every time the agent stops. */
const PODMAN_RUN = "/run/eaglepanel-containers";
export const PODMAN_STORAGE = `${APPS_ROOT}/containers`;
const PODMAN_ENV = [`CONTAINERS_STORAGE_CONF=${STORAGE_CONF}`, `CONTAINERS_CONF_OVERRIDE=${CONTAINERS_CONF}`];

export const storageConf = `# Generado por EaglePanel. No editar a mano.
[storage]
driver = "overlay"
graphroot = "${PODMAN_STORAGE}"
runroot = "${PODMAN_RUN}"
`;

/**
 * Without `default_sysctls`: Podman tries to set ping_group_range and, inside a user namespace on a network
 * created by root, the kernel rejects it and the container does not start (measured on the VPS).
 */
export const containersConf = `# Generado por EaglePanel. No editar a mano.
[containers]
default_sysctls = []
log_driver = "journald"

[engine]
cgroup_manager = "cgroupfs"
events_logger = "file"
`;

/** Official image of the series. Every deployment pulls it again, so new releases of the series arrive. */
export function baseImage(runtime: AppRuntime, version: string): string {
  return runtime === "bun" ? `docker.io/oven/bun:${version}-slim` : `docker.io/library/node:${version}-slim`;
}
export const releaseImage = (id: number, release: number) => `localhost/eaglepanel/app-${id}:${release}`;
const imageRepo = (id: number) => `localhost/eaglepanel/app-${id}`;

const podman = (args: string[]): [string, string[]] => ["env", [...PODMAN_ENV, PODMAN, ...args]];

// ---------------------------------------------------------------------------- Paths

export const appDir = (username: string, fqdn: string) => `${APPS_ROOT}/apps/${username}/${fqdn}`;
/** Code of the release being built, owned by the account. Emptied at the start and end of every deployment. */
export const buildDir = (username: string, fqdn: string) => `${appDir(username, fqdn)}/build`;
/** Static sites only: what OLS serves, owned by root. Servers store each release as an image. */
export const releaseDir = (username: string, fqdn: string, release: number) => `${appDir(username, fqdn)}/releases/${release}`;
export const dataDir = (username: string, fqdn: string) => `/home/${username}/data/${fqdn}`;
/**
 * Build HOME and cache, separate from DATA_DIR: a malicious install script must not be able to touch the app's
 * persistent data. Owned by the account and counted toward its quota; it can be deleted without losing anything.
 */
export const buildHome = (username: string, fqdn: string) => `/home/${username}/.build/${fqdn}`;
export type Slot = "a" | "b";
const SLOT_PORT: Record<Slot, number> = { a: 3001, b: 3002 };
export const appUnit = (id: number, slot: Slot) => `eaglepanel-app-${id}-${slot}`;
const containerName = appUnit;
const buildUnit = (id: number) => `eaglepanel-build-${id}`;
export const netnsUnit = (id: number) => `eaglepanel-netns-${id}`;
const configDir = (id: number) => `${APPS_CONFIG}/${id}`;
const slotFile = (id: number) => `${configDir(id)}/slot`;
const slotNft = (id: number) => `${configDir(id)}/slot.nft`;
const namespace = (id: number) => `epa${id}`;
const hostVeth = (id: number) => `epah${id}`;
const appVeth = (id: number) => `epan${id}`;
const repoDir = (id: number) => `${REPOS}/${id}.git`;
const keyPath = (id: number) => `${KEYS}/${id}`;
const knownHosts = (id: number) => `${KEYS}/${id}.known_hosts`;

async function must(host: Host, command: string, args: string[], stdin?: string): Promise<CommandResult> {
  const result = await host.run(command, args, stdin === undefined ? {} : { stdin });
  if (result.code !== 0) throw new Error(`${command} failed (code ${result.code}): ${result.stderr.trim().slice(0, 300)}`);
  return result;
}

const asUser = (username: string, command: string[]) => ["setpriv", `--reuid=${username}`, `--regid=${username}`, "--clear-groups", ...command];

async function accountIds(host: Host, username: string): Promise<{ uid: string; gid: string }> {
  if (host.sandbox) return { uid: "1001", gid: "1001" };
  const uid = (await must(host, "id", ["-u", "--", username])).stdout.trim();
  const gid = (await must(host, "id", ["-g", "--", username])).stdout.trim();
  if (!/^\d+$/.test(uid) || !/^\d+$/.test(gid) || uid === "0" || gid === "0") throw new Error(`Could not read the uid of ${username}`);
  return { uid, gid };
}

/**
 * Common to every container of an account: its network, the account as the only user, and no capabilities. The
 * processes stay in the unit cgroup, so systemd limits their memory.
 */
export function containerArgs(id: number, uid: string, gid: string): string[] {
  return [
    // Without init, the app process is PID 1 in the container and ignores SIGTERM: measured on the VPS, stopping a
    // release waited the full 20 s timeout before killing it. catatonit forwards the signal.
    "--init",
    "--cgroups=disabled", `--network=ns:/run/netns/${namespace(id)}`,
    `--uidmap=0:${uid}:1`, `--gidmap=0:${gid}:1`,
    // Without no-new-privileges: measured on the VPS, with that option SIGTERM does not reach the app (with or without
    // init) and every stop waits for the timeout. It adds nothing here: the only uid is the account and the capability
    // set is empty, so a setuid binary in the container cannot gain anything the account does not have.
    "--cap-drop=all",
    ...DNS.map((server) => `--dns=${server}`),
  ];
}

/** Keys of an EnvironmentFile: each one is passed to the container as `--env KEY`, without the value. */
const envKeysPath = (id: number, scope: "runtime" | "build") => `${configDir(id)}/${scope}.keys`;
async function envFlags(host: Host, id: number, scope: "runtime" | "build"): Promise<string[]> {
  const keys = (await host.readFile(envKeysPath(id, scope))) ?? "";
  return keys.split("\n").filter((key) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(key)).map((key) => `--env=${key}`);
}

// ---------------------------------------------------------------------------- Network

/** Outbound interface and OLS user id: the firewall only lets root and OLS talk to the apps. */
async function networkFacts(host: Host): Promise<{ wan: string; olsUid: string }> {
  // In sandbox mode there is no network to detect: a value that passes firewall validation is enough.
  if (host.sandbox) return { wan: "eth0", olsUid: "65534" };
  const route = (await must(host, "ip", ["route", "show", "default"])).stdout;
  const wan = /\bdev (\S+)/.exec(route)?.[1];
  if (!wan || !/^[A-Za-z0-9._-]{1,15}$/.test(wan)) throw new Error("Could not detect the outbound interface");
  const config = (await host.readFile(HTTPD_CONFIG)) ?? "";
  const olsUser = /^user\s+(\S+)/m.exec(config)?.[1] ?? "nobody";
  const olsUid = (await must(host, "id", ["-u", "--", olsUser])).stdout.trim();
  if (!/^\d+$/.test(olsUid)) throw new Error("Could not detect the OLS user");
  return { wan, olsUid };
}

/** Same as the spike, with the panel interfaces. `delete` inside the same load replaces it without a gap. */
export function renderFirewall(wan: string, olsUid: string): string {
  return `add table inet ${NFT_TABLE}
delete table inet ${NFT_TABLE}
table inet ${NFT_TABLE} {
  chain input {
    type filter hook input priority 0; policy accept;
    iifname "epah*" ct state established,related accept
    iifname "epah*" drop
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    ct state established,related accept
    iifname "epah*" oifname "epah*" drop
    iifname "epah*" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } drop
    iifname "epah*" oifname "${wan}" accept
  }
  chain output {
    type filter hook output priority 0; policy accept;
    ip daddr 10.88.0.0/16 meta skuid != { 0, ${olsUid} } drop
  }
  chain postrouting {
    type nat hook postrouting priority 100; policy accept;
    ip saddr 10.88.0.0/16 oifname "${wan}" masquerade
  }
}
`;
}

/**
 * Inside the namespace: what OLS sends to the public port goes to the active slot. Open connections stay on
 * the previous one until they close, because conntrack already translated them: that is why the switch drops no requests.
 */
export function renderSlotNft(slot: Slot): string {
  return `add table ip ${SLOT_TABLE}
delete table ip ${SLOT_TABLE}
table ip ${SLOT_TABLE} {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    iifname "eth0" tcp dport ${APP_PORT} redirect to :${SLOT_PORT[slot]}
  }
}
`;
}

const firewallUnit = `[Unit]
Description=EaglePanel: app firewall
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f ${FIREWALL}
ExecStop=-/usr/sbin/nft delete table inet ${NFT_TABLE}

[Install]
WantedBy=multi-user.target
`;

/** Tested on the VPS: starts, restarts without leftovers and leaves nothing behind when stopped. Requires the firewall. */
export function renderNetnsUnit(id: number): string {
  const ns = namespace(id);
  const hostIf = hostVeth(id);
  const peer = appVeth(id);
  const { host, app } = appAddresses(id);
  const ip = "/usr/sbin/ip";
  return `[Unit]
Description=EaglePanel: network of app ${id}
After=${FIREWALL_UNIT}.service
Requires=${FIREWALL_UNIT}.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-${ip} link del ${hostIf}
ExecStartPre=-${ip} netns del ${ns}
ExecStart=${ip} netns add ${ns}
ExecStart=${ip} link add ${hostIf} type veth peer name ${peer}
ExecStart=${ip} link set ${peer} netns ${ns}
ExecStart=${ip} -n ${ns} link set ${peer} name eth0
ExecStart=${ip} addr add ${host}/30 dev ${hostIf}
ExecStart=${ip} link set ${hostIf} up
ExecStart=${ip} -n ${ns} addr add ${app}/30 dev eth0
ExecStart=${ip} -n ${ns} link set lo up
ExecStart=${ip} -n ${ns} link set eth0 up
ExecStart=${ip} -n ${ns} route add default via ${host}
ExecStart=${ip} netns exec ${ns} /usr/sbin/sysctl -qw net.ipv6.conf.all.disable_ipv6=1
# There is no slot until the first deployment: the dash lets the file be missing without failing the network.
ExecStartPost=-${ip} netns exec ${ns} /usr/sbin/nft -f ${slotNft(id)}
ExecStop=-${ip} link del ${hostIf}
ExecStop=-${ip} netns del ${ns}

[Install]
WantedBy=multi-user.target
`;
}

/** Without this, the ufw FORWARD DROP cuts outbound traffic for every app. Configured by deploy/install.sh. */
async function assertServerReady(host: Host): Promise<void> {
  if (host.sandbox) return;
  const forward = (await host.run("sysctl", ["-n", "net.ipv4.ip_forward"])).stdout.trim();
  const rules = (await host.run("iptables", ["-S", "ufw-before-forward"])).stdout;
  if (forward !== "1" || !/-i ep\+ .*-j ACCEPT/.test(rules)) {
    throw new Error("The server is not ready for apps: run deploy/install.sh (ip_forward and the ufw exception)");
  }
  if ((await host.run("test", ["-x", PODMAN])).code !== 0) {
    throw new Error("The server is not ready for apps: Podman is missing (deploy/install.sh installs it)");
  }
  const preserve = (await host.run("systemctl", ["show", "mysql.service", "-p", "RuntimeDirectoryPreserve", "--value"])).stdout.trim();
  if (preserve !== "yes") {
    throw new Error("The server is not ready for apps: MySQL deletes its socket directory when it stops (run deploy/install.sh)");
  }
}

// ---------------------------------------------------------------------------- Prepare

export async function prepareApp(host: Host, { appId, username, fqdn, runtime, runtimeVersion }: AgentOpParams<"app.prepare">): Promise<void> {
  await assertServerReady(host);

  // 711: OLS can traverse to the published static files without being able to list anything.
  await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "711", APPS_ROOT, `${APPS_ROOT}/apps`, `${APPS_ROOT}/apps/${username}`, appDir(username, fqdn), `${appDir(username, fqdn)}/releases`]);
  await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "700", REPOS, KEYS, PODMAN_STORAGE]);
  await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "755", APPS_CONFIG, PODMAN_CONFIG]);
  await must(host, "install", ["-d", "-o", "root", "-g", username, "-m", "750", configDir(appId)]);
  for (const dir of [`/home/${username}/data`, dataDir(username, fqdn), `/home/${username}/.build`, buildHome(username, fqdn)]) {
    await must(host, ...asUserInstall(username, dir));
  }
  await host.writeFileAtomic(STORAGE_CONF, storageConf, 0o644);
  await host.writeFileAtomic(CONTAINERS_CONF, containersConf, 0o644);

  const { wan, olsUid } = await networkFacts(host);
  await host.writeFileAtomic(FIREWALL, renderFirewall(wan, olsUid), 0o600);
  await host.writeFileAtomic(`${UNITS}/${FIREWALL_UNIT}.service`, firewallUnit, 0o644);
  await host.writeFileAtomic(`${UNITS}/${netnsUnit(appId)}.service`, renderNetnsUnit(appId), 0o644);
  await must(host, "systemctl", ["daemon-reload"]);
  await must(host, "systemctl", ["enable", `${FIREWALL_UNIT}.service`, `${netnsUnit(appId)}.service`]);
  // restart, not start: this way it picks up an updated firewall.
  await must(host, "systemctl", ["restart", `${FIREWALL_UNIT}.service`]);
  await must(host, "systemctl", ["start", `${netnsUnit(appId)}.service`]);

  // If it is already up to date, it only compares the manifest: one second.
  const pulled = await host.run(...podman(["pull", "--quiet", baseImage(runtime, runtimeVersion)]));
  if (pulled.code !== 0) throw new Error(`Could not download ${baseImage(runtime, runtimeVersion)}: ${pulled.stderr.trim().split("\n").at(-1)?.slice(0, 200)}`);
}

/** The data directory belongs to the account: created with its permissions, so root never writes inside its home. */
const asUserInstall = (username: string, dir: string): [string, string[]] => {
  const [command, ...args] = asUser(username, ["mkdir", "-p", "-m", "750", "--", dir]);
  return [command!, args];
};

// ---------------------------------------------------------------------------- Git

/** Migration: installs the key the app already had, so it does not have to be added to the repository again. */
export async function installDeployKey(host: Host, appId: number, privateKey: string, publicKey: string): Promise<void> {
  await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "700", KEYS]);
  await host.writeFileAtomic(keyPath(appId), privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, 0o600);
  await host.writeFileAtomic(`${keyPath(appId)}.pub`, publicKey.endsWith("\n") ? publicKey : `${publicKey}\n`, 0o644);
}

export async function deployKey(host: Host, appId: number): Promise<string> {
  await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "700", KEYS]);
  const existing = await host.readFile(`${keyPath(appId)}.pub`);
  if (existing) return existing.trim();
  await must(host, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `eaglepanel-app-${appId}`, "-f", keyPath(appId)]);
  return ((await host.readFile(`${keyPath(appId)}.pub`)) ?? (host.sandbox ? "ssh-ed25519 AAAAsandbox eaglepanel" : "")).trim();
}

/** History fetched from the branch: enough to deploy a queued commit even if newer ones arrived later. */
const FETCH_DEPTH = 50;

/** No hooks and no local transports: the repository belongs to a third party and git runs as root. */
const gitBase = ["-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false"];

function gitEnv(appId: number): string[] {
  // accept-new stores the fingerprint the first time and rejects a different one afterwards.
  const ssh = `ssh -i ${keyPath(appId)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownHosts(appId)} -o ConnectTimeout=20`;
  return ["env", `GIT_SSH_COMMAND=${ssh}`, "GIT_TERMINAL_PROMPT=0", "git", ...gitBase];
}

export async function fetchRepo(host: Host, { appId, repoUrl, branch, commit: wanted }: AgentOpParams<"app.fetch">): Promise<{ commit: string; message: string }> {
  await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "700", REPOS, KEYS]);
  const repo = repoDir(appId);
  const git = gitEnv(appId);
  const [env, ...rest] = git;
  if ((await host.run("test", ["-d", repo])).code !== 0 || host.sandbox) {
    await must(host, env!, [...rest, "init", "--quiet", "--bare", repo]);
  }
  // The URL is set on every deployment: if it changed in the panel, the new one is used.
  await host.run(env!, [...rest, `--git-dir=${repo}`, "remote", "remove", "origin"]);
  await must(host, env!, [...rest, `--git-dir=${repo}`, "remote", "add", "origin", "--", repoUrl]);
  const fetched = await host.run(env!, [...rest, `--git-dir=${repo}`, "fetch", "--quiet", "--prune", `--depth=${FETCH_DEPTH}`, "origin", `+refs/heads/${branch}:refs/heads/${branch}`]);
  if (fetched.code !== 0) {
    const detail = fetched.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    throw new Error(`Could not fetch ${branch}: ${detail}`);
  }
  if (host.sandbox) return { commit: wanted ?? "0".repeat(40), message: "Test commit (sandbox)" };
  const tip = (await must(host, env!, [...rest, `--git-dir=${repo}`, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(tip)) throw new Error("Could not read the commit");
  // A queued commit must still be on the branch: after a force push it is no longer part of what is published.
  if (wanted && wanted !== tip) {
    const inBranch = await host.run(env!, [...rest, `--git-dir=${repo}`, "merge-base", "--is-ancestor", wanted, tip]);
    if (inBranch.code !== 0) throw new Error(`Commit ${wanted.slice(0, 7)} is no longer on ${branch}, or is older than the last ${FETCH_DEPTH} commits`);
  }
  const commit = wanted ?? tip;
  const message = (await must(host, env!, [...rest, `--git-dir=${repo}`, "log", "-1", "--format=%s", commit])).stdout.trim().slice(0, 200);
  return { commit, message };
}

/** root builds the archive, but it is extracted as the account: a tar with symlinks cannot write where the account cannot. */
export async function unpackRelease(host: Host, { appId, username, fqdn, commit, subdir }: AgentOpParams<"app.unpack">): Promise<void> {
  const dest = buildDir(username, fqdn);
  const tar = `${configDir(appId)}/code.tar`;
  // rm does not follow symlinks: deleting as root what the account left does not leave the directory.
  await must(host, "rm", ["-rf", "--", dest]);
  await must(host, "install", ["-d", "-o", username, "-g", username, "-m", "700", dest]);
  const tree = subdir ? `${commit}:${subdir}` : commit;
  await must(host, "git", [...gitBase, `--git-dir=${repoDir(appId)}`, "archive", "--format=tar", "-o", tar, tree]);
  await must(host, "chown", [`root:${username}`, tar]);
  await must(host, "chmod", ["640", tar]);
  try {
    const [command, ...args] = asUser(username, ["tar", "-xf", tar, "-C", dest, "--no-same-owner", "--no-same-permissions"]);
    await must(host, command!, args);
  } finally {
    await host.run("rm", ["-f", "--", tar]);
  }
}

// ---------------------------------------------------------------------------- Variables

/**
 * Format tested on the VPS: double-quoted, with `\` and `"` escaped. Line breaks go as they are:
 * written as `\n` they arrive literally. `$`, `#` and single quotes are kept without escaping.
 */
export function renderEnvFile(vars: Record<string, string>): string {
  return Object.entries(vars).map(([key, value]) => `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n`).join("");
}

export async function writeEnv(host: Host, { appId, runtime, build }: AgentOpParams<"app.env">): Promise<void> {
  await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "755", APPS_CONFIG]);
  await host.writeFileAtomic(`${configDir(appId)}/runtime.env`, renderEnvFile(runtime), 0o600);
  await host.writeFileAtomic(`${configDir(appId)}/build.env`, renderEnvFile(build), 0o600);
  await host.writeFileAtomic(envKeysPath(appId, "runtime"), Object.keys(runtime).map((key) => `${key}\n`).join(""), 0o600);
  await host.writeFileAtomic(envKeysPath(appId, "build"), Object.keys(build).map((key) => `${key}\n`).join(""), 0o600);
}

// ---------------------------------------------------------------------------- Build

/** The command was chosen by the account and runs with its permissions: it goes in a script, so systemd does not interpret `$` or `%`. */
const script = (command: string) => `#!/bin/sh
export PATH="$PWD/node_modules/.bin:$PATH"
${command}
`;

/** The account reads it from the container, so it is owned by root and the account group. */
async function writeScript(host: Host, appId: number, username: string, name: string, content: string): Promise<string> {
  const path = `${configDir(appId)}/${name}`;
  await host.writeFileAtomic(path, content, 0o640);
  await must(host, "chown", [`root:${username}`, path]);
  return path;
}

export async function runBuild(host: Host, params: AgentOpParams<"app.build">): Promise<{ code: number; log: string }> {
  const { appId, username, fqdn, command, runtime, runtimeVersion } = params;
  if (!command.trim()) return { code: 0, log: "" };
  const scriptPath = await writeScript(host, appId, username, "build.sh", script(command));
  const { uid, gid } = await accountIds(host, username);
  await host.run("systemctl", ["reset-failed", `${buildUnit(appId)}.service`]);

  // Writes only to this release's code and its build HOME: it sees neither DATA_DIR nor anything else of the account.
  const result = await host.run("systemd-run", [
    "--wait", "--pipe", "--quiet", "--collect", `--unit=${buildUnit(appId)}`,
    "-p", `MemoryMax=${BUILD_MEMORY}`, "-p", "MemorySwapMax=0", "-p", "CPUQuota=150%", "-p", "Nice=10",
    "-p", `RuntimeMaxSec=${BUILD_TIMEOUT_SEC}`, "-p", "Delegate=yes",
    "-p", `EnvironmentFile=-${configDir(appId)}/build.env`,
    ...PODMAN_ENV.map((value) => `--setenv=${value}`),
    PODMAN, "run", "--rm", "--replace", `--name=${buildUnit(appId)}`, ...containerArgs(appId, uid, gid), "--pids-limit=1024",
    `--volume=${buildDir(username, fqdn)}:/app`, `--volume=${buildHome(username, fqdn)}:/cache`, `--volume=${scriptPath}:/eaglepanel/build.sh:ro`,
    // NODE_ENV is left out on purpose: with production, the build's development dependencies are not installed.
    "--env=HOME=/cache", "--env=CI=1", "--env=NEXT_TELEMETRY_DISABLED=1", ...(await envFlags(host, appId, "build")),
    "--workdir=/app", baseImage(runtime, runtimeVersion), "/bin/sh", "/eaglepanel/build.sh",
  ]);
  const log = `${result.stdout}${result.stderr}`;
  return { code: result.code, log: log.length > MAX_LOG ? log.slice(-MAX_LOG) : log };
}

// ---------------------------------------------------------------------------- Releases

/**
 * Turns the build into a release. A static site copies what is published to a root-owned directory; a server builds
 * an image with the code. Then the build directory is emptied: its size stops counting toward the quota.
 */
export async function saveRelease(host: Host, params: AgentOpParams<"app.release">): Promise<{ files: number; bytes: number }> {
  const { appId, username, fqdn, release, kind, outputDir, runtime, runtimeVersion } = params;
  const source = buildDir(username, fqdn);
  let summary = { files: 0, bytes: 0 };
  if (kind === "static") summary = await publishStatic(host, source, outputDir, releaseDir(username, fqdn, release));
  else {
    const containerfile = `${configDir(appId)}/Containerfile`;
    await host.writeFileAtomic(containerfile, `FROM ${baseImage(runtime, runtimeVersion)}\nCOPY . /app\nWORKDIR /app\n`, 0o644);
    // No network and no pull: it only copies the code on top of the base image already on the server.
    const built = await host.run(...podman(["build", "--quiet", "--pull=never", "--network=none", "--layers=false", "-f", containerfile, "-t", releaseImage(appId, release), source]));
    if (built.code !== 0) throw new Error(`Could not build the image: ${built.stderr.trim().split("\n").at(-1)?.slice(0, 300)}`);
    if (!host.sandbox) {
      const size = (await host.run(...podman(["image", "inspect", "--format", "{{.Size}}", releaseImage(appId, release)]))).stdout.trim();
      summary = { files: 0, bytes: Number(size) || 0 };
    }
  }
  await must(host, "rm", ["-rf", "--", source]);
  return summary;
}

/** Dot files that are published anyway: .well-known is the standard for domain validation. */
const PUBLIC_DOTFILES = new Set([".well-known"]);

/**
 * Copy as root over the account build, with the account processes already stopped. What is published cannot be a
 * symlink pointing outside the build: root would copy what the account cannot read. Inside it, symlinks, dot files and
 * special files are not published.
 */
async function publishStatic(host: Host, source: string, outputDir: string, dest: string): Promise<{ files: number; bytes: number }> {
  const from = outputDir ? `${source}/${outputDir}` : source;
  if (!host.sandbox) {
    const real = (await host.run("realpath", ["-e", "--", from])).stdout.trim();
    const base = (await must(host, "realpath", ["-e", "--", source])).stdout.trim();
    if (!real || (real !== base && !real.startsWith(`${base}/`))) throw new Error(`The build did not produce the directory ${outputDir || "root"}`);
    if ((await host.run("test", ["-d", real])).code !== 0) throw new Error(`${outputDir} is not a directory`);
  }
  await must(host, "rm", ["-rf", "--", dest]);
  await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "755", dest]);
  await must(host, "cp", ["-R", "--no-dereference", "--no-preserve=all", "--", `${from}/.`, dest]);
  await must(host, "find", [dest, "-mindepth", "1", "(", "!", "-type", "f", "!", "-type", "d", ")", "-delete"]);
  // First the complete dot directories, then the individual files.
  const dotted = (await host.run("find", [dest, "-mindepth", "1", "-name", ".*", "-prune", "-print0"])).stdout.split("\0").filter(Boolean);
  for (const path of dotted) {
    if (!PUBLIC_DOTFILES.has(path.slice(path.lastIndexOf("/") + 1))) await must(host, "rm", ["-rf", "--", path]);
  }
  await must(host, "chown", ["-R", "-P", "root:root", dest]);
  await must(host, "chmod", ["-R", "u=rwX,go=rX", dest]);
  if (host.sandbox) return { files: 0, bytes: 0 };
  const files = Number((await host.run("sh", ["-c", 'find "$1" -type f | wc -l', "sh", dest])).stdout.trim()) || 0;
  const bytes = Number((await host.run("du", ["-sb", "--", dest])).stdout.split(/\s/)[0]) || 0;
  if (files === 0) throw new Error(`${outputDir || "The build"} has no files to publish`);
  return { files, bytes };
}

// ---------------------------------------------------------------------------- Start

export interface UnitParams {
  appId: number;
  username: string;
  fqdn: string;
  release: number;
  memoryMb: number;
  slot: Slot;
  uid: string;
  gid: string;
  envFlags: string[];
}

/**
 * Like a Quadlet unit: conmon stays as the main process and notifies systemd when the container has started.
 * With `--rm`, every start is a new container from the image: whatever the app wrote into its code is lost.
 */
export function renderAppUnit({ appId, username, fqdn, release, memoryMb, slot, uid, gid, envFlags: keys }: UnitParams): string {
  const name = containerName(appId, slot);
  const run = [
    PODMAN, "run", "--rm", "--detach", "--replace", `--name=${name}`, "--sdnotify=conmon", ...containerArgs(appId, uid, gid), "--pids-limit=256",
    `--env=PORT=${SLOT_PORT[slot]}`, "--env=HOSTNAME=0.0.0.0", "--env=NODE_ENV=production", "--env=DATA_DIR=/data", "--env=HOME=/data",
    "--env=NEXT_TELEMETRY_DISABLED=1", ...keys,
    `--volume=${dataDir(username, fqdn)}:/data`, `--volume=${configDir(appId)}/start.sh:/eaglepanel/start.sh:ro`,
    `--volume=${MYSQL_RUN}:${MYSQL_RUN}:ro`,
    "--tmpfs=/tmp:rw,size=128m,mode=1777", releaseImage(appId, release), "/bin/sh", "/eaglepanel/start.sh",
  ];
  return `[Unit]
Description=EaglePanel: app ${fqdn} (slot ${slot}, release ${release})
After=${netnsUnit(appId)}.service mysql.service
Requires=${netnsUnit(appId)}.service
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=notify
NotifyAccess=all
Delegate=yes
KillMode=mixed
TimeoutStartSec=120
TimeoutStopSec=40
Environment=${PODMAN_ENV.join(" ")}
EnvironmentFile=-${configDir(appId)}/runtime.env
# If MySQL has not started yet (or does not start), the socket directory must exist anyway: without it Podman does not
# mount the volume and the app does not start. MySQL reuses it when it starts.
ExecStartPre=-/usr/bin/install -d -o mysql -g mysql -m 755 ${MYSQL_RUN}
ExecStart=${run.join(" ")}
ExecStop=${PODMAN} stop --ignore --time=20 ${name}
ExecStopPost=-${PODMAN} rm --force --ignore ${name}
Restart=on-failure
RestartSec=2
MemoryMax=${memoryMb}M
MemorySwapMax=0
TasksMax=512
CPUQuota=100%

[Install]
WantedBy=multi-user.target
`;
}

async function activeSlot(host: Host, appId: number): Promise<Slot | null> {
  const value = (await host.readFile(slotFile(appId)))?.trim();
  return value === "a" || value === "b" ? value : null;
}

const unitFor = async (host: Host, appId: number) => appUnit(appId, (await activeSlot(host, appId)) ?? "a");

async function healthy(host: Host, appId: number, slot: Slot, path: string): Promise<boolean> {
  if (host.sandbox) return true;
  const url = `http://${appAddresses(appId).app}:${SLOT_PORT[slot]}${path}`;
  for (let attempt = 0; attempt < HEALTH_TRIES; attempt += 1) {
    const probe = await host.run("curl", ["-s", "-m", "3", "-o", "/dev/null", "-w", "%{http_code}", url]);
    const code = Number(probe.stdout.trim());
    // Any response that is not a server error: a 404 or a 401 also means the app is alive.
    if (code > 0 && code < 500) return true;
    if ((await host.run("systemctl", ["is-failed", "--quiet", `${appUnit(appId, slot)}.service`])).code === 0) return false;
    await Bun.sleep(1000);
  }
  return false;
}

/**
 * Starts the release in the free slot, waits for it to respond and only then sends traffic to it. If it does not
 * respond, the active one stays as it was. Also used to roll back to a previous release: its image is still on the server.
 */
export async function activateRelease(host: Host, params: AgentOpParams<"app.activate">): Promise<{ healthy: boolean; log: string }> {
  const { appId, username, fqdn, release, startCommand, memoryMb, healthPath } = params;
  if (!host.sandbox && (await host.run(...podman(["image", "exists", releaseImage(appId, release)]))).code !== 0) {
    throw new Error(`Release ${release} is no longer on the server`);
  }
  await writeScript(host, appId, username, "start.sh", script(`exec ${startCommand}`));
  const previous = await activeSlot(host, appId);
  const slot: Slot = previous === "a" ? "b" : "a";
  const unit = `${appUnit(appId, slot)}.service`;
  const { uid, gid } = await accountIds(host, username);
  const unitParams = { appId, username, fqdn, release, memoryMb, slot, uid, gid, envFlags: await envFlags(host, appId, "runtime") };

  await host.run("systemctl", ["stop", unit]);
  await host.writeFileAtomic(`${UNITS}/${unit}`, renderAppUnit(unitParams), 0o644);
  await must(host, "systemctl", ["daemon-reload"]);
  await host.run("systemctl", ["reset-failed", unit]);
  const started = await host.run("systemctl", ["start", unit]);
  if (started.code !== 0 || !(await healthy(host, appId, slot, healthPath))) {
    const log = await recentLogs(host, appId, 60, params.sinceMs, [slot]);
    await host.run("systemctl", ["stop", unit]);
    return { healthy: false, log };
  }

  // From here on, new requests go to this slot.
  await host.writeFileAtomic(slotNft(appId), renderSlotNft(slot), 0o644);
  await must(host, "ip", ["netns", "exec", namespace(appId), "nft", "-f", slotNft(appId)]);
  await host.writeFileAtomic(slotFile(appId), `${slot}\n`, 0o644);
  await must(host, "systemctl", ["enable", unit]);
  if (previous) {
    const old = `${appUnit(appId, previous)}.service`;
    await host.run("systemctl", ["disable", old]);
    if (!host.sandbox) await Bun.sleep(timing.drainMs);
    await host.run("systemctl", ["stop", old]);
  }
  return { healthy: true, log: "" };
}

// ---------------------------------------------------------------------------- Operate

/** Only since this app exists: the number may have belonged to another app, of another account, and the journal keeps its lines. */
async function recentLogs(host: Host, appId: number, lines: number, sinceMs: number, slots: Slot[] = ["a", "b"]): Promise<string> {
  const since = `@${Math.floor(sinceMs / 1000)}`;
  const units = slots.flatMap((slot) => ["-u", `${appUnit(appId, slot)}.service`]);
  const { stdout } = await host.run("journalctl", [...units, "--since", since, "-n", String(lines), "--no-pager", "-o", "short-iso"]);
  return stdout.slice(-MAX_LOG);
}

export async function appLogs(host: Host, appId: number, lines: number, sinceMs: number): Promise<string[]> {
  return (await recentLogs(host, appId, lines, sinceMs)).split("\n").filter((line) => line && !line.startsWith("-- "));
}

export async function controlApp(host: Host, appId: number, action: "start" | "stop" | "restart"): Promise<void> {
  const unit = `${await unitFor(host, appId)}.service`;
  if (action !== "stop") await host.run("systemctl", ["reset-failed", unit]);
  await must(host, "systemctl", [action, unit]);
}

export async function appStatus(host: Host, appId: number) {
  const unit = `${await unitFor(host, appId)}.service`;
  const { stdout } = await host.run("systemctl", ["show", unit, "-p", "ActiveState", "-p", "NRestarts", "-p", "MemoryCurrent", "-p", "ActiveEnterTimestampMonotonic"]);
  const values = new Map(stdout.split("\n").map((line) => line.split("=", 2) as [string, string]));
  const memory = Number(values.get("MemoryCurrent"));
  const since = Number(values.get("ActiveEnterTimestampMonotonic"));
  const uptime = host.sandbox ? 0 : Number((await host.readFile("/proc/uptime"))?.split(" ")[0] ?? 0);
  return {
    state: values.get("ActiveState") || (host.sandbox ? "active" : "unknown"),
    restarts: Number(values.get("NRestarts")) || 0,
    // systemd reports a huge number when it does not measure memory.
    memoryBytes: Number.isFinite(memory) && memory > 0 && memory < 2 ** 60 ? memory : null,
    sinceMs: since > 0 && uptime > 0 ? Date.now() - (uptime * 1000 - since / 1000) : null,
  };
}

/** Deletes the releases not in `keep`: directories of a static site or images of a server. */
export async function pruneReleases(host: Host, { appId, username, fqdn, keep }: AgentOpParams<"app.prune">): Promise<void> {
  const kept = new Set(keep.map(String));
  const { stdout } = await host.run("ls", ["-1", "--", `${appDir(username, fqdn)}/releases`]);
  for (const name of stdout.split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line) && !kept.has(line))) {
    await must(host, "rm", ["-rf", "--", releaseDir(username, fqdn, Number(name))]);
  }
  const images = (await host.run(...podman(["images", "--format", "{{.Tag}}", "--filter", `reference=${imageRepo(appId)}`]))).stdout;
  for (const tag of images.split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line) && !kept.has(line))) {
    await host.run(...podman(["rmi", "--ignore", `${imageRepo(appId)}:${tag}`]));
  }
}

/** Deletes code, releases, images, key and configuration. The app data stays in the account home. */
export async function removeApp(host: Host, { appId, username, fqdn }: AgentOpParams<"app.remove">): Promise<void> {
  const units = (["a", "b"] as const).map((slot) => `${appUnit(appId, slot)}.service`);
  await host.run("systemctl", ["disable", "--now", ...units, `${buildUnit(appId)}.service`, `${netnsUnit(appId)}.service`]);
  for (const slot of ["a", "b"] as const) await host.run(...podman(["rm", "--force", "--ignore", containerName(appId, slot)]));
  await host.run(...podman(["rm", "--force", "--ignore", buildUnit(appId)]));
  const images = (await host.run(...podman(["images", "--format", "{{.Repository}}:{{.Tag}}", "--filter", `reference=${imageRepo(appId)}`]))).stdout;
  for (const image of images.split("\n").map((line) => line.trim()).filter((line) => line.startsWith(`${imageRepo(appId)}:`))) {
    await host.run(...podman(["rmi", "--force", "--ignore", image]));
  }
  for (const path of [...units.map((unit) => `${UNITS}/${unit}`), `${UNITS}/${netnsUnit(appId)}.service`, keyPath(appId), `${keyPath(appId)}.pub`, knownHosts(appId)]) {
    await must(host, "rm", ["-f", "--", path]);
  }
  for (const path of [configDir(appId), repoDir(appId), appDir(username, fqdn)]) {
    await must(host, "rm", ["-rf", "--", path]);
  }
  // The build cache is in the home directory: it is deleted with the account permissions, never as root.
  const [command, ...args] = asUser(username, ["rm", "-rf", "--", buildHome(username, fqdn)]);
  await host.run(command!, args);
  await must(host, "systemctl", ["daemon-reload"]);
  await host.run("systemctl", ["reset-failed", ...units]);
}
