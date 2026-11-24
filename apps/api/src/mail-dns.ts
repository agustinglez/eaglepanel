import { mailHostOf, type DkimKey, type DnsRecordDto } from "@eaglepanel/shared";
import { Resolver } from "node:dns/promises";

export type ExpectedRecord = Omit<DnsRecordDto, "state" | "found">;

export { mailHostOf };

/**
 * What the domain needs at its DNS provider to receive and send mail through this server. SPF lists only the MX
 * (this server); DMARC starts in `none`, to see who sends on the domain's behalf before rejecting anything.
 */
export function expectedRecords(domain: string, ip: string | null, dkim: DkimKey[]): ExpectedRecord[] {
  const mailHost = mailHostOf(domain);
  const records: ExpectedRecord[] = [];
  if (ip) {
    records.push({ type: ip.includes(":") ? "AAAA" : "A", name: mailHost, value: ip, purpose: "Points the mail name to this server", dnsOnly: true });
  }
  records.push(
    { type: "MX", name: domain, value: mailHost, priority: 10, purpose: "Receives the domain's mail", dnsOnly: false },
    { type: "TXT", name: domain, value: "v=spf1 mx -all", purpose: "SPF: only this server sends for the domain", dnsOnly: false },
  );
  for (const key of dkim) {
    records.push({
      type: "TXT",
      name: `${key.selector}._domainkey.${domain}`,
      value: `v=DKIM1; k=${key.algorithm}; h=sha256; p=${key.publicKey}`,
      purpose: key.algorithm === "rsa" ? "DKIM signature (RSA)" : "DKIM signature (Ed25519)",
      dnsOnly: false,
    });
  }
  records.push({ type: "TXT", name: `_dmarc.${domain}`, value: "v=DMARC1; p=none", purpose: "DMARC: what to do with mail that fails SPF and DKIM", dnsOnly: false });
  return records;
}

/**
 * The server's own mail name: where it says it is from when it delivers (EHLO), and what its address resolves back to
 * (PTR). Some servers check SPF for that name too, so it gets its own, separate from any domain.
 */
export function serverRecords(hostname: string, ip: string | null): ExpectedRecord[] {
  const records: ExpectedRecord[] = [];
  if (ip) records.push({ type: ip.includes(":") ? "AAAA" : "A", name: hostname, value: ip, purpose: "Points the server mail name to this server", dnsOnly: true });
  records.push({ type: "TXT", name: hostname, value: "v=spf1 a -all", purpose: "SPF of the name the server greets with", dnsOnly: false });
  return records;
}

/** The reverse DNS of the IP has to be the server name: without it, many providers reject or file mail as spam. */
export async function checkPtr(ip: string, hostname: string, lookup: DnsLookup): Promise<{ state: DnsRecordDto["state"]; found: string[] }> {
  try {
    const found = (await lookup.ptr(ip)).map(stripDot);
    return { state: found.length === 0 ? "missing" : found.includes(hostname) ? "ok" : "different", found };
  } catch {
    return { state: "unknown", found: [] };
  }
}

export interface DnsLookup {
  /** Reverse DNS of an IP. */
  ptr(ip: string): Promise<string[]>;
  a(name: string): Promise<string[]>;
  aaaa(name: string): Promise<string[]>;
  mx(name: string): Promise<{ exchange: string; priority: number }[]>;
  txt(name: string): Promise<string[]>;
}

/** Public resolvers: the answer the rest of the internet sees, not a local cache. */
export function publicLookup(): DnsLookup {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  // A name that does not exist is "missing", not an error.
  const empty = <T>(promise: Promise<T[]>) => promise.catch((error: { code?: string }) => {
    if (error.code === "ENOTFOUND" || error.code === "ENODATA") return [] as T[];
    throw error;
  });
  return {
    ptr: (ip) => empty(resolver.reverse(ip)),
    a: (name) => empty(resolver.resolve4(name)),
    aaaa: (name) => empty(resolver.resolve6(name)),
    mx: (name) => empty(resolver.resolveMx(name)),
    txt: (name) => empty(resolver.resolveTxt(name)).then((rows) => rows.map((chunks) => chunks.join(""))),
  };
}

const normalize = (value: string) => value.replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").trim().toLowerCase();
const stripDot = (name: string) => name.replace(/\.$/, "").toLowerCase();

export async function checkRecord(record: ExpectedRecord, lookup: DnsLookup): Promise<DnsRecordDto> {
  try {
    if (record.type === "A" || record.type === "AAAA") {
      const found = await (record.type === "A" ? lookup.a(record.name) : lookup.aaaa(record.name));
      // Behind the Cloudflare proxy it answers Cloudflare addresses: mail would never arrive.
      return { ...record, state: found.length === 0 ? "missing" : found.includes(record.value) && found.length === 1 ? "ok" : "different", found };
    }
    if (record.type === "MX") {
      const found = await lookup.mx(record.name);
      const ok = found.some(({ exchange }) => stripDot(exchange) === record.value);
      return { ...record, state: found.length === 0 ? "missing" : ok ? "ok" : "different", found: found.map(({ exchange, priority }) => `${priority} ${stripDot(exchange)}`) };
    }
    const txt = await lookup.txt(record.name);
    // Only the records of the same kind count: a domain has several TXT for other purposes.
    const prefix = record.value.split(";")[0]!.split(" ")[0]!.toLowerCase();
    const found = txt.filter((value) => value.trim().toLowerCase().startsWith(prefix));
    let ok: boolean;
    if (prefix === "v=dmarc1") ok = found.length === 1; // a stricter policy than the suggested one is fine
    else if (prefix === "v=dkim1") ok = found.some((value) => value.replace(/\s/g, "").includes(`p=${record.value.split("p=")[1]}`));
    else ok = found.length === 1 && normalize(found[0]!) === normalize(record.value);
    return { ...record, state: found.length === 0 ? "missing" : ok ? "ok" : "different", found };
  } catch {
    return { ...record, state: "unknown", found: [] };
  }
}

export const checkRecords = (records: ExpectedRecord[], lookup: DnsLookup) => Promise.all(records.map((record) => checkRecord(record, lookup)));
