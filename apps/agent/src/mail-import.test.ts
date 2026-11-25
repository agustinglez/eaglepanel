import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxHost } from "./host";
import {
  decodeMutf7,
  folderPath,
  homePath,
  ImapClient,
  importFromBackup,
  importFromImap,
  locateDomainMail,
  maildirFolders,
  maildirMessages,
  messageIdOf,
  parseCpanelEtc,
  parseInternalDate,
  parseTokens,
  roleOf,
  scanBackup,
  type MailboxSink,
  type SourceFolder,
  type SourceMessage,
} from "./mail-import";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "mail-import-"));
  roots.push(root);
  return root;
};

// Windows does not allow ":" in a file name: there the test uses "!", the other separator Dovecot accepts.
const S = process.platform === "win32" ? "!" : ":";
const message = (id: string, subject: string) => `Message-ID: <${id}@old.test>\r\nSubject: ${subject}\r\n\r\nBody of ${subject}\r\n`;

function put(dir: string, sub: "cur" | "new", file: string, content: string, when = new Date("2024-03-01T10:00:00Z")) {
  mkdirSync(join(dir, sub), { recursive: true });
  mkdirSync(join(dir, "tmp"), { recursive: true });
  writeFileSync(join(dir, sub, file), content);
  utimesSync(join(dir, sub, file), when, when);
}

/** A cPanel home: mail/<domain>/<user> in Maildir++, and etc/<domain> with the hashes and quotas. */
function cpanelHome(root: string) {
  const box = join(root, "homedir", "mail", "example.com", "info");
  put(box, "cur", `1700000001.M1.host${S}2,S`, message("a", "Read"));
  put(box, "new", "1700000002.M2.host", message("b", "Unread"));
  put(box, "cur", `1700000003.M3.host${S}2,ST`, message("c", "Deleted"));
  put(join(box, ".Sent"), "cur", `1700000004.M4.host${S}2,S`, message("d", "Sent one"));
  put(join(box, ".Clientes.Env&AO0-os"), "cur", `1700000005.M5.host${S}2,FS`, message("e", "Nested"));
  put(join(root, "homedir", "mail", "example.com", "ventas"), "cur", `1700000006.M6.host${S}2,`, message("f", "Ventas"));
  mkdirSync(join(root, "homedir", "etc", "example.com"), { recursive: true });
  writeFileSync(join(root, "homedir", "etc", "example.com", "shadow"), "info:$6$salt$abcdefghijklmnop:19000::::::\nventas:*LOCKED*:19000::::::\n");
  writeFileSync(join(root, "homedir", "etc", "example.com", "quota"), "info:524288000\nventas:0\n");
  return box;
}

/** Keeps what it gets, by folder, and knows what is already in each one. */
function fakeSink() {
  const stored = new Map<string, SourceMessage[]>();
  const sink: MailboxSink = {
    maxUpload: 1_000_000,
    async mailboxFor(folder: SourceFolder) {
      return folder.role ?? (folder.path.length === 0 ? "inbox" : folder.path.join("/"));
    },
    async existing(mailboxId) {
      return new Set((stored.get(mailboxId) ?? []).map((item) => `id:${messageIdOf(item.raw)}`));
    },
    async add(mailboxId, messages) {
      stored.set(mailboxId, [...(stored.get(mailboxId) ?? []), ...messages]);
      return messages.length;
    },
  };
  return { sink, stored };
}

