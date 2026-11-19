import { describe, expect, test } from "bun:test";
import { systemComponent } from "@eaglepanel/shared";
import { cveQueryFor, fromNvd, fromOsv, osvEcosystem, toPackageDtos, upstreamVersion } from "./system-packages";

const pkg = (name: string, version: string, candidate: string | null = version, source = name) => ({ name, version, source, sourceVersion: version, candidate });

describe("system packages", () => {
  test("OSV ecosystem from the distribution", () => {
    expect(osvEcosystem({ id: "ubuntu", versionId: "24.04" })).toBe("Ubuntu:24.04:LTS");
    expect(osvEcosystem({ id: "ubuntu", versionId: "26.04" })).toBe("Ubuntu:26.04:LTS");
    expect(osvEcosystem({ id: "ubuntu", versionId: "25.10" })).toBe("Ubuntu:25.10");
    expect(osvEcosystem({ id: "debian", versionId: "12" })).toBe("Debian:12");
    expect(osvEcosystem({ id: "arch", versionId: "" })).toBeNull();
  });

  test("upstream version without epoch or packaging suffix", () => {
    expect(upstreamVersion("8.5.1-1+noble")).toBe("8.5.1");
    expect(upstreamVersion("1:2.43.0-1ubuntu7.3")).toBe("2.43.0");
    expect(upstreamVersion("8.4.6-1debian12")).toBe("8.4.6");
  });

  test("LiteSpeed and Oracle packages go to NVD; distribution ones to OSV", () => {
    const ecosystem = "Ubuntu:24.04:LTS";
    expect(cveQueryFor(systemComponent("php")!, { id: "php", packages: [pkg("lsphp85", "8.5.1-1+noble")], binaryVersion: null }, ecosystem))
      .toEqual({ kind: "nvd", cpe: "cpe:2.3:a:php:php", version: "8.5.1" });
    expect(cveQueryFor(systemComponent("mysql")!, { id: "mysql", packages: [pkg("mysql-community-server", "8.4.6-1debian12")], binaryVersion: null }, "Debian:12"))
      .toMatchObject({ kind: "nvd", version: "8.4.6" });
    expect(cveQueryFor(systemComponent("mysql")!, { id: "mysql", packages: [pkg("mysql-server", "8.0.43-0ubuntu0.24.04.1", null, "mysql-8.0")], binaryVersion: null }, ecosystem))
      .toMatchObject({ kind: "osv", ecosystem });
    expect(cveQueryFor(systemComponent("bun")!, { id: "bun", packages: [], binaryVersion: "1.4.4" }, ecosystem)).toBeNull();
  });

  test("an OSV record: CVE id, Ubuntu priority and the fixed version for this release", () => {
    const dto = fromOsv(
      {
        id: "UBUNTU-CVE-2025-1234",
        upstream: ["CVE-2025-1234"],
        details: "Buffer overflow",
        severity: [{ type: "Ubuntu", score: "medium" }],
        affected: [
          { package: { name: "openssl", ecosystem: "Ubuntu:14.04:LTS" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "1.0.1f-1ubuntu2.27+esm17" }] }] },
          { package: { name: "openssl", ecosystem: "Ubuntu:24.04:LTS" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "3.0.13-0ubuntu3.5" }] }] },
        ],
      },
      "openssl",
      "Ubuntu:24.04:LTS",
    );
    expect(dto).toEqual({ id: "CVE-2025-1234", summary: "Buffer overflow", severity: "medium", fixedIn: "3.0.13-0ubuntu3.5", fixReachable: null, url: "https://osv.dev/vulnerability/UBUNTU-CVE-2025-1234" });
  });

  test("an NVD record takes the newest CVSS severity", () => {
    const dto = fromNvd({
      cve: { id: "CVE-2025-9", descriptions: [{ lang: "en", value: "Bad" }], metrics: { cvssMetricV31: [{ cvssData: { baseSeverity: "HIGH" } }] } },
    });
    expect(dto).toMatchObject({ id: "CVE-2025-9", severity: "high", fixedIn: null });
  });

  test("pending updates, binaries managed by the installer, and components not installed left out", () => {
    const dtos = toPackageDtos(
      {
        os: { id: "ubuntu", versionId: "24.04" },
        components: [
          { id: "openlitespeed", packages: [pkg("openlitespeed", "1.8.3-1", "1.8.4-1")], binaryVersion: null },
          { id: "bun", packages: [], binaryVersion: "1.4.4" },
          { id: "vsftpd", packages: [], binaryVersion: null },
        ],
        refreshError: null,
      },
      () => [],
      () => null,
    );
    expect(dtos.map((d) => [d.id, d.version, d.available, d.managedBy])).toEqual([
      ["openlitespeed", "1.8.3-1", "1.8.4-1", "apt"],
      ["bun", "1.4.4", null, "installer"],
    ]);
  });
});

describe("Debian versions and fixes the mirror does not have yet", () => {
  test("dpkg order", async () => {
    const { compareDebianVersions: cmp } = await import("@eaglepanel/shared");
    expect(cmp("3.0.13-0ubuntu3.5", "3.0.13-0ubuntu3.11")).toBeLessThan(0);
    expect(cmp("1:2.0", "9.9")).toBeGreaterThan(0);
    expect(cmp("1.0~rc1-1", "1.0-1")).toBeLessThan(0);
    expect(cmp("8.0.43-0ubuntu0.24.04.1", "8.0.43-0ubuntu0.24.04.1")).toBe(0);
    expect(cmp("5:7.0.15-1ubuntu0.24.04.2", "5:7.0.15-1build2")).toBeGreaterThan(0);
  });

  test("a fix newer than what apt offers is marked as not reachable", () => {
    const vuln = (fixedIn: string | null) => ({ id: `CVE-${fixedIn}`, summary: null, severity: "high" as const, fixedIn, fixReachable: null, url: "" });
    const [openssl] = toPackageDtos(
      { os: { id: "ubuntu", versionId: "24.04" }, components: [{ id: "openssl", packages: [pkg("openssl", "3.0.13-0ubuntu3.4", "3.0.13-0ubuntu3.5")], binaryVersion: null }], refreshError: null },
      () => [vuln("3.0.13-0ubuntu3.5"), vuln("3.0.13-0ubuntu3.11"), vuln(null)],
      () => "osv",
    );
    expect(openssl!.vulnerabilities.map((v) => v.fixReachable)).toEqual([true, false, null]);
  });
});
