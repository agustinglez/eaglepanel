import type { Db } from "./db";
import { auditLog } from "./db/schema";

/** Records an admin action. `detail` must never contain passwords or secrets. */
export function audit(db: Db, action: string, detail?: string): void {
  db.insert(auditLog).values({ at: Date.now(), action, detail: detail ?? null }).run();
}
