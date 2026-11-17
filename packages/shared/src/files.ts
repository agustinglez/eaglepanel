import { z } from "zod";

/**
 * File manager: everything is relative to the account home directory, the same one it sees over FTP. Operations
 * are run by a process as the account user, so the kernel enforces its permissions and quota; these format rules
 * are the first barrier, not the only one.
 */

const segment = z.string().min(1).max(255).refine((value) => value !== "." && value !== ".." && !/[/\0]/.test(value), "Invalid name")
  .refine((value) => new TextEncoder().encode(value).length <= 255, "The name is too long");

/** Name of a file or directory, without slashes. */
export const fileNameSchema = segment;

/** Path relative to the home directory. `""` is the home directory itself. */
export const filePathSchema = z.string().max(4096).refine((value) =>
  value === "" || (!value.startsWith("/") && !value.endsWith("/") && value.split("/").every((part) => segment.safeParse(part).success)), "Invalid path");

/** No special bits: setuid or sticky make no sense on hosting. */
export const fileModeSchema = z.string().regex(/^[0-7]{3}$/, "Invalid permissions: three digits, such as 644");

export const archiveFormatSchema = z.enum(["zip", "tar.gz"]);
export type ArchiveFormat = z.infer<typeof archiveFormatSchema>;

/** What can be opened in the editor. Anything larger is for downloading. */
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
/** Cap per uploaded file: the account quota still applies. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
/** A directory with more entries is shown truncated: the browser cannot handle a hundred thousand rows. */
export const MAX_LIST_ENTRIES = 5000;

export const fileEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["file", "dir", "link", "other"]),
  size: z.number(),
  mode: z.string(),
  mtimeMs: z.number(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

const paths = z.array(filePathSchema.refine((value) => value !== "", "The home directory itself cannot be modified")).min(1).max(1000);

/** Requests to the account process. Uploads and downloads go separately, as streams. */
export const fileRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list"), path: filePathSchema }).strict(),
  z.object({ op: z.literal("stat"), path: filePathSchema }).strict(),
  z.object({ op: z.literal("read"), path: filePathSchema }).strict(),
  /** `mtimeMs` is the one it had when opened: if it changed since then, it is not overwritten. `null` creates a new one. */
  z.object({ op: z.literal("write"), path: filePathSchema, content: z.string().max(MAX_EDIT_BYTES), mtimeMs: z.number().nullable() }).strict(),
  z.object({ op: z.literal("mkdir"), path: filePathSchema }).strict(),
  z.object({ op: z.literal("rename"), from: filePathSchema, to: filePathSchema }).strict(),
  z.object({ op: z.literal("copy"), paths, to: filePathSchema }).strict(),
  z.object({ op: z.literal("move"), paths, to: filePathSchema }).strict(),
  z.object({ op: z.literal("delete"), paths }).strict(),
  z.object({ op: z.literal("chmod"), paths, mode: fileModeSchema }).strict(),
  z.object({ op: z.literal("extract"), path: filePathSchema, to: filePathSchema }).strict(),
  /** All in the same directory, which is where the archive ends up. */
  z.object({ op: z.literal("compress"), paths, name: fileNameSchema, format: archiveFormatSchema }).strict(),
]);
export type FileRequest = z.infer<typeof fileRequestSchema>;

export const fileListSchema = z.object({ entries: z.array(fileEntrySchema), truncated: z.boolean() });
export const fileTextSchema = z.object({ content: z.string(), mtimeMs: z.number(), size: z.number() });

/** What each operation returns. */
export const fileResultSchemas = {
  list: fileListSchema,
  stat: fileEntrySchema,
  read: fileTextSchema,
  write: z.object({ mtimeMs: z.number() }),
  mkdir: z.object({ ok: z.literal(true) }),
  rename: z.object({ ok: z.literal(true) }),
  copy: z.object({ ok: z.literal(true) }),
  move: z.object({ ok: z.literal(true) }),
  delete: z.object({ ok: z.literal(true) }),
  chmod: z.object({ ok: z.literal(true) }),
  extract: z.object({ ok: z.literal(true) }),
  compress: z.object({ ok: z.literal(true) }),
} satisfies Record<FileRequest["op"], z.ZodType>;
export type FileResult<O extends FileRequest["op"]> = z.infer<(typeof fileResultSchemas)[O]>;

export const isArchive = (name: string) => /\.(zip|tar|tar\.gz|tgz)$/i.test(name);
