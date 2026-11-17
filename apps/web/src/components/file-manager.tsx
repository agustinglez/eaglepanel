import { toast } from "sonner";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import CodeMirror from "@uiw/react-codemirror";
import Uppy, { type Meta, type UppyFile } from "@uppy/core";
import XHRUpload from "@uppy/xhr-upload";
import {
  MAX_UPLOAD_BYTES,
  isArchive,
  type ArchiveFormat,
  type FileEntry,
  type FileRequest,
} from "@eaglepanel/shared";
import {
  ArchiveIcon,
  ArrowUpIcon,
  CopyIcon,
  DownloadIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderInputIcon,
  FolderPlusIcon,
  KeyRoundIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PackageOpenIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import i18n, { serverText } from "@/lib/i18n";

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

type Dialogs =
  | { kind: "mkdir" | "newFile" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "copy" | "move"; names: string[] }
  | { kind: "chmod"; names: string[]; mode: string }
  | { kind: "compress"; names: string[] }
  | { kind: "extract"; entry: FileEntry }
  | { kind: "delete"; names: string[] }
  | null;

/** The account's home directory, the same one seen over FTP. Every operation runs on the server as the account user. */
export function FileManager({ username }: { username: string }) {
  const { t } = useTranslation();
  const [dir, setDir] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["files", username, dir],
    queryFn: () => api.get<{ entries: FileEntry[]; truncated: boolean }>(`/accounts/${username}/files?path=${encodeURIComponent(dir)}`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["files", username] });

  useEffect(() => setSelected(new Set()), [dir]);

  async function run(request: FileRequest, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounts/${username}/files`, request);
      setDialog(null);
      setSelected(new Set());
      after?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Unexpected error"));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  const entries = list.data?.entries ?? [];
  const chosen = entries.filter((entry) => selected.has(entry.name));
  const names = chosen.map((entry) => entry.name);
  const single = chosen.length === 1 ? chosen[0]! : null;
  const toggle = (name: string, on: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (on) next.add(name);
    else next.delete(name);
    return next;
  });
  const download = (entry: FileEntry) => {
    window.location.href = `/api/accounts/${username}/files/download?path=${encodeURIComponent(join(dir, entry.name))}`;
  };
  const open = (entry: FileEntry) => {
    if (entry.type === "dir") setDir(join(dir, entry.name));
    else if (entry.type === "file") setEditing(join(dir, entry.name));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Files")}</CardTitle>
        <CardDescription>{t("The account's home directory, the same one it sees over FTP. Everything runs as the account user, with its permissions and quota.")}</CardDescription>
        <CardAction className="flex gap-2">
          <Button variant="outline" size="icon" aria-label={t("Refresh")} onClick={() => refresh()}><RefreshCwIcon /></Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <PathBar dir={dir} onNavigate={setDir} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={dir === ""} onClick={() => setDir(parentOf(dir))}><ArrowUpIcon />{t("Up one level")}</Button>
          <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "mkdir" })}><FolderPlusIcon />{t("Folder")}</Button>
          <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "newFile" })}><FilePlusIcon />{t("File")}</Button>
          {chosen.length > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "copy", names })}><CopyIcon />{t("Copy")}</Button>
              <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "move", names })}><FolderInputIcon />{t("Move")}</Button>
              <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "compress", names })}><ArchiveIcon />{t("Compress")}</Button>
              <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "chmod", names, mode: single?.mode ?? "644" })}><KeyRoundIcon />{t("Permissions")}</Button>
              <Button variant="destructive" size="sm" onClick={() => setDialog({ kind: "delete", names })}><Trash2Icon />{t("Delete ({{count}})", { count: chosen.length })}</Button>
            </>
          )}
        </div>
        <Uploader username={username} dir={dir} onDone={refresh} />
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {list.isError && <Alert variant="destructive"><AlertDescription>{list.error.message}</AlertDescription></Alert>}
        {list.data?.truncated && <p className="text-sm text-muted-foreground">{t("The folder has more than {{count}} entries: only the first ones are shown.", { count: entries.length })}</p>}
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    aria-label={t("Select all")}
                    checked={entries.length > 0 && selected.size === entries.length}
                    onCheckedChange={(on) => setSelected(on ? new Set(entries.map(({ name }) => name)) : new Set())}
                  />
                </TableHead>
                <TableHead>{t("Name")}</TableHead>
                <TableHead>{t("Size")}</TableHead>
                <TableHead>{t("Permissions")}</TableHead>
                <TableHead>{t("Modified")}</TableHead>
                <TableHead className="text-right">{t("Actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.isPending && <TableRow><TableCell colSpan={6} className="text-muted-foreground">{t("Loading…")}</TableCell></TableRow>}
              {list.data && entries.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">{t("The folder is empty.")}</TableCell></TableRow>}
              {entries.map((entry) => (
                <TableRow key={entry.name} data-state={selected.has(entry.name) ? "selected" : undefined}>
                  <TableCell><Checkbox aria-label={t("Select {{name}}", { name: entry.name })} checked={selected.has(entry.name)} onCheckedChange={(on) => toggle(entry.name, on)} /></TableCell>
                  <TableCell className="max-w-96">
                    <button type="button" className="flex min-w-0 items-center gap-2 text-left hover:underline disabled:no-underline" disabled={entry.type === "link" || entry.type === "other"} onClick={() => open(entry)}>
                      <EntryIcon entry={entry} />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{entry.type === "file" ? formatBytes(entry.size) : "—"}</TableCell>
                  <TableCell className="font-mono">{entry.mode}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(entry.mtimeMs)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("Actions for {{name}}", { name: entry.name })} />}>
                          <MoreHorizontalIcon />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {entry.type === "file" && <DropdownMenuItem onClick={() => download(entry)}><DownloadIcon />{t("Download")}</DropdownMenuItem>}
                          {entry.type === "file" && <DropdownMenuItem onClick={() => setEditing(join(dir, entry.name))}><PencilIcon />{t("Edit")}</DropdownMenuItem>}
                          {entry.type === "file" && isArchive(entry.name) && <DropdownMenuItem onClick={() => setDialog({ kind: "extract", entry })}><PackageOpenIcon />{t("Extract")}</DropdownMenuItem>}
                          <DropdownMenuItem onClick={() => setDialog({ kind: "rename", entry })}>{t("Rename")}</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDialog({ kind: "copy", names: [entry.name] })}>{t("Copy")}</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDialog({ kind: "move", names: [entry.name] })}>{t("Move")}</DropdownMenuItem>
                          {entry.type !== "link" && <DropdownMenuItem onClick={() => setDialog({ kind: "chmod", names: [entry.name], mode: entry.mode })}>{t("Permissions")}</DropdownMenuItem>}
                          <DropdownMenuItem onClick={() => setDialog({ kind: "compress", names: [entry.name] })}>{t("Compress")}</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setDialog({ kind: "delete", names: [entry.name] })}>{t("Delete")}</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <NameDialog
        open={dialog?.kind === "mkdir" || dialog?.kind === "newFile"}
        title={dialog?.kind === "mkdir" ? t("New folder") : t("New file")}
        initial=""
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={(name) => (dialog?.kind === "mkdir"
          ? run({ op: "mkdir", path: join(dir, name) })
          : run({ op: "write", path: join(dir, name), content: "", mtimeMs: null }, () => setEditing(join(dir, name))))}
      />
      <NameDialog
        open={dialog?.kind === "rename"}
        title={t("Rename")}
        initial={dialog?.kind === "rename" ? dialog.entry.name : ""}
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={(name) => dialog?.kind === "rename" && run({ op: "rename", from: join(dir, dialog.entry.name), to: join(dir, name) })}
      />
      <DestinationDialog
        open={dialog?.kind === "copy" || dialog?.kind === "move" || dialog?.kind === "extract"}
        title={dialog?.kind === "copy" ? t("Copy to") : dialog?.kind === "move" ? t("Move to") : t("Extract to")}
        description={dialog?.kind === "extract" ? t("Existing files are not overwritten.") : t("Destination folder, relative to the home directory. Empty means the home directory.")}
        initial={dir}
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={(to) => {
          if (dialog?.kind === "copy" || dialog?.kind === "move") void run({ op: dialog.kind, paths: dialog.names.map((name) => join(dir, name)), to });
          if (dialog?.kind === "extract") void run({ op: "extract", path: join(dir, dialog.entry.name), to });
        }}
      />
      <ChmodDialog
        state={dialog?.kind === "chmod" ? dialog : null}
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={(mode) => dialog?.kind === "chmod" && run({ op: "chmod", paths: dialog.names.map((name) => join(dir, name)), mode })}
      />
      <CompressDialog
        names={dialog?.kind === "compress" ? dialog.names : null}
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={(name, format) => dialog?.kind === "compress" && run({ op: "compress", paths: dialog.names.map((item) => join(dir, item)), name, format })}
      />
      <Dialog open={dialog?.kind === "delete"} onOpenChange={(next) => !next && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog?.kind === "delete" && dialog.names.length === 1 ? t("Delete {{name}}?", { name: dialog.names[0] }) : t("Delete {{count}} items?", { count: dialog?.kind === "delete" ? dialog.names.length : 0 })}</DialogTitle>
            <DialogDescription>{t("Folders are deleted with all of their contents. There is no trash: this cannot be undone.")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>{t("Cancel")}</Button>
            <Button variant="destructive" disabled={busy} onClick={() => dialog?.kind === "delete" && run({ op: "delete", paths: dialog.names.map((name) => join(dir, name)) })}>{t("Delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {editing !== null && <Editor username={username} path={editing} onClose={() => { setEditing(null); void refresh(); }} />}
    </Card>
  );
}

function EntryIcon({ entry }: { entry: FileEntry }) {
  if (entry.type === "dir") return <FolderIcon className="size-4 shrink-0 text-muted-foreground" />;
  if (entry.type === "link") return <LinkIcon className="size-4 shrink-0 text-muted-foreground" />;
  return <FileIcon className="size-4 shrink-0 text-muted-foreground" />;
}

function PathBar({ dir, onNavigate }: { dir: string; onNavigate: (path: string) => void }) {
  const parts = dir ? dir.split("/") : [];
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          {parts.length === 0 ? <BreadcrumbPage>home</BreadcrumbPage> : <BreadcrumbLink render={<button type="button" onClick={() => onNavigate("")} />}>home</BreadcrumbLink>}
        </BreadcrumbItem>
        {parts.map((part, index) => {
          const path = parts.slice(0, index + 1).join("/");
          return (
            <Fragment key={path}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {index === parts.length - 1 ? <BreadcrumbPage>{part}</BreadcrumbPage> : <BreadcrumbLink render={<button type="button" onClick={() => onNavigate(path)} />}>{part}</BreadcrumbLink>}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function NameDialog({ open, title, initial, busy, onClose, onSubmit }: { open: boolean; title: string; initial: string; busy: boolean; onClose: () => void; onSubmit: (name: string) => unknown }) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  useEffect(() => setName(initial), [initial, open]);
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="file-name">{t("Name")}</Label>
            <Input id="file-name" value={name} autoFocus onChange={(event) => setName(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t("Cancel")}</Button>
            <Button type="submit" disabled={busy || !name.trim() || name.includes("/")}>{t("Save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DestinationDialog({ open, title, description, initial, busy, onClose, onSubmit }: { open: boolean; title: string; description: string; initial: string; busy: boolean; onClose: () => void; onSubmit: (to: string) => void }) {
  const { t } = useTranslation();
  const [to, setTo] = useState(initial);
  useEffect(() => setTo(initial), [initial, open]);
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    onSubmit(to.trim().replace(/^\/+|\/+$/g, ""));
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="file-destination">{t("Folder")}</Label>
            <Input id="file-destination" className="font-mono" placeholder="public_html" value={to} autoFocus onChange={(event) => setTo(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t("Cancel")}</Button>
            <Button type="submit" disabled={busy}>{t("OK")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const WHO = [["Owner", 0], ["Group", 1], ["Others", 2]] as const;
const BITS = [["Read", 4], ["Write", 2], ["Execute", 1]] as const;

function ChmodDialog({ state, busy, onClose, onSubmit }: { state: { names: string[]; mode: string } | null; busy: boolean; onClose: () => void; onSubmit: (mode: string) => unknown }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState("644");
  useEffect(() => setMode(state?.mode ?? "644"), [state]);
  const valid = /^[0-7]{3}$/.test(mode);
  const digit = (who: number) => (valid ? Number(mode[who]) : 0);
  const flip = (who: number, bit: number, on: boolean) => {
    const next = mode.split("").map(Number);
    next[who] = on ? (next[who]! | bit) : (next[who]! & ~bit);
    setMode(next.join(""));
  };
  return (
    <Dialog open={state !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Permissions")}</DialogTitle>
          <DialogDescription>{state?.names.length === 1 ? state.names[0] : t("{{count}} items", { count: state?.names.length ?? 0 })}. {t("Typical values: 644 for files and 755 for folders.")}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-4 gap-3 text-sm">
          <span />
          {BITS.map(([label]) => <span key={label} className="text-muted-foreground">{t(label)}</span>)}
          {WHO.map(([label, who]) => (
            <Fragment key={label}>
              <span>{t(label)}</span>
              {BITS.map(([bitLabel, bit]) => (
                <Checkbox key={bitLabel} aria-label={`${t(label)}: ${t(bitLabel)}`} disabled={!valid} checked={(digit(who) & bit) !== 0} onCheckedChange={(on) => flip(who, bit, on)} />
              ))}
            </Fragment>
          ))}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="file-mode">Octal</Label>
          <Input id="file-mode" className="w-24 font-mono" value={mode} maxLength={3} onChange={(event) => setMode(event.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel")}</Button>
          <Button disabled={busy || !valid} onClick={() => onSubmit(mode)}>{t("Apply")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompressDialog({ names, busy, onClose, onSubmit }: { names: string[] | null; busy: boolean; onClose: () => void; onSubmit: (name: string, format: ArchiveFormat) => unknown }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [format, setFormat] = useState<ArchiveFormat>("zip");
  useEffect(() => setName(names?.length === 1 ? names[0]! : "archive"), [names]);
  return (
    <Dialog open={names !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Compress")}</DialogTitle>
          <DialogDescription>{t("The archive is created in this folder. Symbolic links are stored as links.")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="archive-name">{t("Name")}</Label>
          <Input id="archive-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label>{t("Format")}</Label>
          <Select value={format} onValueChange={(value) => setFormat(value as ArchiveFormat)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup><SelectItem value="zip">zip</SelectItem><SelectItem value="tar.gz">tar.gz</SelectItem></SelectGroup></SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel")}</Button>
          <Button disabled={busy || !name.trim() || name.includes("/")} onClick={() => onSubmit(name.trim(), format)}>{t("Compress")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type UploadMeta = Meta & { path: string; overwrite: boolean };
interface UploadRow { id: string; name: string; progress: number; error: string | null; done: boolean }

/** Uploads with Uppy: several at once, with progress. The file is sent as-is in the body, without multipart. */
function Uploader({ username, dir, onDone }: { username: string; dir: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // Created in the effect rather than in useMemo: in strict mode React unmounts and remounts, and the cleanup would
  // destroy an instance that is still in use afterwards.
  const [uppy, setUppy] = useState<Uppy<UploadMeta, Record<string, never>> | null>(null);
  useEffect(() => {
    const instance = new Uppy<UploadMeta, Record<string, never>>({ autoProceed: true, restrictions: { maxFileSize: MAX_UPLOAD_BYTES } });
    instance.use(XHRUpload<UploadMeta, Record<string, never>>, {
      endpoint: (file) => {
        const { path, overwrite: replace } = (file as UppyFile<UploadMeta, Record<string, never>>).meta;
        return `/api/accounts/${username}/files/upload?path=${encodeURIComponent(path)}&overwrite=${replace ? "1" : "0"}`;
      },
      method: "POST",
      formData: false,
      headers: { "x-eaglepanel": "1" },
      limit: 3,
      timeout: 0,
      // A panel error carries its own message: without this, Uppy shows a generic network error.
      onAfterResponse: (xhr) => {
        if (xhr.status < 400) return;
        let message = i18n.t("Upload failed");
        try {
          const error = (JSON.parse(xhr.responseText) as { error?: string }).error;
          if (error) message = serverText(error);
        } catch { /* no JSON body */ }
        throw new Error(message);
      },
      getResponseData: () => ({}),
      shouldRetry: () => false,
    });
    const update = (id: string, patch: Partial<UploadRow>) => setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    instance.on("file-added", (file) => setRows((current) => [...current, { id: file.id, name: file.name ?? "", progress: 0, error: null, done: false }]));
    instance.on("upload-progress", (file, progress) => {
      if (file && progress.bytesTotal) update(file.id, { progress: Math.round((progress.bytesUploaded / progress.bytesTotal) * 100) });
    });
    instance.on("upload-success", (file) => file && update(file.id, { progress: 100, done: true }));
    instance.on("upload-error", (file, error) => file && update(file.id, { error: error.message, done: true }));
    instance.on("restriction-failed", (file, error) => file && setRows((current) => [...current, { id: file.id, name: file.name ?? "", progress: 0, error: error.message, done: true }]));
    instance.on("complete", () => onDoneRef.current());
    setUppy(instance);
    return () => {
      instance.destroy();
      setUppy(null);
    };
  }, [username]);

  const add = (files: FileList | null) => {
    if (!uppy) return;
    for (const file of Array.from(files ?? [])) {
      try {
        uppy.addFile({ name: file.name, type: file.type, data: file, meta: { path: join(dir, file.name), overwrite } });
      } catch {
        // Uppy already reported it through restriction-failed, or the same file was already in the list.
      }
    }
    if (input.current) input.current.value = "";
  };
  const clear = () => {
    uppy?.clear();
    setRows([]);
  };
  const active = rows.some((row) => !row.done);

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-dashed p-3"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        add(event.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <input ref={input} type="file" multiple className="hidden" onChange={(event) => add(event.target.files)} />
        <Button size="sm" onClick={() => input.current?.click()}><UploadIcon />{t("Upload files")}</Button>
        <span className="text-sm text-muted-foreground">{t("or drag them here. Up to {{size}} GB per file.", { size: MAX_UPLOAD_BYTES / 1024 / 1024 / 1024 })}</span>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <Switch checked={overwrite} onCheckedChange={setOverwrite} />
          {t("Replace if it exists")}
        </label>
      </div>
      {rows.length > 0 && (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.id} className="grid gap-1 text-sm">
              <div className="flex justify-between gap-2">
                <span className="truncate">{row.name}</span>
                <span className={row.error ? "text-destructive" : "text-muted-foreground"}>{row.error ?? (row.done ? t("Done") : `${row.progress} %`)}</span>
              </div>
              {!row.error && !row.done && <Progress value={row.progress} />}
            </div>
          ))}
          {!active && <Button variant="ghost" size="sm" className="self-start" onClick={clear}>{t("Clear list")}</Button>}
        </div>
      )}
    </div>
  );
}

function Editor({ username, path, onClose }: { username: string; path: string; onClose: () => void }) {
  const { t } = useTranslation();
  const file = useQuery({
    queryKey: ["file-content", username, path],
    queryFn: () => api.post<{ content: string; mtimeMs: number; size: number }>(`/accounts/${username}/files`, { op: "read", path }),
    gcTime: 0,
    retry: false,
  });
  const [content, setContent] = useState<string | null>(null);
  const [mtimeMs, setMtimeMs] = useState<number | null>(null);
  const [language, setLanguage] = useState<Extension[]>([]);
  // What is currently on disk: changes are measured against this, not against what was read on open.
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (file.data && content === null) {
      setContent(file.data.content);
      setSavedContent(file.data.content);
      setMtimeMs(file.data.mtimeMs);
    }
  }, [file.data, content]);
  useEffect(() => {
    const name = path.split("/").at(-1) ?? "";
    // .htaccess and .user.ini have no language of their own: they resemble Apache configuration and an ini file.
    const description = LanguageDescription.matchFilename(languages, name === ".user.ini" ? "x.ini" : name);
    void description?.load().then((support) => setLanguage([support]));
  }, [path]);

  const dirty = content !== null && content !== savedContent;
  const name = path.split("/").at(-1) ?? path;
  /** The button saves and closes; Ctrl+S saves and keeps editing. Both report the result. */
  async function save({ close }: { close: boolean }) {
    if (content === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.post<{ mtimeMs: number }>(`/accounts/${username}/files`, { op: "write", path, content, mtimeMs });
      setMtimeMs(result.mtimeMs);
      setSavedContent(content);
      toast.success(t("{{name}} saved", { name }));
      if (close) onClose();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : t("Could not save");
      setError(message);
      toast.error(t("Could not save {{name}}", { name }), { description: message });
    } finally {
      setSaving(false);
    }
  }
  const dark = document.documentElement.classList.contains("dark");

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{path}</DialogTitle>
          <DialogDescription>{t("It is saved only if nobody changed it since you opened it. Ctrl+S saves.")}</DialogDescription>
        </DialogHeader>
        {file.isError && <Alert variant="destructive"><AlertDescription>{file.error.message}</AlertDescription></Alert>}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {content !== null && (
          <div
            className="min-h-0 flex-1 overflow-hidden rounded-lg border"
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void save({ close: false });
              }
            }}
          >
            <CodeMirror value={content} height="60vh" theme={dark ? "dark" : "light"} extensions={language} onChange={setContent} />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Close")}</Button>
          <Button disabled={saving || !dirty} onClick={() => void save({ close: true })}>{saving ? t("Saving…") : t("Save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
