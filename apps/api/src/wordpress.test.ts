import { describe, expect, test } from "bun:test";
import { compareWpVersions, coreStatus, extensionDto, fetchFeed, indexRecord, matchVulnerabilities, streamRecords, toInstallDto, type WfIndex } from "./wordpress";

const record = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Vulnerability ${id}`,
  informational: false,
  published: "2026-01-01 00:00:00",
  cve: `CVE-2026-${id}`,
  cvss: { score: 8.1, rating: "High" },
  references: [`https://www.wordfence.com/threat-intel/vulnerabilities/wordpress-plugins/x/${id}`],
  software: [
    {
      type: "plugin",
      slug: "contact-form-7",
      affected_versions: { "* - 5.8.3": { from_version: "*", from_inclusive: true, to_version: "5.8.3", to_inclusive: true } },
      patched: true,
      patched_versions: ["5.8.4", "6.0"],
    },
  ],
  ...over,
});

function buildIndex(records: unknown[]): WfIndex {
  const index: WfIndex = { bySoftware: {}, updatedAt: 1, records: 0 };
  for (const r of records) indexRecord(index, r as never);
  return index;
}

async function* chunked(text: string, size: number) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

describe("WordPress monitor", () => {
  test("versions compared like PHP version_compare", () => {
    expect(compareWpVersions("1.0", "1.0.1")).toBe(-1);
    expect(compareWpVersions("1.0", "1.0.0")).toBe(0);
    expect(compareWpVersions("1.0-beta", "1.0")).toBe(-1);
    expect(compareWpVersions("1.0RC1", "1.0")).toBe(-1);
    expect(compareWpVersions("1.0RC1", "1.0beta2")).toBe(1);
    expect(compareWpVersions("5.10", "5.9.9")).toBe(1);
    expect(compareWpVersions("6.8.1", "6.8.1")).toBe(0);
  });

  test("the feed is read record by record, whatever the chunk size", async () => {
    const feed = JSON.stringify({ a: record("0001", { title: 'Quote " and } brace { inside' }), b: record("0002"), c: { id: "c", nested: [{ x: "]" }] } });
    for (const size of [1, 7, 64, feed.length]) {
      const ids: string[] = [];
      for await (const r of streamRecords(chunked(feed, size))) ids.push((r as { id: string }).id);
      expect(ids).toEqual(["0001", "0002", "c"]);
    }
  });

  test("ranges, informational records and the first patched version", () => {
    const index = buildIndex([
      record("0001"),
      record("0002", { informational: true }),
      record("0003", { published: null }),
      record("0004", {
        cve: null,
        cvss: { score: 9.8, rating: "Critical" },
        software: [{ type: "plugin", slug: "contact-form-7", affected_versions: { "(5.0, 5.5]": { from_version: "5.0", from_inclusive: false, to_version: "5.5", to_inclusive: true } }, patched_versions: [] }],
      }),
      record("0005", { software: [{ type: "core", slug: "wordpress", affected_versions: { "6.0 - 6.4.2": { from_version: "6.0", from_inclusive: true, to_version: "6.4.2", to_inclusive: true } }, patched_versions: ["6.4.3"] }] }),
    ]);
    expect(index.records).toBe(3);

    const vulns = matchVulnerabilities(index, "plugin:contact-form-7", "5.2");
    expect(vulns.map((v) => [v.id, v.severity, v.fixedIn])).toEqual([
      ["WF-0004", "critical", null],
      ["CVE-2026-0001", "high", "5.8.4"],
    ]);
    expect(vulns[1]!.url).toContain("wordfence.com");
    // Lower bound excluded, upper bound included.
    expect(matchVulnerabilities(index, "plugin:contact-form-7", "5.0").map((v) => v.id)).toEqual(["CVE-2026-0001"]);
    expect(matchVulnerabilities(index, "plugin:contact-form-7", "5.8.4")).toEqual([]);
    expect(matchVulnerabilities(index, "core:wordpress", "6.4.2").map((v) => v.fixedIn)).toEqual(["6.4.3"]);
    expect(matchVulnerabilities(null, "core:wordpress", "6.4.2")).toEqual([]);
  });

  test("the feed is downloaded with the key; a rejected key or a 429 is an error", async () => {
    let status = 200;
    const sent: Record<string, string>[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      return status === 200 ? new Response(JSON.stringify({ a: record("0001"), b: record("0002") })) : new Response("{}", { status });
    }) as unknown as typeof fetch;

    const index = await fetchFeed("key-0123456789abcdef", fetcher);
    expect(index.records).toBe(2);
    expect(sent[0]!.authorization).toBe("Bearer key-0123456789abcdef");
    status = 429;
    await expect(fetchFeed("key-0123456789abcdef", fetcher)).rejects.toThrow("(429)");
    status = 401;
    await expect(fetchFeed("key-0123456789abcdef", fetcher)).rejects.toThrow("rejected the API key");
  });

  test("core and extension status against WordPress.org", () => {
    const core = { latest: "7.1.5", releases: { "7.1.5": "latest", "7.0.9": "outdated", "6.0": "insecure" } };
    expect(coreStatus("7.1.5", core)).toBe("latest");
    expect(coreStatus("6.0", core)).toBe("insecure");
    expect(coreStatus("7.0.2", core)).toBe("outdated");
    expect(coreStatus("7.2-beta1", core)).toBe("latest");
    expect(coreStatus("7.1.5", null)).toBe("unknown");

    const ext = { slug: "akismet", name: "Akismet", version: "5.3" };
    expect(extensionDto("plugin", ext, { found: true, latest: "5.7.2" }, null)).toMatchObject({ status: "outdated", latest: "5.7.2" });
    expect(extensionDto("plugin", { ...ext, version: "5.7.2" }, { found: true, latest: "5.7.2" }, null)).toMatchObject({ status: "up-to-date" });
    expect(extensionDto("plugin", ext, { found: false, closed: true, reason: "Security Issue" }, null)).toMatchObject({ status: "closed", closedReason: "Security Issue" });
    expect(extensionDto("plugin", ext, { found: false, closed: false, reason: null }, null)).toMatchObject({ status: "unknown", latest: null });
    expect(extensionDto("theme", ext, undefined, null)).toMatchObject({ status: "unknown" });
  });

  test("an installation as the panel shows it", () => {
    const vhost = { id: 3, username: "acme", slug: "acme", name: "Acme", hostname: "acme.com", docRoot: "sites/acme/public_html" };
    const install = {
      username: "acme",
      vhost: 3,
      path: "sites/acme/public_html/blog",
      version: "6.4.2",
      multisite: false,
      plugins: [{ slug: "contact-form-7", name: "Contact Form 7", version: "5.2" }],
      themes: [],
    };
    const index = buildIndex([record("0001")]);
    const dto = toInstallDto(install, vhost, { latest: "7.1.5", releases: {} }, new Map([["plugin:contact-form-7", { found: true, latest: "6.1" }]]), index);
    expect(dto).toMatchObject({ id: "3:sites/acme/public_html/blog", urlPath: "/blog", coreStatus: "outdated", latest: "7.1.5", hostname: "acme.com" });
    expect(dto.plugins[0]).toMatchObject({ status: "outdated", latest: "6.1" });
    expect(dto.plugins[0]!.vulnerabilities.map((v) => v.id)).toEqual(["CVE-2026-0001"]);
    expect(toInstallDto({ ...install, path: vhost.docRoot }, vhost, null, new Map(), null).urlPath).toBe("/");
  });
});
