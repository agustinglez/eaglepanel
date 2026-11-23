import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headerField, isMultisite, parseWpVersion, scanAccount } from "./wordpress";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function put(root: string, rel: string, content: string) {
  const path = join(root, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function fakeWordPress(home: string, rel: string, version: string) {
  await put(home, `${rel}/wp-includes/version.php`, `<?php\n/**\n * WordPress Version\n */\n$wp_version = '${version}';\n$wp_db_version = 58975;\n`);
  await put(home, `${rel}/wp-config.php`, "<?php\ndefine( 'DB_NAME', 'x' );\n");
}

describe("WordPress scan", () => {
  test("headers as WordPress reads them", () => {
    const head = "<?php\n/**\n * Plugin Name: Akismet Anti-spam\n * Version: 5.3.1\n * Requires PHP: 7.2\n */";
    expect(headerField(head, "Plugin Name")).toBe("Akismet Anti-spam");
    expect(headerField(head, "Version")).toBe("5.3.1");
    expect(headerField("/*\nTheme Name: Twenty Twenty-Five\r\nVersion: 1.2 */", "Version")).toBe("1.2");
    expect(headerField("<?php // nothing", "Plugin Name")).toBe("");
    expect(parseWpVersion("$wp_version = \"6.8.1\";")).toBe("6.8.1");
    expect(isMultisite("define( 'MULTISITE', true );")).toBe(true);
    expect(isMultisite("define('MULTISITE', false);")).toBe(false);
  });

  test("finds core, plugins and themes, also in a subdirectory, without following links", async () => {
    const home = await mkdtemp(join(tmpdir(), "ep-wp-"));
    dirs.push(home);
    const root = "sites/acme/public_html";
    await fakeWordPress(home, root, "6.8.1");
    await put(home, `${root}/wp-content/plugins/akismet/akismet.php`, "<?php\n/*\nPlugin Name: Akismet\nVersion: 5.3.1\n*/");
    await put(home, `${root}/wp-content/plugins/akismet/class.akismet.php`, "<?php class Akismet {}");
    await put(home, `${root}/wp-content/plugins/woo/main.php`, "<?php\n/**\n * Plugin Name: Woo\n * Version: 9.0.0\n */");
    await put(home, `${root}/wp-content/plugins/hello.php`, "<?php\n/*\nPlugin Name: Hello Dolly\nVersion: 1.7.2\n*/");
    await put(home, `${root}/wp-content/plugins/index.php`, "<?php // Silence is golden.");
    await put(home, `${root}/wp-content/plugins/empty/readme.txt`, "nothing");
    await put(home, `${root}/wp-content/themes/twentytwentyfive/style.css`, "/*\nTheme Name: Twenty Twenty-Five\nVersion: 1.2\n*/");
    // A WordPress inside another one's directory is not searched for.
    await fakeWordPress(home, `${root}/blog`, "6.4.3");

    const installs = await scanAccount(home, [{ username: "acme", vhost: 7, docRoot: root }]);
    expect(installs.map((i) => [i.path, i.version])).toEqual([[root, "6.8.1"]]);
    const main = installs[0]!;
    expect(main.vhost).toBe(7);
    expect(main.multisite).toBe(false);
    expect(main.plugins).toEqual([
      { slug: "akismet", name: "Akismet", version: "5.3.1" },
      { slug: "hello-dolly", name: "Hello Dolly", version: "1.7.2" },
      { slug: "woo", name: "Woo", version: "9.0.0" },
    ]);
    expect(main.themes).toEqual([{ slug: "twentytwentyfive", name: "Twenty Twenty-Five", version: "1.2" }]);

    // Without WordPress at the root, a subdirectory up to two levels below is found.
    const other = await mkdtemp(join(tmpdir(), "ep-wp-"));
    dirs.push(other);
    await put(other, "sites/b/public_html/index.html", "hi");
    await fakeWordPress(other, "sites/b/public_html/blog", "6.4.3");
    await fakeWordPress(other, "sites/b/public_html/a/b/c", "6.0");
    // A link to another directory is not followed ("junction" is ignored outside Windows).
    await fakeWordPress(other, "elsewhere/wp", "5.0");
    await symlink(join(other, "elsewhere"), join(other, "sites/b/public_html/linked"), "junction");
    const found = await scanAccount(other, [{ username: "b", vhost: 1, docRoot: "sites/b/public_html" }]);
    expect(found.map((i) => i.path)).toEqual(["sites/b/public_html/blog"]);
  });
});
