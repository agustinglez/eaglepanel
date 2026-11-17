import { eq, lt } from "drizzle-orm";
import { Secret, TOTP } from "otpauth";
import type { Db } from "./db";
import { admin, sessions } from "./db/schema";

export const SESSION_COOKIE = "ep_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const TOTP_PERIOD_SECONDS = 30;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;

// Hash to verify against when the user does not exist, so response time does not reveal it.
const DUMMY_HASH = await Bun.password.hash(crypto.randomUUID(), "argon2id");

export type Admin = typeof admin.$inferSelect;

/** Distinct origins remembered at once: an attack from many IPs does not grow memory without bound. */
const MAX_TRACKED = 10_000;

/**
 * Per-origin lock: with the panel on an IP reachable from outside, a global lock would keep the admin out just
 * by failing on purpose. Each origin (the IP, see `loginOrigin`) has its own attempts.
 */
export class LoginThrottle {
  private entries = new Map<string, { failures: number; lockedUntil: number; seen: number }>();

  constructor(private readonly maxFailures = MAX_FAILED_LOGINS) {}

  isLocked(origin: string, now = Date.now()): boolean {
    return now < (this.entries.get(origin)?.lockedUntil ?? 0);
  }

  recordFailure(origin: string, now = Date.now()): void {
    const entry = this.entries.get(origin) ?? { failures: 0, lockedUntil: 0, seen: now };
    // Old failures do not accumulate forever: once the lock window has passed, counting starts again.
    if (now - entry.seen > LOCK_MS) entry.failures = 0;
    entry.failures += 1;
    entry.seen = now;
    if (entry.failures >= this.maxFailures) {
      entry.lockedUntil = now + LOCK_MS;
      entry.failures = 0;
    }
    this.entries.delete(origin);
    this.entries.set(origin, entry);
    if (this.entries.size > MAX_TRACKED) this.prune(now);
  }

  reset(origin: string): void {
    this.entries.delete(origin);
  }

  private prune(now: number): void {
    for (const [origin, entry] of this.entries) {
      if (now - entry.seen > LOCK_MS && now >= entry.lockedUntil) this.entries.delete(origin);
    }
    // If it is still full, the oldest ones go (the Map keeps the order of the last update).
    for (const origin of this.entries.keys()) {
      if (this.entries.size <= MAX_TRACKED) break;
      this.entries.delete(origin);
    }
  }
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/**
 * Where a login attempt comes from. The connection IP, unless it arrives from the server itself: then it is
 * cloudflared (or another local proxy) and the real IP comes in `CF-Connecting-IP`. A local process can fake that
 * header, so everything local also shares a common cap (`local:*`).
 */
export function loginOrigin(peer: string | undefined, localAddresses: readonly string[], cfConnectingIp: string | undefined): { origin: string; local: boolean } {
  const ip = peer?.replace(/^::ffff:(?=\d)/, "");
  const local = !ip || LOOPBACK.test(ip) || localAddresses.includes(ip);
  if (!local) return { origin: ip!, local: false };
  const forwarded = cfConnectingIp?.trim();
  return { origin: forwarded && /^[0-9a-f.:]{2,45}$/i.test(forwarded) ? `local:${forwarded}` : "local", local: true };
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, "argon2id");
}

export function setAdminCredentials(db: Db, username: string, passwordHash: string): void {
  // Changing credentials from the CLI is the recovery path: it resets TOTP and closes sessions.
  db.transaction((tx) => {
    tx.delete(sessions).run();
    tx.delete(admin).run();
    tx.insert(admin).values({ id: 1, username, passwordHash, updatedAt: Date.now() }).run();
  });
}

export async function verifyCredentials(db: Db, username: string, password: string): Promise<Admin | null> {
  const row = db.select().from(admin).where(eq(admin.username, username)).get();
  const valid = await Bun.password.verify(password, row?.passwordHash ?? DUMMY_HASH);
  return row && valid ? row : null;
}

function buildTotp(secret: string, username: string): TOTP {
  return new TOTP({
    issuer: "EaglePanel",
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(secret),
  });
}

/** Validates the code and consumes it: an accepted code cannot be used again. */
export function consumeTotp(db: Db, row: Admin, secret: string, code: string, now = Date.now()): boolean {
  const delta = buildTotp(secret, row.username).validate({ token: code, window: 1, timestamp: now });
  if (delta === null) return false;

  const counter = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS) + delta;
  if (row.totpLastCounter !== null && counter <= row.totpLastCounter) return false;

  db.update(admin).set({ totpLastCounter: counter }).where(eq(admin.id, row.id)).run();
  return true;
}

export function beginTotpSetup(db: Db, row: Admin): { secret: string; uri: string } {
  const secret = new Secret({ size: 20 }).base32;
  db.update(admin).set({ totpSecret: secret, totpEnabled: false, totpLastCounter: null, updatedAt: Date.now() }).where(eq(admin.id, row.id)).run();
  return { secret, uri: buildTotp(secret, row.username).toString() };
}

export function enableTotp(db: Db, row: Admin): void {
  db.update(admin).set({ totpEnabled: true, updatedAt: Date.now() }).where(eq(admin.id, row.id)).run();
}

export function disableTotp(db: Db, row: Admin): void {
  db.update(admin).set({ totpEnabled: false, totpSecret: null, totpLastCounter: null, updatedAt: Date.now() }).where(eq(admin.id, row.id)).run();
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
}

export async function createSession(db: Db, adminId: number, now = Date.now()): Promise<string> {
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  db.insert(sessions).values({ tokenHash: await hashToken(token), adminId, createdAt: now, expiresAt: now + SESSION_TTL_MS }).run();
  return token;
}

export async function getSessionAdmin(db: Db, token: string, now = Date.now()): Promise<Admin | null> {
  const row = db
    .select({ admin, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(admin, eq(sessions.adminId, admin.id))
    .where(eq(sessions.tokenHash, await hashToken(token)))
    .get();
  return row && row.expiresAt > now ? row.admin : null;
}

export async function destroySession(db: Db, token: string): Promise<void> {
  db.delete(sessions).where(eq(sessions.tokenHash, await hashToken(token))).run();
}
