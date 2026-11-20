import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate as drizzleMigrate } from "drizzle-orm/bun-sqlite/migrator";
import { openDb } from "./index";

const DIR = join(import.meta.dir, "..", "..", "drizzle");
const FILES = ["0000_easy_hawkeye", "0001_tan_madripoor", "0002_cloudy_blade", "0003_mysterious_apocalypse", "0004_shallow_gamma_corps", "0005_lucky_black_bolt", "0006_boring_scrambler", "0007_cultured_forgotten_one", "0008_numerous_lockheed", "0009_app_kinds", "0010_merge_install", "0011_deployment_kind", "0012_webhooks", "0013_deploy_queue", "0014_account_exports", "0015_site_ftp", "0016_hostnames", "0017_environment_slugs", "0018_environment_extras"];

function apply(sqlite: Database, name: string) {
  for (const statement of readFileSync(join(DIR, `${name}.sql`), "utf8").split("--> statement-breakpoint")) {
    sqlite.run(statement);
  }
}

test("moving to environments keeps domains, subdomains and certificates", () => {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  apply(sqlite, FILES[0]!);
  apply(sqlite, FILES[1]!);

  sqlite.run("INSERT INTO accounts (username, quota_mb, created_at) VALUES ('acme', 500, 1)");
  sqlite.run(`INSERT INTO domains (fqdn, username, kind, php_version, created_at) VALUES
    ('example.com', 'acme', 'primary', '85', 1),
    ('blog.example.com', 'acme', 'subdomain', '84', 2)`);
  sqlite.run(`INSERT INTO certificates (zone, username, names, not_after) VALUES ('example.com', 'acme', '["example.com"]', 9)`);

  apply(sqlite, FILES[2]!);
  apply(sqlite, FILES[3]!);

  expect(sqlite.query("SELECT fqdn, username, created_at FROM domains").all()).toEqual([
    { fqdn: "example.com", username: "acme", created_at: 1 },
  ]);
  expect(sqlite.query("SELECT fqdn, domain, is_main, type, doc_root, php_version FROM vhosts ORDER BY is_main DESC").all()).toEqual([
    { fqdn: "example.com", domain: "example.com", is_main: 1, type: "php", doc_root: "public_html", php_version: "85" },
    { fqdn: "blog.example.com", domain: "example.com", is_main: 0, type: "php", doc_root: "subdomains/blog.example.com/public_html", php_version: "84" },
  ]);
  expect(sqlite.query("SELECT max_domains, max_vhosts, max_databases, db_storage_mb, app_memory_mb FROM accounts").get()).toEqual({
    max_domains: 1, max_vhosts: 10, max_databases: 5, db_storage_mb: 1024, app_memory_mb: 512,
  });
  expect(sqlite.query("SELECT zone FROM certificates").all()).toEqual([{ zone: "example.com" }]);
});

test("installation becomes part of the build, and existing apps are servers", () => {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const name of FILES.slice(0, 9)) apply(sqlite, name);
  sqlite.run("INSERT INTO accounts (username, quota_mb, created_at) VALUES ('acme', 500, 1)");
  sqlite.run("INSERT INTO domains (fqdn, username, created_at) VALUES ('example.com', 'acme', 1)");
  for (const fqdn of ["a.example.com", "b.example.com", "c.example.com"]) {
    sqlite.run(`INSERT INTO vhosts (fqdn, username, domain, is_main, type, doc_root, php_version, created_at) VALUES ('${fqdn}', 'acme', 'example.com', 0, 'app', 'x', '85', 1)`);
  }
  const insert = (fqdn: string, id: number, install: string, build: string) => sqlite.run(
    "INSERT INTO apps (fqdn, id, repo_url, branch, runtime, runtime_version, install_command, build_command, start_command, health_path, memory_mb, status, created_at) VALUES (?, ?, 'https://x/y.git', 'main', 'bun', '1', ?, ?, 'bun run start', '/', 256, 'new', 1)",
    [fqdn, id, install, build],
  );
  insert("a.example.com", 1, "bun install", "bun run build");
  insert("b.example.com", 2, "bun install", "");
  insert("c.example.com", 3, "", "bun run build");
  apply(sqlite, FILES[9]!);
  apply(sqlite, FILES[10]!);
  expect(sqlite.query("SELECT fqdn, kind, build_command, output_dir, spa_fallback FROM apps ORDER BY fqdn").all()).toEqual([
    { fqdn: "a.example.com", kind: "server", build_command: "bun install && bun run build", output_dir: "", spa_fallback: 1 },
    { fqdn: "b.example.com", kind: "server", build_command: "bun install", output_dir: "", spa_fallback: 1 },
    { fqdn: "c.example.com", kind: "server", build_command: "bun run build", output_dir: "", spa_fallback: 1 },
  ]);
});

