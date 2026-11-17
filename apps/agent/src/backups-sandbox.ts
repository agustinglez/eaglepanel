import { backupManifestSchema, type AgentOpParams, type BackupSnapshot } from "@eaglepanel/shared";
import type { SandboxHost } from "./host";

/**
 * In sandbox mode there is no restic or MySQL: backups are simulated in a JSON file so the screens can be developed.
 * The real logic (backups.ts) is tested on the VPS.
 */
const STORE = "/var/lib/eaglepanel/sandbox-backups.json";

interface Stored extends BackupSnapshot {
  manifest?: string;
}

async function load(host: SandboxHost): Promise<Stored[]> {
  return JSON.parse((await host.readFile(STORE)) ?? "[]") as Stored[];
}

async function save(host: SandboxHost, items: Stored[]): Promise<void> {
  await host.writeFileAtomic(STORE, JSON.stringify(items), 0o600);
}

const fakeId = () => crypto.randomUUID().replaceAll("-", "");

export async function sandboxBackupAccount(host: SandboxHost, params: AgentOpParams<"backup.account">) {
  const items = await load(host);
  const time = Date.now();
  const manifest = JSON.stringify(backupManifestSchema.parse({
    version: 1, username: params.username, createdAt: time, panel: JSON.parse(params.panel),
    server: {
      certificates: [], ftpHash: null, deployKeys: [],
      // Same format MySQL returns: the hash is made up, enough to test the flow.
      mysqlUsers: params.databases.map((database) => ({ database, createUser: `CREATE USER \`${database}\`@\`localhost\` IDENTIFIED WITH 'caching_sha2_password' AS 0x${"AB".repeat(35)}`, grants: [] })),
    },
  }));
  const parts: Stored[] = [
    { id: fakeId(), time, username: params.username, run: params.run, part: "manifest", database: null, sizeBytes: manifest.length, manifest },
    { id: fakeId(), time, username: params.username, run: params.run, part: "files", database: null, sizeBytes: 12_345_678 },
    ...params.databases.map((database): Stored => ({ id: fakeId(), time, username: params.username, run: params.run, part: "database", database, sizeBytes: 54_321 })),
  ];
  await save(host, [...items, ...parts]);
  await host.run("restic", ["backup", "(simulado)", params.username]);
  return { snapshots: parts.map(({ part, id, database }) => ({ part: database ? `database:${database}` : part, id, bytesAdded: 0 })) };
}

export async function sandboxSnapshots(host: SandboxHost, username?: string): Promise<BackupSnapshot[]> {
  return (await load(host)).filter((item) => !username || item.username === username)
    .map(({ manifest: _manifest, ...item }) => item).sort((a, b) => b.time - a.time);
}

export async function sandboxManifest(host: SandboxHost, snapshot: string) {
  const found = (await load(host)).find((item) => item.id === snapshot && item.part === "manifest");
  if (!found?.manifest) throw new Error("That backup has no manifest");
  return backupManifestSchema.parse(JSON.parse(found.manifest));
}

export async function sandboxCheck(host: SandboxHost, snapshot: string, username: string, part: string): Promise<BackupSnapshot> {
  const found = (await load(host)).find((item) => item.id === snapshot);
  if (!found || found.username !== username || found.part !== part) throw new Error("That backup does not belong to this account or does not contain that part");
  return found;
}

export async function sandboxPurge(host: SandboxHost, username: string, before: number): Promise<{ removed: number }> {
  const items = await load(host);
  const kept = items.filter((item) => item.username !== username || item.time >= before);
  await save(host, kept);
  return { removed: items.length - kept.length };
}
