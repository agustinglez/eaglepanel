// EaglePanel - server configuration of Stalwart, run by install.sh with Bun. Safe to run as many times as needed: it
// only creates what is missing and changes what differs.
//
//   bun deploy/stalwart-setup.ts --url http://127.0.0.1:8480 --admin-file /etc/eaglepanel/mail-admin --hostname mail.example.com
//
// Exit codes: 0 nothing that needs a restart changed, 10 listeners were created or changed (Stalwart applies them on
// restart), 1 error.

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index]!.replace(/^--/, ""), process.argv[index + 1] ?? "");
const url = `${args.get("url") ?? "http://127.0.0.1:8480"}/jmap`;
const hostname = (args.get("hostname") ?? "").toLowerCase();
const pair = (await Bun.file(args.get("admin-file") ?? "/etc/eaglepanel/mail-admin").text()).trim();
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname)) throw new Error(`invalid mail hostname: ${hostname}`);
const auth = `Basic ${Buffer.from(pair).toString("base64")}`;

/** The server's own domain: postmaster and reports. Stalwart needs a default one, and the panel never deletes it. */
const serverDomain = hostname.split(".").length > 2 ? hostname.split(".").slice(1).join(".") : hostname;

/**
 * Mail on the usual ports; the HTTP listener (administration, JMAP, MTA-STS policies) only on loopback: OLS serves
 * what the internet needs from it. Submission on 587 requires STARTTLS, on 465 TLS from the start.
 */
const LISTENERS: Record<string, Record<string, unknown>> = {
  smtp: { protocol: "smtp", bind: { "[::]:25": true }, useTls: true, implicitTls: false },
  submission: { protocol: "smtp", bind: { "[::]:587": true }, useTls: true, implicitTls: false },
  submissions: { protocol: "smtp", bind: { "[::]:465": true }, useTls: true, implicitTls: true },
  imaps: { protocol: "imap", bind: { "[::]:993": true }, useTls: true, implicitTls: true },
  http: { protocol: "http", bind: { "127.0.0.1:8480": true }, useTls: false, implicitTls: false },
};

type Args = Record<string, unknown>;

async function call(name: string, callArgs: Args): Promise<Args> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], methodCalls: [[name, callArgs, "c0"]] }),
  });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const [[kind, result]] = ((await response.json()) as { methodResponses: [string, Args][] }).methodResponses;
  if (kind === "error") throw new Error(`${name}: ${String(result.description ?? result.type)}`);
  for (const key of ["notCreated", "notUpdated", "notDestroyed"]) {
    const failed = Object.values((result[key] ?? {}) as Record<string, { description?: string; type?: string }>)[0];
    if (failed) throw new Error(`${name}: ${failed.description ?? failed.type}`);
  }
  return result;
}

async function all<T>(object: string, properties: string[]): Promise<(T & { id: string })[]> {
  const ids = ((await call(`${object}/query`, {})).ids as string[]) ?? [];
  if (ids.length === 0) return [];
  return (await call(`${object}/get`, { ids, properties: [...properties, "id"] })).list as (T & { id: string })[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
let restart = false;

const listeners = await all<{ name: string; protocol: string; bind: Args; useTls: boolean; implicitTls: boolean }>("x:NetworkListener", ["name", "protocol", "bind", "useTls", "implicitTls"]);
for (const [name, wanted] of Object.entries(LISTENERS)) {
  const current = listeners.find((row) => row.name === name);
  if (!current) {
    await call("x:NetworkListener/set", { create: { [name]: { name, ...wanted } } });
    console.log(`listener ${name} created`);
    restart = true;
  } else if (Object.entries(wanted).some(([key, value]) => !same(current[key as keyof typeof current], value))) {
    await call("x:NetworkListener/set", { update: { [current.id]: wanted } });
    console.log(`listener ${name} updated`);
    restart = true;
  }
}
// Listeners the panel did not declare (Stalwart's defaults, on 443 or 8080) would compete with OLS.
const extra = listeners.filter((row) => !(row.name in LISTENERS)).map((row) => row.id);
if (extra.length > 0) {
  await call("x:NetworkListener/set", { destroy: extra });
  console.log(`removed ${extra.length} listener(s) not managed by the panel`);
  restart = true;
}

const domains = await all<{ name: string }>("x:Domain", ["name"]);
let domainId = domains.find((row) => row.name === serverDomain)?.id;
if (!domainId) {
  const created = await call("x:Domain/set", { create: { d: { name: serverDomain, enable: true } } });
  domainId = (created.created as Record<string, { id: string }>).d!.id;
  console.log(`domain ${serverDomain} created`);
}

const [settings] = (await call("x:SystemSettings/get", { ids: ["singleton"], properties: ["defaultHostname", "defaultDomainId"] })).list as { defaultHostname: string; defaultDomainId: string }[];
if (settings?.defaultHostname !== hostname || settings?.defaultDomainId !== domainId) {
  await call("x:SystemSettings/set", { update: { singleton: { defaultHostname: hostname, defaultDomainId: domainId } } });
  // Without it, SMTP keeps greeting with the previous name until a restart (measured on 1.2).
  await call("x:Action/set", { create: { s: { "@type": "ReloadSettings" } } });
  console.log(`hostname ${hostname}`);
}

process.exit(restart ? 10 : 0);

export {};
