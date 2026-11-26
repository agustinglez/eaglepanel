import { describe, expect, test } from "bun:test";
import type { DbStructureDto } from "@eaglepanel/shared";
import { addColumnSql, addIndexSql, changeColumnSql, columnDefinition, columnSpecOf, createTableSql, dropIndexSql, emptyColumn, insertRowSql, quoteLiteral, quoteName, rowKey, updateRowSql } from "./sql";

describe("quoting", () => {
  test("names and literals cannot be closed from inside", () => {
    expect(quoteName("a`b")).toBe("`a``b`");
    expect(quoteLiteral("it's \\ ok")).toBe("'it''s \\\\ ok'");
  });
});

describe("table forms", () => {
  test("column definitions", () => {
    expect(columnDefinition({ ...emptyColumn(), name: "id", type: "bigint unsigned", nullable: false, autoIncrement: true })).toBe("`id` bigint unsigned NOT NULL AUTO_INCREMENT");
    expect(columnDefinition({ ...emptyColumn(), name: "title", defaultMode: "value", defaultValue: "O'Brien", comment: "x" })).toBe("`title` varchar(255) NULL DEFAULT 'O''Brien' COMMENT 'x'");
    expect(columnDefinition({ ...emptyColumn(), name: "at", type: "datetime", nullable: false, defaultMode: "expression", defaultValue: "CURRENT_TIMESTAMP", onUpdateNow: true })).toBe("`at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
    expect(columnDefinition({ ...emptyColumn(), name: "uuid", type: "char(36)", defaultMode: "expression", defaultValue: "uuid()" })).toBe("`uuid` char(36) NULL DEFAULT (uuid())");
  });

  test("create, add, change, indexes", () => {
    const id = { ...emptyColumn(), name: "id", type: "int", nullable: false };
    expect(createTableSql("posts", [id], ["id"], "")).toBe("CREATE TABLE `posts` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB");
    expect(addColumnSql("posts", { ...emptyColumn(), name: "t" }, { kind: "after", column: "id" })).toBe("ALTER TABLE `posts` ADD COLUMN `t` varchar(255) NULL AFTER `id`");
    expect(changeColumnSql("posts", "t", { ...emptyColumn(), name: "title", type: "text" })).toBe("ALTER TABLE `posts` CHANGE COLUMN `t` `title` text NULL");
    expect(addIndexSql("posts", "UNIQUE", "posts_slug", ["slug", "lang"])).toBe("ALTER TABLE `posts` ADD UNIQUE INDEX `posts_slug` (`slug`, `lang`)");
    expect(addIndexSql("posts", "PRIMARY", "", ["id"])).toBe("ALTER TABLE `posts` ADD PRIMARY KEY (`id`)");
    expect(dropIndexSql("posts", "PRIMARY")).toBe("ALTER TABLE `posts` DROP PRIMARY KEY");
  });

  test("a column read from information_schema round-trips", () => {
    const spec = columnSpecOf({ name: "at", type: "timestamp", nullable: false, default: "CURRENT_TIMESTAMP", key: "", extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP", comment: "" });
    expect(columnDefinition(spec)).toBe("`at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
    expect(columnSpecOf({ name: "n", type: "int", nullable: true, default: null, key: "", extra: "", comment: "" }).defaultMode).toBe("null");
  });
});

describe("rows", () => {
  const structure = (indexes: DbStructureDto["indexes"], nullable = false): DbStructureDto => ({
    kind: "table",
    createSql: "",
    columns: [
      { name: "id", type: "int", nullable, default: null, key: "", extra: "", comment: "" },
      { name: "slug", type: "varchar(20)", nullable: false, default: null, key: "", extra: "", comment: "" },
    ],
    indexes,
  });

  test("the key is the primary key, or a unique index of NOT NULL columns", () => {
    expect(rowKey(structure([{ name: "PRIMARY", unique: true, type: "BTREE", columns: ["id"] }]))).toEqual(["id"]);
    expect(rowKey(structure([{ name: "u", unique: true, type: "BTREE", columns: ["slug"] }]))).toEqual(["slug"]);
    expect(rowKey(structure([{ name: "u", unique: true, type: "BTREE", columns: ["id"] }], true))).toBeNull();
    expect(rowKey(structure([{ name: "i", unique: false, type: "BTREE", columns: ["id"] }]))).toBeNull();
  });

  test("values always go as parameters; NULL is written, not sent", () => {
    expect(updateRowSql("t", [{ column: "a", value: "x'); DROP" }, { column: "b", value: null }], ["id"])).toEqual({ sql: "UPDATE `t` SET `a` = ?, `b` = NULL WHERE `id` = ? LIMIT 1", params: ["x'); DROP"] });
    expect(insertRowSql("t", [{ column: "a", value: "1" }, { column: "b", value: null }])).toEqual({ sql: "INSERT INTO `t` (`a`, `b`) VALUES (?, NULL)", params: ["1"] });
    expect(insertRowSql("t", [])).toEqual({ sql: "INSERT INTO `t` () VALUES ()", params: [] });
  });
});
