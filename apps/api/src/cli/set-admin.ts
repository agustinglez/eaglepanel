// Creates or replaces the admin. It is also the recovery path: it resets TOTP and closes sessions.
// Usage: printf '%s' 'password' | bun run admin:set -- <username>
// With --if-missing it is only created if there is none yet (used by the installer, which can run several times).
// The password is read from stdin so it does not end up in the shell history or visible in `ps`.
import { hashPassword, setAdminCredentials } from "../auth";
import { openDb } from "../db";
import { admin } from "../db/schema";

const MIN_PASSWORD_LENGTH = 12;

const args = process.argv.slice(2);
const ifMissing = args.includes("--if-missing");
const username = args.find((arg) => !arg.startsWith("--"));
if (!username || !/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
  console.error("Usage: printf '%s' 'password' | bun run admin:set -- <username> [--if-missing]");
  process.exit(1);
}

const db = openDb(process.env.EAGLEPANEL_DB ?? "/var/lib/eaglepanel/eaglepanel.db");
if (ifMissing && db.select({ id: admin.id }).from(admin).get()) {
  console.log("An admin already exists: it is not changed.");
  process.exit(0);
}

const password = (await Bun.stdin.text()).replace(/\r?\n$/, "");
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  process.exit(1);
}

setAdminCredentials(db, username, await hashPassword(password));
console.log(`Admin "${username}" saved. TOTP reset and sessions closed.`);
