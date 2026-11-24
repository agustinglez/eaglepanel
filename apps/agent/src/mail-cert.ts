import { X509Certificate, createPrivateKey } from "node:crypto";
import { MAIL_ACME_PORT, MAIL_CERT_RENEW_DAYS } from "@eaglepanel/shared";
import type { CommandResult, Host } from "./host";

/**
 * Certificates of `mail.<domain>`: Let's Encrypt through lego, HTTP-01 validation. lego listens on MAIL_ACME_PORT
 * only while it validates; how the validation reaches it on port 80 depends on the firewall:
 *
 * - Open: OLS answers port 80 for every name and proxies the validation path of the mail names to lego.
 * - Cloudflare only: port 80 is closed to everyone else. For the length of the validation, what does not come from
 *   Cloudflare and goes to port 80 is redirected to lego (nftables), so the rest of the internet only ever sees the
 *   validation server, never the sites. A systemd timer undoes it if the agent dies in the middle.
 */
export const LEGO_BIN = "/usr/local/bin/lego";
export const ACME_DIR = "/var/lib/eaglepanel/acme";
/** The installer's saved choices (`KEY=value`): the firewall mode, the server mail name. */
export const INSTALL_CONF = "/etc/eaglepanel/install.conf";
const CLOUDFLARE_IPS = "/etc/eaglepanel/cloudflare-ips.txt";
export const ACME_NFT_TABLE = "eaglepanel_acme";
const ACME_NFT_FILE = "/run/eaglepanel-acme.nft";
export const ACME_CLOSE_UNIT = "eaglepanel-acme-close";
const ACME_UFW_COMMENT = "EaglePanel ACME";
/** Long enough for lego (its own timeouts are shorter), short enough that a dead agent leaves nothing open. */
const ACME_WINDOW_SECONDS = 300;

export const legoCertPath = (name: string) => `${ACME_DIR}/certificates/${name}.crt`;
export const legoKeyPath = (name: string) => `${ACME_DIR}/certificates/${name}.key`;

async function must(host: Host, command: string, args: string[], stdin?: string): Promise<CommandResult> {
  const result = await host.run(command, args, stdin === undefined ? {} : { stdin });
  if (result.code !== 0) throw new Error(`${command} failed (code ${result.code}): ${result.stderr.trim().slice(0, 300)}`);
  return result;
}

/** Only one validation at a time: they share the port. */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function cloudflareOnly(host: Host): Promise<boolean> {
  const conf = (await host.readFile(INSTALL_CONF)) ?? "";
  const lines = conf.split("\n").filter((line) => line.startsWith("FIREWALL="));
  return lines.at(-1)?.slice("FIREWALL=".length).trim() === "cloudflare";
}

/** Non-Cloudflare traffic to port 80 goes to lego. IPv4 and IPv6 ranges in their own sets. */
export function renderAcmeRedirect(ranges: string[]): string {
  const v4 = ranges.filter((range) => !range.includes(":"));
  const v6 = ranges.filter((range) => range.includes(":"));
  const set = (name: string, type: string, elements: string[]) =>
    `  set ${name} {\n    type ${type}\n    flags interval\n${elements.length > 0 ? `    elements = { ${elements.join(", ")} }\n` : ""}  }\n`;
  return `table inet ${ACME_NFT_TABLE} {
${set("cloudflare4", "ipv4_addr", v4)}${set("cloudflare6", "ipv6_addr", v6)}  chain prerouting {
    type nat hook prerouting priority dstnat - 1; policy accept;
    meta nfproto ipv4 tcp dport 80 ip saddr != @cloudflare4 redirect to :${MAIL_ACME_PORT}
    meta nfproto ipv6 tcp dport 80 ip6 saddr != @cloudflare6 redirect to :${MAIL_ACME_PORT}
  }
}
`;
}

async function closeValidation(host: Host) {
  await host.run("nft", ["delete", "table", "inet", ACME_NFT_TABLE]);
  await host.run("ufw", ["delete", "allow", `${MAIL_ACME_PORT}/tcp`]);
  await host.run("systemctl", ["stop", `${ACME_CLOSE_UNIT}.timer`]);
  await host.run("systemctl", ["reset-failed", `${ACME_CLOSE_UNIT}.service`, `${ACME_CLOSE_UNIT}.timer`]);
}