describe("names and folders", () => {
  test("modified UTF-7, INBOX prefix and special folders", () => {
    expect(decodeMutf7("Env&AO0-os")).toBe("Envíos");
    expect(decodeMutf7("A&-B")).toBe("A&B");
    expect(folderPath("INBOX.Sent", ".")).toEqual(["Sent"]);
    expect(folderPath("INBOX", ".")).toEqual([]);
    expect(folderPath("Clientes/Env&AO0-os", "/")).toEqual(["Clientes", "Envíos"]);
    expect(roleOf(["Sent"])).toBe("sent");
    expect(roleOf(["Papelera"])).toBe("trash");
    expect(roleOf(["Clientes", "Sent"])).toBeNull();
    expect(roleOf(["Mis enviados"], ["\\HasNoChildren", "\\Sent"])).toBe("sent");
  });

  test("Maildir++: inbox first, subfolders by name, deleted messages left out, flags as keywords", async () => {
    const box = cpanelHome(tempRoot());
    const folders = await maildirFolders(box);
    expect(folders.map(({ path, role }) => `${path.join("/")}:${role}`)).toEqual([":null", "Clientes/Envíos:null", "Sent:sent"]);
    const inbox = await maildirMessages(box);
    expect(inbox.map(({ keywords }) => keywords)).toEqual([["$seen"], []]);
    expect(inbox[0]!.mtime.toISOString()).toBe("2024-03-01T10:00:00.000Z");
  });

  test("cPanel etc: hashes it can use and quotas (0 is unlimited)", () => {
    const etc = parseCpanelEtc("info:$6$salt$abc:1\nventas:*LOCKED*:1\nbad name:$6$x$y\n", "info:1048576\nventas:0\n");
    expect(etc.get("info")).toEqual({ hash: "$6$salt$abc", quotaBytes: 1048576 });
    expect(etc.get("ventas")).toEqual({ hash: null, quotaBytes: null });
    expect(etc.has("bad name")).toBe(false);
  });

  test("finds mail/<domain> anywhere in the backup, and only inside the home", async () => {
    const root = tempRoot();
    cpanelHome(join(root, "backup-1.1.2026_user"));
    const found = await locateDomainMail(root, "example.com");
    expect(found?.mail).toBe(join(root, "backup-1.1.2026_user", "homedir", "mail", "example.com"));
    expect(found?.etc).toBe(join(root, "backup-1.1.2026_user", "homedir", "etc", "example.com"));
    expect(await locateDomainMail(root, "other.com")).toBeNull();
    // Only the mail folder, uploaded on its own (and its etc next to it, or not).
    const alone = tempRoot();
    mkdirSync(join(alone, "mail", "example.com", "info", "cur"), { recursive: true });
    expect(await locateDomainMail(join(alone, "mail"), "example.com")).toEqual({ mail: join(alone, "mail", "example.com"), etc: null });
    mkdirSync(join(alone, "etc", "example.com"), { recursive: true });
    expect(await locateDomainMail(alone, "example.com")).toEqual({ mail: join(alone, "mail", "example.com"), etc: join(alone, "etc", "example.com") });
    expect(homePath("acme", "backups/x.tar.gz")).toBe("/home/acme/backups/x.tar.gz");
    expect(() => homePath("acme", "../other/x")).toThrow();
  });

  test("Message-ID, also folded over two lines", () => {
    expect(messageIdOf(new TextEncoder().encode("Subject: x\r\nMessage-ID:\r\n <abc@host>\r\n\r\nbody"))).toBe("abc@host");
    expect(messageIdOf(new TextEncoder().encode("Subject: x\r\n\r\nMessage-ID: <no@body>"))).toBeNull();
  });
});

describe("from a backup", () => {
  test("reads a folder in the account, lists its mailboxes, and imports without duplicating", async () => {
    const root = tempRoot();
    const host = new SandboxHost(root);
    cpanelHome(join(root, "home", "acme", "old"));
    const mailboxes = await scanBackup(host, { username: "acme", path: "old", domain: "example.com", importId: "a".repeat(32) });
    expect(mailboxes).toEqual([
      { name: "info", messages: 4, bytes: expect.any(Number), quotaBytes: 524288000, passwordHash: true },
      { name: "ventas", messages: 1, bytes: expect.any(Number), quotaBytes: null, passwordHash: false },
    ]);

    const { sink, stored } = fakeSink();
    const run = () => importFromBackup(host, sink, { importId: "a".repeat(32), domain: "example.com", name: "info", cursor: { folder: 0, position: 0 } });
    expect(await run()).toMatchObject({ done: true, imported: 4, skipped: 0 });
    expect([...stored.keys()].sort()).toEqual(["Clientes/Envíos", "inbox", "sent"]);
    expect(stored.get("Clientes/Envíos")![0]!.keywords).toEqual(["$flagged", "$seen"]);
    // A second run (the last pass after changing the MX) adds nothing.
    expect(await run()).toMatchObject({ done: true, imported: 0, skipped: 4 });
  });

  test("a backup read for another domain is refused", async () => {
    const root = tempRoot();
    const host = new SandboxHost(root);
    cpanelHome(join(root, "home", "acme", "old"));
    await scanBackup(host, { username: "acme", path: "old", domain: "example.com", importId: "b".repeat(32) });
    await expect(importFromBackup(host, fakeSink().sink, { importId: "b".repeat(32), domain: "other.com", name: "info", cursor: { folder: 0, position: 0 } })).rejects.toThrow("another domain");
  });

  test("without mail of the domain it says where it looked", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "home", "acme", "empty"), { recursive: true });
    await expect(scanBackup(new SandboxHost(root), { username: "acme", path: "empty", domain: "example.com", importId: "c".repeat(32) })).rejects.toThrow("mail/example.com");
  });
});

