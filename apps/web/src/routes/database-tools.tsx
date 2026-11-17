import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MAX_CELL_CHARS,
  MAX_RESULT_ROWS,
  STATEMENT_TIMEOUT_SECONDS,
  type DbAccess,
  type DbColumnDto,
  type DbProcessDto,
  type DbStructureDto,
  type DbTableDto,
  type ExecuteRequest,
  type ExecuteResultDto,
} from "@eaglepanel/shared";
import { HistoryIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import {
  COMMON_TYPES,
  addColumnSql,
  addIndexSql,
  changeColumnSql,
  columnSpecOf,
  createTableSql,
  dropColumnSql,
  dropIndexSql,
  dropTableSql,
  emptyColumn,
  insertRowSql,
  isEditableColumn,
  renameTableSql,
  selectRowSql,
  supportsOnUpdate,
  truncateTableSql,
  updateRowSql,
  deleteRowSql,
  type ColumnPosition,
  type ColumnSpec,
  type DefaultMode,
  type IndexKind,
} from "@/lib/sql";

// ---------------------------------------------------------------------------- Context

export interface DbTarget {
  username: string;
  database: string;
  base: string;
  access: DbAccess;
}

const DbContext = createContext<DbTarget | null>(null);
export const DbProvider = ({ value, children }: { value: DbTarget; children: ReactNode }) => <DbContext.Provider value={value}>{children}</DbContext.Provider>;

export function useDb(): DbTarget {
  const target = useContext(DbContext);
  if (!target) throw new Error("useDb outside DbProvider");
  return target;
}

/** One statement through the panel. After a change, everything shown of this database is reloaded. */
export function useExecute() {
  const { base, username, database } = useDb();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: ExecuteRequest) => api.post<ExecuteResultDto>(`${base}/execute`, request),
    onSuccess: (result) => {
      if (result.kind === "done") void queryClient.invalidateQueries({ queryKey: ["db", username, database] });
    },
  });
}

export const canChange = (access: DbAccess) => access === "full";
/** An account over its limit can still delete: it is how it frees space. */
export const canFree = (access: DbAccess) => access !== "readonly";

// ---------------------------------------------------------------------------- Small pieces

