import { z } from "zod";
import { fqdnSchema, generatedSecretSchema } from "./validators";

/**
 * Mail runs on Stalwart, one instance per server. The agent manages it through its JMAP administration API on
 * loopback; the panel keeps what each account has (domains with mail, mailboxes, forwarders) in its own database.
 */

/** The part before the @. Lowercase only: Stalwart and every client compare addresses that way. */
export const mailLocalPartSchema = z
  .string()
  .max(64, "Up to 64 characters")
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, "Lowercase letters, digits, dots, hyphens and underscores, starting and ending with a letter or digit")
  .refine((value) => !value.includes(".."), "Two dots in a row are not allowed");

/** Any address, also outside the server: forwarder recipients and catch-all targets. */
export const emailAddressSchema = z
  .string()
  .max(254)
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => {
    const at = value.lastIndexOf("@");
    return at > 0 && mailLocalPartSchema.safeParse(value.slice(0, at)).success && fqdnSchema.safeParse(value.slice(at + 1)).success;
  }, "Invalid email address");

export const mailQuotaMbSchema = z.number().int().min(10, "The minimum is 10 MB").max(1024 * 1024);
export const DEFAULT_MAILBOX_QUOTA_MB = 1024;
export const MAX_MAILBOX_ALIASES = 50;
export const MAX_FORWARDER_RECIPIENTS = 50;

/**
 * Subdomains that belong to mail once a domain has it: `mail` receives and sends, `webmail` and `mta-sts` are served by
 * the server, and mail clients look up `autoconfig` and `autodiscover`. An environment cannot take them.
 */
export const MAIL_RESERVED_SUBDOMAINS = ["mail", "webmail", "mta-sts", "autoconfig", "autodiscover"] as const;

/** `mail.example.com` and the like, for a domain that has mail. */
export const isMailReserved = (fqdn: string, domain: string) =>
  MAIL_RESERVED_SUBDOMAINS.some((label) => fqdn === `${label}.${domain}`);

/** Mail is optional on a server: this turns it on (the installer asks on a first installation). */
export const MAIL_INSTALL_COMMAND = "sudo eagle mail on";

/** Stalwart administration on loopback only: OLS proxies to it the few paths the internet needs (MTA-STS). */
export const MAIL_HTTP_PORT = 8480;

/**
 * Port of the ACME validation server (lego) while a certificate for `mail.<domain>` is issued. OLS proxies the
 * validation path of those names to it on port 80; with the firewall limited to Cloudflare, the rest of the internet
 * reaches it on port 80 only during the validation.
 */
export const MAIL_ACME_PORT = 8402;
/** Renewal window, like Let's Encrypt suggests for 90-day certificates. */
export const MAIL_CERT_RENEW_DAYS = 30;

/** The name of the server that receives mail for a domain, and the one clients connect to. */
export const mailHostOf = (domain: string) => `mail.${domain}`;

const ok = z.object({ ok: z.literal(true) });
const dkimKeySchema = z.object({ selector: z.string(), algorithm: z.enum(["rsa", "ed25519"]), publicKey: z.string() });

