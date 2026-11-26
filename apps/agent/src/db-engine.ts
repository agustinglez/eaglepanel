import { existsSync } from "node:fs";

/**
 * The installer sets up MySQL or MariaDB, never both: it refuses to install one over the other. MariaDB brings its own
 * server binary (mariadbd), so its presence settles which one runs. Both answer on /run/mysqld/mysqld.sock, and on
 * Debian and Ubuntu MariaDB's unit is also reachable as mysql.service (an alias created when it is enabled).
 */
export type DbEngine = "mysql" | "mariadb";

const MARIADB_SERVER = "/usr/sbin/mariadbd";
let forced: DbEngine | null = null;

export function dbEngine(): DbEngine {
  if (forced) return forced;
  // Under `bun test` the fakes speak MySQL, whatever the machine running the tests has installed.
  if (process.env.NODE_ENV === "test") return "mysql";
  return existsSync(MARIADB_SERVER) ? "mariadb" : "mysql";
}

/** Tests only: the engine as if the server ran it. `null` goes back to detecting it. */
export function setDbEngineForTests(engine: DbEngine | null): void {
  forced = engine;
}

export const dbEngineName = (engine = dbEngine()) => (engine === "mariadb" ? "MariaDB" : "MySQL");

/** The client. MariaDB keeps `mysql` as a link, but newer versions complain on every call. */
export const dbClient = (engine = dbEngine()) => (engine === "mariadb" ? "mariadb" : "mysql");

/**
 * New databases: accent and case insensitive, with the modern Unicode rules each engine has. MariaDB has no 0900
 * collations (before 11.4.5 it rejects them), MySQL has no uca1400 ones.
 */
export const defaultCollation = (engine = dbEngine()) => (engine === "mariadb" ? "utf8mb4_uca1400_ai_ci" : "utf8mb4_0900_ai_ci");

/** mysqldump with the options of every copy. `--set-gtid-purged` is MySQL's only: mariadb-dump refuses it. */
export const dumpCommand = (engine = dbEngine()) => [
  engine === "mariadb" ? "mariadb-dump" : "mysqldump",
  "--protocol=socket", "-uroot", "--single-transaction", "--quick", "--routines", "--triggers", "--events",
  "--hex-blob", "--default-character-set=utf8mb4", ...(engine === "mariadb" ? [] : ["--set-gtid-purged=OFF"]), "--no-tablespaces",
];

/**
 * sed expressions for a dump loaded into MariaDB: MySQL 8 dumps name 0900 collations, which MariaDB rejects. They go to
 * their uca1400 equivalent. On MySQL nothing is changed.
 */
export const collationFix = (engine = dbEngine()): string[] => (engine === "mariadb"
  ? [
    "-e", "s/utf8mb4_0900_ai_ci/utf8mb4_uca1400_ai_ci/g",
    "-e", "s/utf8mb4_0900_as_ci/utf8mb4_uca1400_as_ci/g",
    "-e", "s/utf8mb4_0900_as_cs/utf8mb4_uca1400_as_cs/g",
    "-e", "s/utf8mb4_0900_bin/utf8mb4_bin/g",
  ]
  : []);