test("each environment keeps answering for its own name, and its app survives the change", () => {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const name of FILES.slice(0, 16)) apply(sqlite, name);
  sqlite.run("INSERT INTO accounts (username, quota_mb, created_at) VALUES ('acme', 500, 1)");
  sqlite.run("INSERT INTO domains (fqdn, username, created_at) VALUES ('example.com', 'acme', 1)");
  sqlite.run("INSERT INTO vhosts (fqdn, username, domain, is_main, type, doc_root, php_version, created_at) VALUES ('example.com', 'acme', 'example.com', 1, 'php', 'sites/example.com/public_html', '85', 2)");
  sqlite.run("INSERT INTO vhosts (fqdn, username, domain, is_main, type, doc_root, php_version, created_at) VALUES ('api.example.com', 'acme', 'example.com', 0, 'app', 'x', '85', 3)");
  sqlite.run("INSERT INTO apps (fqdn, id, repo_url, branch, runtime, runtime_version, build_command, start_command, health_path, memory_mb, status, created_at) VALUES ('api.example.com', 1, 'https://x/y.git', 'main', 'bun', '1', '', 'bun start', '/', 256, 'online', 3)");

  apply(sqlite, FILES[16]!);

  expect(sqlite.query("SELECT fqdn, username, domain, vhost, created_at FROM hostnames ORDER BY fqdn").all()).toEqual([
    { fqdn: "api.example.com", username: "acme", domain: "example.com", vhost: "api.example.com", created_at: 3 },
    { fqdn: "example.com", username: "acme", domain: "example.com", vhost: "example.com", created_at: 2 },
  ]);
  expect(sqlite.query("SELECT fqdn, status FROM apps").all()).toEqual([{ fqdn: "api.example.com", status: "online" }]);
  expect(sqlite.query("SELECT name FROM pragma_table_info('vhosts') WHERE name = 'is_main'").all()).toEqual([]);
  // Deleting an environment frees its names instead of deleting them.
  sqlite.run("DELETE FROM vhosts WHERE fqdn = 'example.com'");
  expect(sqlite.query("SELECT vhost FROM hostnames WHERE fqdn = 'example.com'").get()).toEqual({ vhost: null });
});

test("environments get an id, a name, a slug and one hostname, and nothing that hangs from them is lost", () => {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const name of FILES.slice(0, 17)) apply(sqlite, name);
  sqlite.run("INSERT INTO accounts (username, quota_mb, created_at, hook_domain) VALUES ('acme', 500, 1, 'api.example.com')");
  sqlite.run("INSERT INTO domains (fqdn, username, created_at) VALUES ('example.com', 'acme', 1), ('blog.test', 'acme', 1)");
  const vhost = (fqdn: string, domain: string, type: string, docRoot: string, at: number) => {
    sqlite.run(`INSERT INTO vhosts (fqdn, username, domain, type, doc_root, php_version, created_at) VALUES ('${fqdn}', 'acme', '${domain}', '${type}', '${docRoot}', '85', ${at})`);
    sqlite.run(`INSERT INTO hostnames (fqdn, username, domain, vhost, created_at) VALUES ('${fqdn}', 'acme', '${domain}', '${fqdn}', ${at})`);
  };
  vhost("example.com", "example.com", "php", "sites/example.com/public_html", 2);
  vhost("api.example.com", "example.com", "app", "sites/api.example.com/public_html", 3);
  vhost("blog.test", "blog.test", "php", "custom/dir", 4);
  vhost("my-shop.example.com", "example.com", "php", "sites/my-shop.example.com/public_html", 5);
  sqlite.run("INSERT INTO hostnames (fqdn, username, domain, vhost, created_at) VALUES ('free.example.com', 'acme', 'example.com', NULL, 6)");
  sqlite.run("INSERT INTO apps (fqdn, id, repo_url, branch, runtime, runtime_version, build_command, start_command, health_path, memory_mb, status, created_at) VALUES ('api.example.com', 7, 'https://x/y.git', 'main', 'bun', '1', '', 'bun start', '/', 256, 'online', 3)");
  sqlite.run("INSERT INTO app_env (fqdn, key, value, scope) VALUES ('api.example.com', 'TOKEN', 'x', 'runtime')");
  sqlite.run("INSERT INTO deployments (fqdn, release, status, started_at) VALUES ('api.example.com', 1, 'succeeded', 3)");
  sqlite.run("INSERT INTO deploy_queue (fqdn, trigger, requested_at) VALUES ('api.example.com', 'panel', 4)");

  // Like openDb: rebuilding the tables with foreign keys on would delete the apps in cascade.
  sqlite.run("PRAGMA foreign_keys = OFF");
  apply(sqlite, FILES[17]!);
  expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
  sqlite.run("PRAGMA foreign_keys = ON");

  expect(sqlite.query("SELECT id, slug, name, hostname, doc_root FROM vhosts ORDER BY id").all()).toEqual([
    // "example" is reserved: it gets its id.
    { id: 1, slug: "example1", name: "example.com", hostname: "example.com", doc_root: "sites/example1/public_html" },
    { id: 2, slug: "api", name: "api.example.com", hostname: "api.example.com", doc_root: "sites/api/public_html" },
    { id: 3, slug: "blog", name: "blog.test", hostname: "blog.test", doc_root: "custom/dir" },
    { id: 4, slug: "myshop", name: "my-shop.example.com", hostname: "my-shop.example.com", doc_root: "sites/myshop/public_html" },
  ]);
  expect(sqlite.query("SELECT fqdn FROM hostnames ORDER BY fqdn").all().map((row) => (row as { fqdn: string }).fqdn))
    .toEqual(["api.example.com", "blog.test", "example.com", "free.example.com", "my-shop.example.com"]);
  expect(sqlite.query("SELECT vhost, id, status FROM apps").all()).toEqual([{ vhost: 2, id: 7, status: "online" }]);
  expect(sqlite.query("SELECT vhost, key FROM app_env").all()).toEqual([{ vhost: 2, key: "TOKEN" }]);
  expect(sqlite.query("SELECT vhost, release FROM deployments").all()).toEqual([{ vhost: 2, release: 1 }]);
  expect(sqlite.query("SELECT vhost FROM deploy_queue").all()).toEqual([{ vhost: 2 }]);
  expect(sqlite.query("SELECT hook_vhost FROM accounts").get()).toEqual({ hook_vhost: 2 });

  // A hostname in use cannot be deleted; deleting the environment frees it and takes its app along.
  expect(() => sqlite.run("DELETE FROM hostnames WHERE fqdn = 'api.example.com'")).toThrow();
  sqlite.run("DELETE FROM vhosts WHERE id = 2");
  expect(sqlite.query("SELECT COUNT(*) AS n FROM apps").get()).toEqual({ n: 0 });
  expect(sqlite.query("SELECT hook_vhost FROM accounts").get()).toEqual({ hook_vhost: null });
});