export const mailOps = {
  /** Whether Stalwart is installed and answering, and the name it greets with (the server hostname for mail). */
  "mail.status": {
    params: z.object({}).strict(),
    result: z.object({ installed: z.boolean(), running: z.boolean(), hostname: z.string().nullable() }),
  },
  /** Creates the domain in Stalwart, or updates it. Stalwart generates its DKIM keys (RSA and Ed25519) by itself. */
  "mail.domain.set": {
    params: z.object({ domain: fqdnSchema, catchAll: emailAddressSchema.nullable() }).strict(),
    result: ok,
  },
  /**
   * Gets (or renews, when it is due) the Let's Encrypt certificate of `mail.<domain>` and installs it in Stalwart. The
   * name must already point to this server: the validation connects to it on port 80.
   */
  "mail.cert.issue": {
    params: z.object({ domain: fqdnSchema }).strict(),
    result: z.object({ notAfter: z.number(), renewed: z.boolean() }),
  },
  /**
   * The same for the server's own mail name (its hostname: EHLO, PTR). It is also Stalwart's default certificate, the
   * one served to whoever connects without saying which name it wants.
   */
  "mail.server.cert.issue": {
    params: z.object({}).strict(),
    result: z.object({ hostname: z.string(), notAfter: z.number(), renewed: z.boolean() }),
  },
  /**
   * Changes the server mail name. Also in the installer settings, so a later installer run keeps it. Its parent
   * domain becomes Stalwart's default domain (postmaster, reports).
   */
  "mail.server.hostname.set": {
    params: z.object({ hostname: fqdnSchema }).strict(),
    result: ok,
  },
  /** Whether this server can deliver to other servers: many providers block outgoing port 25. */
  "mail.server.outbound": {
    params: z.object({}).strict(),
    result: z.object({ port25: z.boolean() }),
  },
  /** Deletes its mailboxes (with their mail), forwarders, DKIM keys and certificate, then the domain. */
  "mail.domain.remove": {
    params: z.object({ domain: fqdnSchema }).strict(),
    result: ok,
  },
  /** Active DKIM keys. They appear a few seconds after the domain is created, and rotate every 90 days. */
  "mail.domain.dkim": {
    params: z.object({ domain: fqdnSchema }).strict(),
    result: z.object({ keys: z.array(dkimKeySchema) }),
  },
  /** Creates or updates a mailbox. Without `password`, the current one is kept (it must exist already). */
  "mail.mailbox.set": {
    params: z.object({
      domain: fqdnSchema,
      name: mailLocalPartSchema,
      password: generatedSecretSchema.optional(),
      quotaMb: mailQuotaMbSchema,
      aliases: z.array(mailLocalPartSchema).max(MAX_MAILBOX_ALIASES),
    }).strict(),
    result: ok,
  },
  "mail.mailbox.remove": {
    params: z.object({ domain: fqdnSchema, name: mailLocalPartSchema }).strict(),
    result: ok,
  },
  /** Disk used by each mailbox of the domain, in bytes. */
  "mail.usage": {
    params: z.object({ domain: fqdnSchema }).strict(),
    result: z.object({ mailboxes: z.array(z.object({ name: z.string(), usedBytes: z.number() })) }),
  },
  /** An address that only forwards: every message goes to all its recipients, inside or outside the server. */
  "mail.forwarder.set": {
    params: z.object({ domain: fqdnSchema, name: mailLocalPartSchema, recipients: z.array(emailAddressSchema).min(1).max(MAX_FORWARDER_RECIPIENTS) }).strict(),
    result: ok,
  },
  "mail.forwarder.remove": {
    params: z.object({ domain: fqdnSchema, name: mailLocalPartSchema }).strict(),
    result: ok,
  },
} as const;

export type DkimKey = z.infer<typeof dkimKeySchema>;

export interface MailboxDto {
  /** Full address. */
  address: string;
  name: string;
  quotaMb: number;
  usedBytes: number | null;
  aliases: string[];
  passwordChangedAt: number;
}

export interface ForwarderDto {
  address: string;
  name: string;
  recipients: string[];
}

/** `ok`: the public DNS already answers what is expected. `missing`: nothing there. `different`: something else. */
export type DnsRecordState = "ok" | "missing" | "different" | "unknown";

export interface DnsRecordDto {
  type: "A" | "AAAA" | "MX" | "TXT" | "CNAME";
  name: string;
  value: string;
  priority?: number;
  /** What it is for, in a few words. */
  purpose: string;
  /** Must stay without the Cloudflare proxy (grey cloud). */
  dnsOnly: boolean;
  state: DnsRecordState;
  /** What the public DNS answers now, when it differs. */
  found: string[];
}

/**
 * Certificate of `mail.<domain>`. `waiting`: the name does not point to this server yet, so it cannot be validated;
 * the panel tries by itself once it does (and renews it).
 */
export interface MailCertificateDto {
  state: "valid" | "expiring" | "waiting" | "failed" | "pending";
  notAfter: number | null;
  error: string | null;
  attemptAt: number | null;
}

/** Settings › Server mail: the name the server delivers with, what it needs in DNS, and whether it can deliver. */
export interface ServerMailDto {
  installed: boolean;
  running: boolean;
  /** Stalwart's hostname. `named` false: a placeholder (`*.invalid`), set with the installer's --mail-hostname. */
  hostname: string | null;
  named: boolean;
  ip: string | null;
  /** Global IPv6 it goes out from, if it has one: mail to Gmail and others then leaves over IPv6. */
  ip6: string | null;
  records: DnsRecordDto[];
  /** Reverse DNS of each IP (IPv4 first): set at the server provider, not in the domain DNS. */
  ptrs: { ip: string; state: DnsRecordState; found: string[] }[];
  /** Outgoing port 25: "blocked" means mail to other servers cannot leave. */
  port25: "open" | "blocked" | "unknown";
  certificate: MailCertificateDto;
  checkedAt: number | null;
}

export interface MailDomainDto {
  domain: string;
  enabled: boolean;
  /** Mail is installed on this server (it is optional: MAIL_INSTALL_COMMAND). */
  available: boolean;
  /** Where mail to addresses that do not exist goes. Null: it is rejected. */
  catchAll: string | null;
  mailboxes: MailboxDto[];
  forwarders: ForwarderDto[];
  /** Name of the server for mail: MX and the mail clients point to `mail.<domain>`, which resolves to this server. */
  mailHost: string;
  records: DnsRecordDto[];
  /** When the public DNS was checked; null if it was not checked. */
  checkedAt: number | null;
  /** Mail is not installed on the server, or Stalwart is not answering. */
  serverError: string | null;
  certificate: MailCertificateDto;
}