async function openValidation(host: Host) {
  const ranges = ((await host.readFile(CLOUDFLARE_IPS)) ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (ranges.length === 0) throw new Error(`There are no Cloudflare ranges in ${CLOUDFLARE_IPS}: run the installer again`);
  // Leftovers of a validation that did not finish.
  await closeValidation(host);
  // First the safety net: whatever happens next, in a few minutes everything is closed again.
  await must(host, "systemd-run", [
    "--quiet", "--unit", ACME_CLOSE_UNIT, `--on-active=${ACME_WINDOW_SECONDS}`,
    "/bin/sh", "-c", `nft delete table inet ${ACME_NFT_TABLE}; ufw delete allow ${MAIL_ACME_PORT}/tcp`,
  ]);
  await host.writeFileAtomic(ACME_NFT_FILE, renderAcmeRedirect(ranges), 0o600);
  await must(host, "nft", ["-f", ACME_NFT_FILE]);
  // After the redirection the packets arrive at MAIL_ACME_PORT: ufw has to let them in.
  await must(host, "ufw", ["allow", `${MAIL_ACME_PORT}/tcp`, "comment", ACME_UFW_COMMENT]);
}

/** lego's last error line, without its colors or timestamps: what the person can act on. */
export function legoError(output: string): string {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  const line = [...lines].reverse().find((entry) => /error|invalid|unauthorized|refused|timeout|NXDOMAIN|rateLimited/i.test(entry)) ?? lines.at(-1) ?? "lego failed";
  const detail = /detail[=:]\s*"?(.+?)"?$/.exec(line)?.[1];
  const text = (detail ?? line).replace(/^.*?(level=\w+\s+)?msg="?/, "").replace(/"$/, "");
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export interface IssuedCertificate {
  certPem: string;
  keyPem: string;
  notAfter: number;
  renewed: boolean;
}

/** Gets the certificate, or renews it if it is due. Without changes lego leaves the files as they are. */
export function obtainCertificate(host: Host, name: string): Promise<IssuedCertificate> {
  return exclusive(async () => {
    const before = await host.readFile(legoCertPath(name));
    const restricted = await cloudflareOnly(host);
    await must(host, "install", ["-d", "-o", "root", "-g", "root", "-m", "700", ACME_DIR]);
    if (restricted) await openValidation(host);
    let result: CommandResult;
    try {
      result = await host.run(LEGO_BIN, [
        "run",
        "--accept-tos",
        "--account-id", "eaglepanel",
        "--path", ACME_DIR,
        "--key-type", "EC256",
        "--http",
        "--http.address", `:${MAIL_ACME_PORT}`,
        "--renew-days", String(MAIL_CERT_RENEW_DAYS),
        "--no-random-sleep",
        "--log.format", "text",
        "--domains", name,
      ]);
    } finally {
      if (restricted) await closeValidation(host);
    }
    if (result.code !== 0) throw new Error(`Let's Encrypt did not issue ${name}: ${legoError(`${result.stdout}\n${result.stderr}`)}`);

    const certPem = await host.readFile(legoCertPath(name));
    const keyPem = await host.readFile(legoKeyPath(name));
    if (!certPem || !keyPem) throw new Error(`lego finished but left no certificate for ${name}`);
    const certificate = new X509Certificate(certPem);
    if (!certificate.checkPrivateKey(createPrivateKey(keyPem))) throw new Error(`The certificate lego left for ${name} does not match its key`);
    return { certPem, keyPem, notAfter: new Date(certificate.validTo).getTime(), renewed: certPem !== before };
  });
}

export async function forgetCertificate(host: Host, name: string) {
  await must(host, "rm", ["-f", "--", legoCertPath(name), legoKeyPath(name), `${ACME_DIR}/certificates/${name}.issuer.crt`, `${ACME_DIR}/certificates/${name}.json`]);
}
