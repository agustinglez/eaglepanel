import { authHashOf, systemComponent } from "@eaglepanel/shared";
import { afterEach, describe, expect, test } from "bun:test";
import { collationFix, dbClient, defaultCollation, dumpCommand, setDbEngineForTests } from "./db-engine";
import type { CommandResult, Host } from "./host";
import { componentPackages } from "./packages";
import { createDatabase, recreateDatabase } from "./services";

const SHA2 = `0x${"AB".repeat(35)}`;
const NATIVE = `*${"94BDCEBE19083CE2A1F959FD02F964C7AF4CFC29"}`;

class SqlHost implements Host {
  readonly sandbox = false;
  readonly calls: { command: string; stdin?: string }[] = [];
  async run(command: string, _args: string[], options: { stdin?: string } = {}): Promise<CommandResult> {
    this.calls.push({ command, stdin: options.stdin });
    return { code: 0, stdout: "", stderr: "" };
  }
  async writeFileAtomic(): Promise<void> {}
  async readFile(): Promise<string | null> {
    return null;
  }
}

afterEach(() => setDbEngineForTests(null));

describe("MySQL or MariaDB", () => {
  test("each engine gets its own client, dump options and collation", () => {
    expect(dbClient("mysql")).toBe("mysql");
    expect(dbClient("mariadb")).toBe("mariadb");
    expect(dumpCommand("mysql")).toContain("--set-gtid-purged=OFF");
    expect(dumpCommand("mariadb")[0]).toBe("mariadb-dump");
    expect(dumpCommand("mariadb")).not.toContain("--set-gtid-purged=OFF");
    expect(defaultCollation("mysql")).toBe("utf8mb4_0900_ai_ci");
    expect(defaultCollation("mariadb")).toBe("utf8mb4_uca1400_ai_ci");
  });

  test("a MySQL 8 dump loaded into MariaDB has its collations translated", async () => {
    expect(collationFix("mysql")).toEqual([]);
    const sed = Bun.spawnSync(["sed", "-E", ...collationFix("mariadb")], {
      stdin: new TextEncoder().encode("CREATE TABLE `t` (`a` text COLLATE utf8mb4_0900_as_cs) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\n"),
    });
    expect(sed.stdout.toString()).toBe("CREATE TABLE `t` (`a` text COLLATE utf8mb4_uca1400_as_cs) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;\n");
  });

  test("new databases use the engine's collation and client", async () => {
    setDbEngineForTests("mariadb");
    const host = new SqlHost();
    await createDatabase(host, { username: "acme", name: "wp", password: "AbCdEfGh_ijklmnop-1234" });
    expect(host.calls[0]?.command).toBe("mariadb");
    expect(host.calls[0]?.stdin).toContain("COLLATE utf8mb4_uca1400_ai_ci");
  });

  test("the saved password hash goes back in the engine's own form", async () => {
    setDbEngineForTests("mariadb");
    const maria = new SqlHost();
    await recreateDatabase(maria, "acme_wp", NATIVE);
    expect(maria.calls[0]?.stdin).toContain(`IDENTIFIED BY PASSWORD '${NATIVE}'`);

    setDbEngineForTests("mysql");
    const mysql = new SqlHost();
    await recreateDatabase(mysql, "acme_wp", SHA2);
    expect(mysql.calls[0]?.stdin).toContain(`IDENTIFIED WITH caching_sha2_password AS ${SHA2}`);
  });

  test("a hash from the other engine is refused instead of leaving a user nobody can log in as", async () => {
    setDbEngineForTests("mariadb");
    const host = new SqlHost();
    await expect(recreateDatabase(host, "acme_wp", SHA2)).rejects.toThrow("saved by MySQL and this server runs MariaDB");
    expect(host.calls).toHaveLength(0);
  });

  test("the backup reads the hash from MariaDB's SHOW CREATE USER", () => {
    expect(authHashOf(`CREATE USER \`acme_wp\`@\`localhost\` IDENTIFIED BY PASSWORD '${NATIVE}' WITH MAX_USER_CONNECTIONS 20`)).toBe(NATIVE);
    expect(authHashOf(`CREATE USER \`acme_wp\`@\`localhost\` IDENTIFIED WITH 'caching_sha2_password' AS ${SHA2}`)).toBe(SHA2);
    expect(authHashOf("CREATE USER `acme_wp`@`localhost` IDENTIFIED BY PASSWORD '*short'")).toBeNull();
  });

  test("on MariaDB the updates screen shows MariaDB, not MySQL from its mysql-common", () => {
    const installed = ["mariadb-server", "mariadb-client", "mariadb-common", "mysql-common"].map((name) => ({ name, version: "1:10.11.13", source: name, sourceVersion: "1:10.11.13" }));
    expect(componentPackages(systemComponent("mysql")!, installed)).toEqual([]);
    expect(componentPackages(systemComponent("mariadb")!, installed).map((p) => p.name)).toEqual(["mariadb-server", "mariadb-client", "mariadb-common"]);
  });
});