describe("IMAP", () => {
  test("tokens: lists, quoted strings, literals and BODY[]", () => {
    const [list] = parseTokens("(UID 7 FLAGS (\\Seen $Forwarded) INTERNALDATE \"17-Jul-1996 02:44:25 -0700\" BODY[] \u00000\u0000)", [Buffer.from("raw")]);
    expect(list).toEqual(["UID", "7", "FLAGS", ["\\Seen", "$Forwarded"], "INTERNALDATE", "17-Jul-1996 02:44:25 -0700", "BODY[]", Buffer.from("raw")]);
    expect(parseInternalDate("17-Jul-1996 02:44:25 -0700")?.toISOString()).toBe("1996-07-17T09:44:25.000Z");
  });

  /** A small IMAP server: two folders, one message marked deleted. */
  function fakeImap(): Promise<{ port: number; close: () => void; logins: string[] }> {
    const folders: Record<string, { uid: number; flags: string; body: string }[]> = {
      INBOX: [{ uid: 3, flags: "\\Seen", body: message("i1", "One") }, { uid: 5, flags: "", body: message("i2", "Two") }, { uid: 6, flags: "\\Deleted", body: message("i3", "Gone") }],
      "INBOX.Sent": [{ uid: 1, flags: "\\Seen \\Answered", body: message("s1", "Sent") }],
    };
    const logins: string[] = [];
    const server = createServer((socket: Socket) => {
      let selected = "INBOX";
      let pending = "";
      socket.write("* OK fake IMAP ready\r\n");
      socket.on("data", (chunk) => {
        pending += chunk.toString();
        let end: number;
        while ((end = pending.indexOf("\r\n")) !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const [tag, command, ...rest] = line.split(" ");
          const args = rest.join(" ");
          if (command === "LOGIN") {
            logins.push(args);
            socket.write(args.includes("\"wrong\"") ? `${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n` : `${tag} OK Logged in\r\n`);
          } else if (command === "LIST") {
            socket.write("* LIST (\\HasChildren) \".\" INBOX\r\n* LIST (\\HasNoChildren \\Sent) \".\" \"INBOX.Sent\"\r\n* LIST (\\Noselect) \".\" \"Shared\"\r\n" + `${tag} OK List completed\r\n`);
          } else if (command === "EXAMINE") {
            selected = args.replace(/"/g, "");
            socket.write(`${tag} OK [READ-ONLY] Examine completed\r\n`);
          } else if (command === "UID" && args.startsWith("FETCH")) {
            const [, set, ...items] = args.split(" ");
            const wantBody = items.join(" ").includes("BODY.PEEK[]");
            const all = folders[selected] ?? [];
            const chosen = set!.includes(":")
              ? (() => { const start = Number(set!.split(":")[0]); const after = all.filter((m) => m.uid >= start); return after.length > 0 ? after : all.slice(-1); })()
              : all.filter((m) => set!.split(",").map(Number).includes(m.uid));
            for (const [index, item] of chosen.entries()) {
              socket.write(wantBody
                ? `* ${index + 1} FETCH (UID ${item.uid} BODY[] {${Buffer.byteLength(item.body)}}\r\n${item.body})\r\n`
                : `* ${index + 1} FETCH (UID ${item.uid} FLAGS (${item.flags}) INTERNALDATE "01-Mar-2024 10:00:00 +0000" RFC822.SIZE ${Buffer.byteLength(item.body)})\r\n`);
            }
            socket.write(`${tag} OK Fetch completed\r\n`);
          } else if (command === "LOGOUT") {
            socket.write(`* BYE\r\n${tag} OK Logout\r\n`);
            socket.end();
          } else {
            socket.write(`${tag} BAD unknown\r\n`);
          }
        }
      });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ port: address.port, close: () => server.close(), logins });
    }));
  }

  const plain = (port: number) => (options: { host: string; port: number; verify: boolean }) =>
    ImapClient.connect({ ...options, socket: connect(port, "127.0.0.1") });

  test("copies every folder (not the deleted message) and a second run adds nothing", async () => {
    const server = await fakeImap();
    try {
      const { sink, stored } = fakeSink();
      const source = { host: "old.test", port: 993, user: "info@example.com", password: "pa\"ss", verify: true };
      const first = await importFromImap(sink, source, { folder: 0, position: 0 }, plain(server.port));
      expect(first).toMatchObject({ done: true, imported: 3, skipped: 0 });
      expect(server.logins[0]).toBe("\"info@example.com\" \"pa\\\"ss\"");
      expect(stored.get("inbox")!.map((item) => item.keywords)).toEqual([["$seen"], []]);
      expect(stored.get("sent")!.map((item) => item.keywords)).toEqual([["$seen", "$answered"]]);
      expect(stored.get("inbox")![0]!.receivedAt.toISOString()).toBe("2024-03-01T10:00:00.000Z");
      const second = await importFromImap(sink, source, { folder: 0, position: 0 }, plain(server.port));
      expect(second).toMatchObject({ done: true, imported: 0, skipped: 3 });
    } finally {
      server.close();
    }
  });

  test("a wrong password says so", async () => {
    const server = await fakeImap();
    try {
      await expect(importFromImap(fakeSink().sink, { host: "old.test", port: 993, user: "info", password: "wrong", verify: true }, { folder: 0, position: 0 }, plain(server.port)))
        .rejects.toThrow("rejected the user or password");
    } finally {
      server.close();
    }
  });
});