const temporary: string[] = [];
afterAll(() => {
  // On Windows a file SQLite just closed can still be locked: leftovers in the temp directory are harmless.
  for (const dir of temporary) try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

/** A copy of the real migrations plus one more, as a release that is not out yet would bring. */
function migrationsWith(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), "eaglepanel-migrations-"));
  temporary.push(dir);
  cpSync(DIR, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
  const last = journal.entries.at(-1)!;
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1000, tag: "9999_next" });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(join(dir, "9999_next.sql"), sql);
  return dir;
}

function seededDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "eaglepanel-db-"));
  temporary.push(dir);
  const path = join(dir, "panel.db");
  const db = openDb(path);
  db.$client.run("INSERT INTO accounts (username, quota_mb, created_at) VALUES ('acme', 500, 1)");
  db.$client.close();
  return path;
}

test("a migration that would leave broken references writes nothing, and the panel does not start", () => {
  const path = seededDb();
  // It deletes the account but leaves a domain pointing to it: only the final check notices.
  const broken = migrationsWith("INSERT INTO domains (fqdn, username, created_at) VALUES ('example.com', 'acme', 2);--> statement-breakpoint\nDELETE FROM accounts;");
  expect(() => openDb(path, { migrationsFolder: broken })).toThrow("nothing was changed");

  const sqlite = new Database(path, { readonly: true });
  expect(sqlite.query("SELECT username FROM accounts").all()).toEqual([{ username: "acme" }]);
  expect(sqlite.query("SELECT COUNT(*) AS n FROM domains").get()).toEqual({ n: 0 });
  expect(sqlite.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: FILES.length });
  sqlite.close();

  // With the release fixed, it migrates and starts normally.
  const fixed = openDb(path, { migrationsFolder: migrationsWith("INSERT INTO domains (fqdn, username, created_at) VALUES ('example.com', 'acme', 2);") });
  expect(fixed.$client.query("SELECT fqdn FROM domains").all()).toEqual([{ fqdn: "example.com" }]);
  expect(fixed.$client.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  fixed.$client.close();
});

test("a migration that fails halfway also leaves the database as it was", () => {
  const path = seededDb();
  expect(() => openDb(path, { migrationsFolder: migrationsWith("DELETE FROM accounts;--> statement-breakpoint\nSELECT * FROM missing_table;") })).toThrow();
  const sqlite = new Database(path, { readonly: true });
  expect(sqlite.query("SELECT username FROM accounts").all()).toEqual([{ username: "acme" }]);
  sqlite.close();
});

test("with nothing pending it changes nothing, and the panel runs with foreign keys on", () => {
  const path = seededDb();
  const db = openDb(path);
  expect(db.$client.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: FILES.length });
  expect(db.$client.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  db.$client.close();
});

test("a database that drizzle's own migrator left continues as is: nothing is applied twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "eaglepanel-db-"));
  temporary.push(dir);
  const path = join(dir, "panel.db");
  const sqlite = new Database(path, { create: true });
  sqlite.run("PRAGMA foreign_keys = OFF");
  drizzleMigrate(drizzle(sqlite), { migrationsFolder: DIR });
  const before = sqlite.query("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM __drizzle_migrations").get();
  sqlite.close();

  const db = openDb(path);
  expect(db.$client.query("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM __drizzle_migrations").get()).toEqual(before);
  db.$client.close();
});
