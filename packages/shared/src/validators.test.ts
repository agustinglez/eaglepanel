import { describe, expect, test } from "bun:test";
import { docRootSchema, fqdnSchema, isPublishableDocRoot, usernameSchema } from "./validators";

describe("usernameSchema", () => {
  test.each(["acme", "cliente01", "abc"])("acepta %s", (value) => {
    expect(usernameSchema.safeParse(value).success).toBe(true);
  });

  test.each([
    "ab",
    "Acme",
    "1acme",
    "a_b_c",
    "root",
    "../../etc",
    "a;rm -rf /",
    "acme\n",
    "a".repeat(17),
    "",
  ])("rechaza %j", (value) => {
    expect(usernameSchema.safeParse(value).success).toBe(false);
  });
});

describe("docRootSchema", () => {
  test.each(["public_html", "subdomains/blog.example.com/public_html", ".well-known"])("acepta %s", (value) => {
    expect(docRootSchema.safeParse(value).success).toBe(true);
  });

  test.each(["", "/etc", "a/", "..", "a/../b", "a/..", ".", "a b", "a\nb", "a;b"])("rechaza %j", (value) => {
    expect(docRootSchema.safeParse(value).success).toBe(false);
  });
});

describe("fqdnSchema", () => {
  test.each(["example.com", "blog.example.com", "a-b.example.co.uk", "xn--bcher-kva.example"])("acepta %s", (value) => {
    expect(fqdnSchema.safeParse(value).success).toBe(true);
  });

  test.each([
    "localhost",
    "EXAMPLE.com",
    "../../etc",
    "example.com/",
    "-a.example.com",
    "a-.example.com",
    "a..example.com",
    "a;rm -rf /.com",
    "example.com\nmap evil",
    "1.2.3.4",
  ])("rechaza %j", (value) => {
    expect(fqdnSchema.safeParse(value).success).toBe(false);
  });
});

describe("isPublishableDocRoot", () => {
  test.each(["sites/example.com/public_html", "sites/example.com/public_html/web", "public_html", "otra"])("publica %s", (value) => {
    expect(isPublishableDocRoot(value)).toBe(true);
  });

  test.each(["sites", "sites/example.com", "sites/example.com/logs", "sites/example.com/logs/x", "logs", "tmp", "data/app"])("no publica %s", (value) => {
    expect(isPublishableDocRoot(value)).toBe(false);
  });
});
