import { describe, expect, test } from "bun:test";
import { systemComponent } from "@eaglepanel/shared";
import { componentPackages, parseAptPolicy, parseDpkgList } from "./packages";

describe("system packages", () => {
  test("dpkg-query: only installed packages, with the source package when it differs", () => {
    const list = parseDpkgList(
      [
        "lsphp85\t8.5.1-1+noble\t\t\tii ",
        "mysql-server-8.0\t8.0.43-0ubuntu0.24.04.1\tmysql-8.0\t8.0.43-0ubuntu0.24.04.1\tii ",
        "vsftpd\t3.0.5-0ubuntu3\t\t\trc ",
      ].join("\n"),
    );
    expect(list).toEqual([
      { name: "lsphp85", version: "8.5.1-1+noble", source: "lsphp85", sourceVersion: "8.5.1-1+noble" },
      { name: "mysql-server-8.0", version: "8.0.43-0ubuntu0.24.04.1", source: "mysql-8.0", sourceVersion: "8.0.43-0ubuntu0.24.04.1" },
    ]);
  });

  test("apt-cache policy: candidate of each package, null when apt does not know it", () => {
    const policy = parseAptPolicy(
      [
        "openlitespeed:",
        "  Installed: 1.8.3-1+noble",
        "  Candidate: 1.8.4-1+noble",
        "  Version table:",
        " *** 1.8.3-1+noble 100",
        "libssl3t64:amd64:",
        "  Installed: 3.0.13-0ubuntu3.4",
        "  Candidate: 3.0.13-0ubuntu3.5",
        "restic:",
        "  Installed: (none)",
        "  Candidate: (none)",
      ].join("\n"),
    );
    expect(policy.get("openlitespeed")).toBe("1.8.4-1+noble");
    expect(policy.get("libssl3t64")).toBe("3.0.13-0ubuntu3.5");
    expect(policy.get("restic")).toBeNull();
  });

  test("a component takes its packages in the order of its patterns", () => {
    const installed = ["lsphp85-redis", "lsphp83", "lsphp85", "lsphp85-common"].map((name) => ({ name, version: "1", source: name, sourceVersion: "1" }));
    expect(componentPackages(systemComponent("php")!, installed).map((p) => p.name)).toEqual(["lsphp85", "lsphp85-redis", "lsphp85-common"]);
  });
});