function PlainSelect<T extends string>({ id, value, options, onChange, className }: { id?: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; className?: string }) {
  return (
    <Select items={options} value={value} onValueChange={(next) => next && onChange(next as T)}>
      <SelectTrigger id={id} className={className ?? "w-full"}><SelectValue /></SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function SqlPreview({ sql }: { sql: string }) {
  return <pre className="max-h-48 overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">{sql}</pre>;
}

/**
 * A dialog that runs one statement: the form builds it, the person sees it before running it. `sql` null means the
 * form is not complete yet.
 */
function SqlDialog({ open, onOpenChange, title, description, sql, params = [], destructive, submitLabel, success, onDone, children, wide }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  sql: string | null;
  params?: (string | null)[];
  destructive?: boolean;
  submitLabel: string;
  success: string;
  onDone?: () => void;
  children?: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const execute = useExecute();
  useEffect(() => {
    if (open) execute.reset();
    // Only when opening: a previous error must not stay on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (!sql) return;
    execute.mutate({ sql, params }, {
      onSuccess: () => {
        toast.success(success);
        onOpenChange(false);
        onDone?.();
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={wide ? "sm:max-w-4xl" : "sm:max-w-xl"}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          {sql && (
            <div className="grid gap-1.5">
              <span className="text-sm text-muted-foreground">{t("Statement to run")}</span>
              <SqlPreview sql={sql} />
            </div>
          )}
          {execute.isError && <Alert variant="destructive"><AlertDescription className="break-words">{execute.error.message}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={!sql || execute.isPending}>{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- Columns

const DEFAULT_MODES: { value: DefaultMode; label: string }[] = [
  { value: "none", label: "No default" },
  { value: "null", label: "NULL" },
  { value: "value", label: "Value" },
  { value: "expression", label: "Expression" },
];

function ColumnFields({ value, onChange, idPrefix, compact }: { value: ColumnSpec; onChange: (next: ColumnSpec) => void; idPrefix: string; compact?: boolean }) {
  const { t } = useTranslation();
  const set = (patch: Partial<ColumnSpec>) => onChange({ ...value, ...patch });
  return (
    <div className={compact ? "grid gap-2 sm:grid-cols-[1fr_1fr_9rem_1fr]" : "grid gap-3 sm:grid-cols-2"}>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-name`}>{t("Name")}</Label>
        <Input id={`${idPrefix}-name`} className="font-mono" value={value.name} maxLength={64} onChange={(event) => set({ name: event.target.value })} spellCheck={false} required />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-type`}>{t("Type")}</Label>
        <Input id={`${idPrefix}-type`} className="font-mono" list="eaglepanel-sql-types" value={value.type} onChange={(event) => set({ type: event.target.value })} spellCheck={false} required />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-default-mode`}>{t("Default")}</Label>
        <PlainSelect id={`${idPrefix}-default-mode`} value={value.defaultMode} options={DEFAULT_MODES.map((mode) => ({ value: mode.value, label: mode.value === "null" ? "NULL" : t(mode.label) }))} onChange={(defaultMode) => set({ defaultMode, ...(defaultMode === "null" ? { nullable: true } : {}) })} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-default`}>{value.defaultMode === "expression" ? t("Expression") : t("Default value")}</Label>
        <Input id={`${idPrefix}-default`} className="font-mono" value={value.defaultValue} disabled={value.defaultMode === "none" || value.defaultMode === "null"} placeholder={value.defaultMode === "expression" ? "CURRENT_TIMESTAMP" : ""} onChange={(event) => set({ defaultValue: event.target.value })} spellCheck={false} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:col-span-full">
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={value.nullable} onCheckedChange={(checked) => set({ nullable: checked === true })} />{t("Allows NULL")}</label>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={value.autoIncrement} onCheckedChange={(checked) => set({ autoIncrement: checked === true })} />AUTO_INCREMENT</label>
        {supportsOnUpdate(value.type) && (
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={value.onUpdateNow} onCheckedChange={(checked) => set({ onUpdateNow: checked === true })} />{t("Update on every change")}</label>
        )}
      </div>
      {!compact && (
        <div className="grid gap-1.5 sm:col-span-full">
          <Label htmlFor={`${idPrefix}-comment`}>{t("Comment")}</Label>
          <Input id={`${idPrefix}-comment`} value={value.comment} maxLength={1024} onChange={(event) => set({ comment: event.target.value })} />
        </div>
      )}
    </div>
  );
}

/** Suggestions for the type field; any other MySQL type can be typed. */
export function SqlTypeList() {
  return <datalist id="eaglepanel-sql-types">{COMMON_TYPES.map((type) => <option key={type} value={type} />)}</datalist>;
}

const columnReady = (spec: ColumnSpec) => spec.name.trim() !== "" && spec.type.trim() !== "";

export function CreateTableDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (table: string) => void }) {
  const { t } = useTranslation();
  const initial = () => [{ ...emptyColumn(), name: "id", type: "bigint unsigned", nullable: false, autoIncrement: true }];
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [columns, setColumns] = useState<ColumnSpec[]>(initial);
  const [primary, setPrimary] = useState<string[]>(["id"]);
  useEffect(() => {
    if (!open) return;
    setName("");
    setComment("");
    setColumns(initial());
    setPrimary(["id"]);
  }, [open]);

  const names = columns.map((column) => column.name.trim());
  const keys = primary.filter((key) => names.includes(key));
  const ready = name.trim() !== "" && columns.length > 0 && columns.every(columnReady);
  return (
    <SqlDialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={t("New table")}
      sql={ready ? createTableSql(name, columns, keys, comment) : null}
      submitLabel={t("Create table")}
      success={t("Table {{table}} created", { table: name.trim() })}
      onDone={() => onCreated(name.trim())}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="new-table-name">{t("Name")}</Label>
          <Input id="new-table-name" className="font-mono" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} spellCheck={false} required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-table-comment">{t("Comment")}</Label>
          <Input id="new-table-comment" value={comment} maxLength={2048} onChange={(event) => setComment(event.target.value)} />
        </div>
      </div>
      <div className="grid max-h-[45vh] gap-3 overflow-y-auto pr-1">
        {columns.map((column, index) => (
          // Columns are edited in place and their name can be empty: the position identifies them.
          <div key={index} className="grid gap-2 rounded-lg border p-3">
            <ColumnFields compact idPrefix={`new-col-${index}`} value={column} onChange={(next) => setColumns(columns.map((item, position) => (position === index ? next : item)))} />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={primary.includes(column.name.trim()) && column.name.trim() !== ""} onCheckedChange={(checked) => setPrimary(checked === true ? [...primary, column.name.trim()] : primary.filter((key) => key !== column.name.trim()))} />
                {t("Primary key")}
              </label>
              <Button type="button" variant="ghost" size="sm" disabled={columns.length === 1} onClick={() => setColumns(columns.filter((_, position) => position !== index))}><Trash2Icon />{t("Remove")}</Button>
            </div>
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setColumns([...columns, emptyColumn()])}><PlusIcon />{t("Add column")}</Button>
    </SqlDialog>
  );
}

export function AddColumnDialog({ table, columns, open, onOpenChange }: { table: string; columns: DbColumnDto[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [spec, setSpec] = useState<ColumnSpec>(emptyColumn);
  const [position, setPosition] = useState("end");
  useEffect(() => {
    if (!open) return;
    setSpec(emptyColumn());
    setPosition("end");
  }, [open]);
  const where: ColumnPosition = position === "end" ? { kind: "end" } : position === "first" ? { kind: "first" } : { kind: "after", column: position.slice(6) };
  return (
    <SqlDialog open={open} onOpenChange={onOpenChange} title={t("Add a column to {{table}}", { table })} sql={columnReady(spec) ? addColumnSql(table, spec, where) : null} submitLabel={t("Add column")} success={t("Column {{column}} added", { column: spec.name.trim() })}>
      <ColumnFields idPrefix="add-col" value={spec} onChange={setSpec} />
      <div className="grid gap-1.5">
        <Label htmlFor="add-col-position">{t("Position")}</Label>
        <PlainSelect
          id="add-col-position"
          value={position}
          options={[{ value: "end", label: t("At the end") }, { value: "first", label: t("First") }, ...columns.map((column) => ({ value: `after:${column.name}`, label: t("After {{column}}", { column: column.name }) }))]}
          onChange={setPosition}
        />
      </div>
    </SqlDialog>
  );
}

export function EditColumnDialog({ table, column, open, onOpenChange }: { table: string; column: DbColumnDto | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [spec, setSpec] = useState<ColumnSpec>(emptyColumn);
  useEffect(() => {
    if (open && column) setSpec(columnSpecOf(column));
  }, [open, column]);
  if (!column) return null;
  return (
    <SqlDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("Edit column {{column}}", { column: column.name })}
      description={t("Changing the type converts the existing values; MySQL stops if one does not fit.")}
      sql={columnReady(spec) ? changeColumnSql(table, column.name, spec) : null}
      submitLabel={t("Save column")}
      success={t("Column {{column}} saved", { column: spec.name.trim() })}
    >
      <ColumnFields idPrefix="edit-col" value={spec} onChange={setSpec} />
    </SqlDialog>
  );
}

// ---------------------------------------------------------------------------- Indexes

const INDEX_KINDS: { value: IndexKind; label: string }[] = [
  { value: "INDEX", label: "Index" },
  { value: "UNIQUE", label: "Unique" },
  { value: "FULLTEXT", label: "Full text" },
  { value: "PRIMARY", label: "Primary key" },
];

export function AddIndexDialog({ table, structure, open, onOpenChange }: { table: string; structure: DbStructureDto; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<IndexKind>("INDEX");
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
    setKind("INDEX");
    setName("");
    setChosen([]);
  }, [open]);
  const hasPrimary = structure.indexes.some((index) => index.name === "PRIMARY");
  const kinds = INDEX_KINDS.filter((item) => item.value !== "PRIMARY" || !hasPrimary);
  const ready = chosen.length > 0 && (kind === "PRIMARY" || name.trim() !== "");
  return (
    <SqlDialog open={open} onOpenChange={onOpenChange} title={t("Add an index to {{table}}", { table })} description={t("Columns are used in the order you check them.")} sql={ready ? addIndexSql(table, kind, name, chosen) : null} submitLabel={t("Add index")} success={t("Index added")}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="index-kind">{t("Kind")}</Label>
          <PlainSelect id="index-kind" value={kind} options={kinds.map((item) => ({ value: item.value, label: t(item.label) }))} onChange={setKind} />
        </div>
        {kind !== "PRIMARY" && (
          <div className="grid gap-1.5">
            <Label htmlFor="index-name">{t("Name")}</Label>
            <Input id="index-name" className="font-mono" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} placeholder={chosen.length > 0 ? `${table}_${chosen.join("_")}`.slice(0, 64) : ""} spellCheck={false} />
          </div>
        )}
      </div>
      <div className="grid max-h-56 gap-2 overflow-y-auto rounded-lg border p-3">
        {structure.columns.map((column) => (
          <label key={column.name} className="flex items-center gap-2 text-sm">
            <Checkbox checked={chosen.includes(column.name)} onCheckedChange={(checked) => setChosen(checked === true ? [...chosen, column.name] : chosen.filter((item) => item !== column.name))} />
            <span className="font-mono">{column.name}</span>
            <span className="text-xs text-muted-foreground">{column.type}</span>
            {chosen.includes(column.name) && <Badge variant="outline">{chosen.indexOf(column.name) + 1}</Badge>}
          </label>
        ))}
      </div>
    </SqlDialog>
  );
}

/** Confirmation for a statement with nothing to fill in: dropping a column or an index, emptying a table... */
export function ConfirmSqlDialog({ open, onOpenChange, title, description, sql, submitLabel, success, onDone }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  sql: string;
  submitLabel: string;
  success: string;
  onDone?: () => void;
}) {
  return <SqlDialog open={open} onOpenChange={onOpenChange} title={title} description={description} sql={sql} destructive submitLabel={submitLabel} success={success} onDone={onDone} />;
}

export { dropColumnSql, dropIndexSql };

// ---------------------------------------------------------------------------- Tables

export function TableActions({ table, onRenamed, onDropped }: { table: DbTableDto; onRenamed: (name: string) => void; onDropped: () => void }) {
  const { t } = useTranslation();
  const { access } = useDb();
  const [dialog, setDialog] = useState<"rename" | "empty" | "drop" | null>(null);
  const [name, setName] = useState(table.name);
  const view = table.kind === "view";
  if (!canFree(access)) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>{t("Actions")}</DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuGroup>
            {canChange(access) && <DropdownMenuItem onClick={() => { setName(table.name); setDialog("rename"); }}>{t("Rename")}</DropdownMenuItem>}
            {!view && <DropdownMenuItem onClick={() => setDialog("empty")}>{t("Empty")}</DropdownMenuItem>}
            <DropdownMenuItem variant="destructive" onClick={() => setDialog("drop")}>{view ? t("Delete view") : t("Delete table")}</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <SqlDialog
        open={dialog === "rename"}
        onOpenChange={(open) => setDialog(open ? "rename" : null)}
        title={t("Rename {{table}}", { table: table.name })}
        description={t("Views, triggers and code that use the old name stop working until they are updated.")}
        sql={name.trim() && name.trim() !== table.name ? renameTableSql(table.name, name) : null}
        submitLabel={t("Rename")}
        success={t("Table renamed to {{table}}", { table: name.trim() })}
        onDone={() => onRenamed(name.trim())}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="rename-table">{t("New name")}</Label>
          <Input id="rename-table" className="font-mono" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} spellCheck={false} />
        </div>
      </SqlDialog>
      <ConfirmSqlDialog
        open={dialog === "empty"}
        onOpenChange={(open) => setDialog(open ? "empty" : null)}
        title={t("Empty {{table}}", { table: table.name })}
        description={t("Deletes every row and restarts AUTO_INCREMENT. The structure stays. It cannot be undone.")}
        sql={truncateTableSql(table.name)}
        submitLabel={t("Empty table")}
        success={t("{{table}} is empty", { table: table.name })}
      />
      <ConfirmSqlDialog
        open={dialog === "drop"}
        onOpenChange={(open) => setDialog(open ? "drop" : null)}
        title={view ? t("Delete view {{table}}", { table: table.name }) : t("Delete table {{table}}", { table: table.name })}
        description={view ? t("Only the view is deleted: the tables it reads stay.") : t("Deletes the table and all its rows. It cannot be undone.")}
        sql={dropTableSql(table.name, view)}
        submitLabel={view ? t("Delete view") : t("Delete table")}
        success={t("{{table}} deleted", { table: table.name })}
        onDone={onDropped}
      />
    </>
  );
}

// ---------------------------------------------------------------------------- Rows

const isTruncated = (value: string | null) => value !== null && value.length > MAX_CELL_CHARS && value.endsWith("…");

/** The values of a row that identify it, or null if one of them cannot be trusted (NULL or cut). */
export function keyValues(columns: string[], row: (string | null)[], key: string[]): string[] | null {
  const values = key.map((name) => row[columns.indexOf(name)] ?? null);
  return values.every((value) => value !== null && !isTruncated(value)) ? (values as string[]) : null;
}

interface FieldState {
  value: string;
  isNull: boolean;
  useDefault: boolean;
  original: string | null;
}

/** Insert or edit one row. For editing, the row is read again whole: the grid only has a preview of long values. */
export function RowDialog({ table, structure, rowKey, keyValues: keys, open, onOpenChange }: {
  table: string;
  structure: DbStructureDto;
  rowKey: string[];
  /** Null to insert. */
  keyValues: string[] | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { base, username, database } = useDb();
  const editing = keys !== null;
  const editable = structure.columns.filter(isEditableColumn);
  const current = useQuery({
    queryKey: ["db", username, database, "row", table, keys],
    queryFn: () => api.post<ExecuteResultDto>(`${base}/execute`, { sql: selectRowSql(table, structure.columns, rowKey), params: keys ?? [], full: true }),
    enabled: open && editing,
    staleTime: 0,
    gcTime: 0,
  });
  const [fields, setFields] = useState<Record<string, FieldState>>({});
  useEffect(() => {
    if (!open) return;
    if (!editing) {
      // Insert: whatever has a default (or AUTO_INCREMENT, or allows NULL) starts on its default.
      setFields(Object.fromEntries(editable.map((column) => [column.name, {
        value: "", isNull: false, original: null,
        useDefault: column.default !== null || column.nullable || column.extra.toLowerCase().includes("auto_increment") || column.extra.toLowerCase().includes("default_generated"),
      }])));
      return;
    }
    const data = current.data;
    if (data?.kind !== "rows" || data.rows.length === 0) return;
    const row = data.rows[0]!;
    setFields(Object.fromEntries(editable.map((column) => {
      const value = row[data.columns.indexOf(column.name)] ?? null;
      return [column.name, { value: value ?? "", isNull: value === null, useDefault: false, original: value }];
    })));
    // editable is derived from structure: listing it would reset the form on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, current.data, structure]);

  const set = (name: string, patch: Partial<FieldState>) => setFields({ ...fields, [name]: { ...fields[name]!, ...patch } });
  const ready = editable.every((column) => fields[column.name]);
  let statement: { sql: string; params: (string | null)[] } | null = null;
  if (ready && editing) {
    const changes = editable.flatMap((column) => {
      const field = fields[column.name]!;
      const next = field.isNull ? null : field.value;
      return next === field.original ? [] : [{ column: column.name, value: next }];
    });
    if (changes.length > 0) {
      const built = updateRowSql(table, changes, rowKey);
      statement = { sql: built.sql, params: [...built.params, ...(keys ?? [])] };
    }
  } else if (ready) {
    statement = insertRowSql(table, editable.flatMap((column) => {
      const field = fields[column.name]!;
      return field.useDefault ? [] : [{ column: column.name, value: field.isNull ? null : field.value }];
    }));
  }
  const missing = editing && current.data?.kind === "rows" && current.data.rows.length === 0;
  const skipped = structure.columns.length - editable.length;

  return (
    <SqlDialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={editing ? t("Edit row of {{table}}", { table }) : t("Insert a row into {{table}}", { table })}
      description={skipped > 0 ? t("Binary and generated columns are not edited here: use the SQL console.") : undefined}
      sql={statement?.sql ?? null}
      params={statement?.params ?? []}
      submitLabel={editing ? t("Save row") : t("Insert row")}
      success={editing ? t("Row saved") : t("Row inserted")}
    >
      {editing && current.isPending && <Skeleton className="h-48 w-full" />}
      {current.isError && <Alert variant="destructive"><AlertDescription>{current.error.message}</AlertDescription></Alert>}
      {missing && <Alert variant="destructive"><AlertDescription>{t("The row no longer exists: someone else changed or deleted it.")}</AlertDescription></Alert>}
      {ready && !missing && (
        <div className="grid max-h-[50vh] gap-3 overflow-y-auto pr-1">
          {editable.map((column) => {
            const field = fields[column.name]!;
            const long = /text|json|blob/i.test(column.type) || field.value.length > 80 || field.value.includes("\n");
            const disabled = field.isNull || field.useDefault;
            return (
              <div key={column.name} className="grid gap-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor={`row-${column.name}`} className="font-mono">{column.name} <span className="font-sans text-xs font-normal text-muted-foreground">{column.type}</span></Label>
                  <div className="flex items-center gap-3">
                    {!editing && <label className="flex items-center gap-1.5 text-xs"><Checkbox checked={field.useDefault} onCheckedChange={(checked) => set(column.name, { useDefault: checked === true })} />{t("Default")}</label>}
                    {column.nullable && <label className="flex items-center gap-1.5 text-xs"><Checkbox checked={field.isNull} onCheckedChange={(checked) => set(column.name, { isNull: checked === true })} />NULL</label>}
                  </div>
                </div>
                {long
                  ? <Textarea id={`row-${column.name}`} rows={4} className="font-mono text-xs" value={field.value} disabled={disabled} onChange={(event) => set(column.name, { value: event.target.value })} spellCheck={false} />
                  : <Input id={`row-${column.name}`} className="font-mono" value={field.value} disabled={disabled} onChange={(event) => set(column.name, { value: event.target.value })} spellCheck={false} />}
              </div>
            );
          })}
        </div>
      )}
    </SqlDialog>
  );
}

export function DeleteRowDialog({ table, rowKey, keyValues: keys, open, onOpenChange }: { table: string; rowKey: string[]; keyValues: string[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const where = rowKey.map((column, index) => `${column} = ${keys[index]}`).join(", ");
  return (
    <SqlDialog
      open={open}
      onOpenChange={onOpenChange}
      destructive
      title={t("Delete row")}
      description={t("Deletes the row with {{where}} from {{table}}. It cannot be undone.", { where, table })}
      sql={deleteRowSql(table, rowKey)}
      params={keys}
      submitLabel={t("Delete row")}
      success={t("Row deleted")}
    />
  );
}

// ---------------------------------------------------------------------------- SQL console

const HISTORY_KEY = "eaglepanel.sql-history";
const HISTORY_SIZE = 25;

function loadHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory(items: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
  } catch { /* storage blocked: history is a convenience */ }
}

export function SqlConsole({ initial }: { initial?: string }) {
  const { t } = useTranslation();
  const { database, access } = useDb();
  const [sql, setSql] = useState(initial ?? "");
  const [history, setHistory] = useState<string[]>(loadHistory);
  const execute = useExecute();

  function run(event?: SyntheticEvent) {
    event?.preventDefault();
    const statement = sql.trim();
    if (!statement) return;
    const next = [statement, ...history.filter((item) => item !== statement)].slice(0, HISTORY_SIZE);
    setHistory(next);
    saveHistory(next);
    execute.mutate({ sql: statement });
  }

  const result = execute.data;
  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={run} className="grid gap-2">
        <Textarea
          aria-label={t("SQL statement")}
          rows={7}
          className="font-mono text-sm"
          value={sql}
          placeholder={`SELECT * FROM … LIMIT 10`}
          onChange={(event) => setSql(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) run(event);
          }}
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!sql.trim() || execute.isPending}><PlayIcon />{t("Run")}</Button>
          {history.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" variant="outline" />}><HistoryIcon />{t("History")}</DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-w-[min(36rem,90vw)]">
                <DropdownMenuGroup>
                  {history.map((item) => <DropdownMenuItem key={item} className="font-mono text-xs" onClick={() => setSql(item)}><span className="truncate">{item}</span></DropdownMenuItem>)}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <span className="text-sm text-muted-foreground">
            {t("One statement at a time (Ctrl+Enter). Up to {{rows}} rows and {{seconds}} seconds. For scripts, use Import.", { rows: MAX_RESULT_ROWS, seconds: STATEMENT_TIMEOUT_SECONDS })}
          </span>
        </div>
        {access !== "full" && (
          <p className="text-sm text-muted-foreground">
            {access === "readonly"
              ? t("The account is suspended: only reading is allowed.")
              : t("The account exceeded its limit: you can read and delete, but not add data.")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t("Runs on {{database}} with a temporary user that has privileges on this database only.", { database })}</p>
      </form>

      {execute.isError && <Alert variant="destructive"><AlertDescription className="font-mono text-xs break-words">{execute.error.message}</AlertDescription></Alert>}
      {result?.kind === "done" && (
        <Alert>
          <AlertDescription>
            {t("Done in {{ms}} ms. Rows affected: {{rows}}.", { ms: result.ms, rows: result.affectedRows })}
            {result.insertId !== null && ` ${t("Last inserted id: {{id}}.", { id: result.insertId })}`}
          </AlertDescription>
        </Alert>
      )}
      {result?.kind === "rows" && (
        <div className="flex flex-col gap-2">
          <span className="text-sm text-muted-foreground">
            {result.truncated
              ? t("First {{count}} rows, in {{ms}} ms. Add a LIMIT or a WHERE to see others.", { count: result.rows.length, ms: result.ms })
              : t("{{count}} rows in {{ms}} ms.", { count: result.rows.length, ms: result.ms })}
          </span>
          {result.columns.length > 0 && (
            <div className="max-h-[60vh] overflow-auto rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 bg-muted">
                  <TableRow>{result.columns.map((column) => <TableHead key={column} className="font-mono whitespace-nowrap">{column}</TableHead>)}</TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row, index) => (
                    // Results have no id: their position identifies them.
                    <TableRow key={index}>
                      {row.map((value, column) => (
                        <TableCell key={result.columns[column] ?? column} className="max-w-72 truncate font-mono text-xs" title={value ?? "NULL"}>
                          {value === null ? <span className="text-muted-foreground italic">NULL</span> : value}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- Processes

export function ProcessesPanel() {
  const { t } = useTranslation();
  const { base, access } = useDb();
  const queryClient = useQueryClient();
  const processes = useQuery({
    queryKey: [base, "processes"],
    queryFn: () => api.get<DbProcessDto[]>(`${base}/processes`),
    refetchInterval: (query) => (query.state.error ? false : 5000),
  });
  const kill = useMutation({
    mutationFn: (id: number) => api.post(`${base}/processes/${id}/kill`),
    onSuccess: (_data, id) => {
      toast.success(t("Connection {{id}} closed", { id }));
      void queryClient.invalidateQueries({ queryKey: [base, "processes"] });
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t("Connections working on this database right now: those of its user and those of the panel. Refreshes every 5 seconds.")}</p>
      {processes.isError && <Alert variant="destructive"><AlertDescription>{processes.error.message}</AlertDescription></Alert>}
      {processes.isPending && <Skeleton className="h-32 w-full" />}
      {processes.data && processes.data.length === 0 && <p className="text-sm text-muted-foreground">{t("No connections right now.")}</p>}
      {processes.data && processes.data.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>{t("User")}</TableHead>
                <TableHead>{t("Command")}</TableHead>
                <TableHead>{t("Time")}</TableHead>
                <TableHead>{t("State")}</TableHead>
                <TableHead>{t("Statement")}</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {processes.data.map((process) => (
                <TableRow key={process.id}>
                  <TableCell className="tabular-nums">{process.id}</TableCell>
                  <TableCell className="font-mono text-xs">{process.user}</TableCell>
                  <TableCell>{process.command}</TableCell>
                  <TableCell className="tabular-nums">{t("{{seconds}} s", { seconds: process.seconds })}</TableCell>
                  <TableCell className="text-xs">{process.state}</TableCell>
                  <TableCell className="max-w-96 truncate font-mono text-xs" title={process.info ?? ""}>{process.info}</TableCell>
                  <TableCell>
                    {access !== "readonly" && <Button variant="outline" size="sm" disabled={kill.isPending} onClick={() => kill.mutate(process.id)}>{t("Close")}</Button>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
