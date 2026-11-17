import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "..", "drizzle");
const FILES = ["0000_easy_hawkeye", "0001_tan_madripoor", "0002_cloudy_blade", "0003_mysterious_apocalypse", "0004_shallow_gamma_corps", "0005_lucky_black_bolt", "0006_boring_scrambler", "0007_cultured_forgotten_one", "0008_numerous_lockheed", "0009_app_kinds", "0010_merge_install", "0011_deployment_kind", "0012_webhooks", "0013_deploy_queue", "0014_account_exports"];

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
