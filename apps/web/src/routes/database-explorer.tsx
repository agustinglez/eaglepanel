import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DbAccess } from "@eaglepanel/shared";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  FILTER_OPERATORS,
  ROW_PAGE_SIZES,
  type AccountDto,
  type DbRowsDto,
  type DbStructureDto,
  type DbTableDto,
  type FilterOperator,
  type JobCreatedDto,
} from "@eaglepanel/shared";
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon, EllipsisVerticalIcon, PlusIcon, SearchIcon, UploadIcon } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { Page } from "@/components/app-shell";
import { ActionFeedback, useJobAction } from "@/components/job-action";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import i18n, { serverText } from "@/lib/i18n";
import { rowKey } from "@/lib/sql";
import {
  AddColumnDialog,
  AddIndexDialog,
  ConfirmSqlDialog,
  CreateTableDialog,
  DbProvider,
  DeleteRowDialog,
  EditColumnDialog,
  ProcessesPanel,
  RowDialog,
  SqlConsole,
  SqlTypeList,
  TableActions,
  canChange,
  canFree,
  dropColumnSql,
  dropIndexSql,
  keyValues,
  useDb,
} from "@/routes/database-tools";

const route = getRouteApi("/accounts/$username/databases/$database");

export type ExplorerView = "rows" | "structure";
export type ExplorerTab = "tables" | "sql" | "processes";
export interface ExplorerSearch {
  tab?: Exclude<ExplorerTab, "tables">;
  table?: string;
  view?: ExplorerView;
}

export function validateExplorerSearch(search: Record<string, unknown>): ExplorerSearch {
  return {
    tab: search.tab === "sql" || search.tab === "processes" ? search.tab : undefined,
    table: typeof search.table === "string" && search.table ? search.table : undefined,
    view: search.view === "structure" ? "structure" : undefined,
  };
}

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: "equals",
  ne: "is not",
  contains: "contains",
  starts: "starts with",
  gt: "greater than",
  lt: "less than",
  null: "is NULL",
  notnull: "is not NULL",
};
const NEEDS_VALUE = (op: FilterOperator) => op !== "null" && op !== "notnull";

/** A select of plain values: column names are shown as they are, never translated. */
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

// ---------------------------------------------------------------------------- Import

/** The file goes as is in the body, with upload progress; the server answers with the job that loads it. */
function uploadDump(path: string, file: File, onProgress: (ratio: number) => void): Promise<JobCreatedDto> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api${path}`);
    request.setRequestHeader("x-eaglepanel", "1");
    request.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded / event.total);
    request.onload = () => {
      const body = (() => {
        try {
          return JSON.parse(request.responseText) as JobCreatedDto & { error?: string };
        } catch {
          return null;
        }
      })();
      if (request.status >= 200 && request.status < 300 && body) resolve(body);
      else reject(new ApiError(request.status, body?.error ? serverText(body.error) : i18n.t("Unexpected server error")));
    };
    request.onerror = () => reject(new ApiError(0, i18n.t("The upload was interrupted")));
    request.send(file);
  });
}

function ImportDialog({ account, database }: { account: AccountDto; database: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const action = useJobAction(({ file: chosen, replace: empty }: { file: File; replace: boolean }) =>
    uploadDump(`/accounts/${account.username}/databases/${database}/import?replace=${empty ? "1" : "0"}`, chosen, setProgress).finally(() => setProgress(null)));
  const blocked = account.suspended || account.dbBlocked;

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (!file) return;
    setOpen(false);
    action.mutate({ file, replace });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button variant="outline" size="sm" disabled={blocked || action.isPending} />}><UploadIcon />{t("Import")}</DialogTrigger>
        <DialogContent>
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{t("Import into {{database}}", { database })}</DialogTitle>
              <DialogDescription>{t("A .sql or .sql.gz file, such as an export from this panel, phpMyAdmin or mysqldump. If the import fails, the database is restored as it was.")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="import-file">{t("File")}</Label>
              <Input id="import-file" type="file" accept=".sql,.gz,application/sql,application/gzip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required />
            </div>
            <div className="flex items-start gap-2">
              <Checkbox id="import-replace" checked={replace} onCheckedChange={(checked) => setReplace(checked === true)} />
              <div className="grid gap-1">
                <Label htmlFor="import-replace">{t("Delete everything in the database first")}</Label>
                <p className="text-sm text-muted-foreground">{t("Otherwise the file is loaded on top of what exists: tables it creates must not exist yet, unless the file drops them first.")}</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">{t("Objects in the file are created in the name of the database user ({{database}}), whatever DEFINER they had.", { database })}</p>
            <DialogFooter><Button type="submit" variant={replace ? "destructive" : "default"} disabled={!file}>{t("Import")}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {progress !== null && (
        <div className="grid min-w-48 gap-1">
          <span className="text-sm text-muted-foreground">{t("Uploading {{percent}}%", { percent: Math.round(progress * 100) })}</span>
          <Progress value={progress * 100} />
        </div>
      )}
      <div className="basis-full">
        <ActionFeedback action={action} onFinished={() => void queryClient.invalidateQueries({ queryKey: ["db", account.username, database] })} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------- Rows

function CellValue({ value, column }: { value: string | null; column: string }) {
  const { t } = useTranslation();
  if (value === null) return <span className="text-muted-foreground italic">NULL</span>;
  if (value.length <= 60 && !value.includes("\n")) return <span className="whitespace-pre">{value}</span>;
  return (
    <Dialog>
      <DialogTrigger render={<button type="button" className="block max-w-72 cursor-pointer truncate text-left hover:underline" />}>{value}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{column}</DialogTitle>
          {value.endsWith("…") && <DialogDescription>{t("Only the beginning is shown. Export the database to get the whole value.")}</DialogDescription>}
        </DialogHeader>
        <Textarea readOnly rows={14} className="font-mono text-xs" value={value} />
      </DialogContent>
    </Dialog>
  );
}

function RowsPanel({ base, cacheKey, table, structure }: { base: string; cacheKey: string[]; table: string; structure: DbStructureDto }) {
  const { t } = useTranslation();
  const { access } = useDb();
  const columns = structure.columns.map((column) => column.name);
  const key = rowKey(structure);
  const [dialog, setDialog] = useState<{ kind: "insert" } | { kind: "edit" | "delete"; keys: string[] } | null>(null);
  const actions = key !== null && canFree(access);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<(typeof ROW_PAGE_SIZES)[number]>(50);
  const [sort, setSort] = useState<{ column: string; dir: "asc" | "desc" } | null>(null);
  const [draft, setDraft] = useState<{ column: string; op: FilterOperator; value: string }>({ column: columns[0] ?? "", op: "contains", value: "" });
  const [filter, setFilter] = useState<typeof draft | null>(null);

  const params = new URLSearchParams({ page: String(page), size: String(size) });
  if (sort) {
    params.set("sort", sort.column);
    params.set("dir", sort.dir);
  }
  if (filter) {
    params.set("column", filter.column);
    params.set("op", filter.op);
    if (NEEDS_VALUE(filter.op)) params.set("value", filter.value);
  }
  const rows = useQuery({
    queryKey: [...cacheKey, "rows", table, params.toString()],
    queryFn: () => api.get<DbRowsDto>(`${base}/tables/${encodeURIComponent(table)}/rows?${params}`),
    placeholderData: (previous) => previous,
  });

  function toggleSort(column: string) {
    setPage(1);
    setSort((current) => (current?.column !== column ? { column, dir: "asc" } : current.dir === "asc" ? { column, dir: "desc" } : null));
  }

  function applyFilter(event: SyntheticEvent) {
    event.preventDefault();
    setPage(1);
    setFilter({ ...draft });
  }

  const data = rows.data;
  const first = data && data.rows.length > 0 ? (page - 1) * size + 1 : 0;
  const last = data ? (page - 1) * size + data.rows.length : 0;
  const pages = data?.total != null ? Math.max(1, Math.ceil(data.total / size)) : null;
  const hasNext = data ? (pages !== null ? page < pages : data.rows.length === size) : false;

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={applyFilter} className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-36 gap-1.5">
          <Label htmlFor="filter-column">{t("Column")}</Label>
          <PlainSelect id="filter-column" value={draft.column} options={columns.map((column) => ({ value: column, label: column }))} onChange={(column) => setDraft({ ...draft, column })} />
        </div>
        <div className="grid min-w-36 gap-1.5">
          <Label htmlFor="filter-op">{t("Condition")}</Label>
          <PlainSelect id="filter-op" value={draft.op} options={FILTER_OPERATORS.map((op) => ({ value: op, label: t(OPERATOR_LABELS[op]) }))} onChange={(op) => setDraft({ ...draft, op })} />
        </div>
        {NEEDS_VALUE(draft.op) && (
          <div className="grid min-w-48 flex-1 gap-1.5">
            <Label htmlFor="filter-value">{t("Value")}</Label>
            <Input id="filter-value" className="font-mono" value={draft.value} maxLength={1000} onChange={(event) => setDraft({ ...draft, value: event.target.value })} spellCheck={false} />
          </div>
        )}
        <Button type="submit" variant="outline"><SearchIcon />{t("Filter")}</Button>
        {filter && <Button type="button" variant="ghost" onClick={() => { setFilter(null); setPage(1); }}>{t("Clear")}</Button>}
        {structure.kind === "table" && canChange(access) && (
          <Button type="button" variant="outline" className="ml-auto" onClick={() => setDialog({ kind: "insert" })}><PlusIcon />{t("Insert row")}</Button>
        )}
      </form>
      {structure.kind === "table" && key === null && canFree(access) && (
        <p className="text-sm text-muted-foreground">{t("Rows of this table cannot be edited here: it has no primary key or unique key of NOT NULL columns. Use the SQL console.")}</p>
      )}

      {rows.isError && <Alert variant="destructive"><AlertDescription>{rows.error.message}</AlertDescription></Alert>}
      {rows.isPending && <Skeleton className="h-64 w-full" />}
      {data && (
        <>
          <div className={`overflow-x-auto rounded-lg border ${rows.isFetching ? "opacity-60" : ""}`}>
            <Table>
              <TableHeader className="bg-muted">
                <TableRow>
                  {actions && <TableHead className="w-10" />}
                  {data.columns.map((column) => (
                    <TableHead key={column.name} className="whitespace-nowrap">
                      <button type="button" className="inline-flex cursor-pointer items-center gap-1 font-mono" onClick={() => toggleSort(column.name)} title={column.type}>
                        {column.name}
                        {sort?.column === column.name && (sort.dir === "asc" ? <ArrowUpIcon className="size-3.5" /> : <ArrowDownIcon className="size-3.5" />)}
                      </button>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.length === 0 && (
                  <TableRow><TableCell colSpan={data.columns.length + (actions ? 1 : 0)} className="text-muted-foreground">{filter ? t("No rows match the filter.") : t("The table is empty.")}</TableCell></TableRow>
                )}
                {data.rows.map((row, index) => (
                  // Rows have no id of their own in the grid: their position on the page identifies them.
                  <TableRow key={index}>
                    {actions && (
                      <TableCell>
                        <RowMenu
                          keys={keyValues(data.columns.map((column) => column.name), row, key)}
                          canEdit={canChange(access)}
                          onEdit={(keys) => setDialog({ kind: "edit", keys })}
                          onDelete={(keys) => setDialog({ kind: "delete", keys })}
                        />
                      </TableCell>
                    )}
                    {row.map((value, column) => (
                      <TableCell key={data.columns[column]?.name ?? column} className="max-w-72 font-mono text-xs">
                        <CellValue value={value} column={data.columns[column]?.name ?? ""} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground tabular-nums">
              {data.total === null
                ? t("Rows {{first}}–{{last}}", { first, last })
                : data.exact
                  ? t("Rows {{first}}–{{last}} of {{total}}", { first, last, total: data.total.toLocaleString() })
                  : t("Rows {{first}}–{{last}} of about {{total}}", { first, last, total: data.total.toLocaleString() })}
            </span>
            <div className="flex items-center gap-2">
              <PlainSelect className="w-28" value={String(size)} options={ROW_PAGE_SIZES.map((value) => ({ value: String(value), label: t("{{count}} rows", { count: value }) }))} onChange={(value) => { setSize(Number(value) as typeof size); setPage(1); }} />
              <Button variant="outline" size="icon-sm" aria-label={t("Previous page")} disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeftIcon /></Button>
              <span className="tabular-nums">{pages !== null ? t("Page {{page}} of {{pages}}", { page, pages }) : t("Page {{page}}", { page })}</span>
              <Button variant="outline" size="icon-sm" aria-label={t("Next page")} disabled={!hasNext} onClick={() => setPage(page + 1)}><ChevronRightIcon /></Button>
            </div>
          </div>
        </>
      )}
      {key && (
        <>
          <RowDialog table={table} structure={structure} rowKey={key} keyValues={dialog?.kind === "edit" ? dialog.keys : null} open={dialog?.kind === "insert" || dialog?.kind === "edit"} onOpenChange={(open) => !open && setDialog(null)} />
          {dialog?.kind === "delete" && <DeleteRowDialog table={table} rowKey={key} keyValues={dialog.keys} open onOpenChange={(open) => !open && setDialog(null)} />}
        </>
      )}
      {!key && structure.kind === "table" && (
        <RowDialog table={table} structure={structure} rowKey={[]} keyValues={null} open={dialog?.kind === "insert"} onOpenChange={(open) => !open && setDialog(null)} />
      )}
    </div>
  );
}

function RowMenu({ keys, canEdit, onEdit, onDelete }: { keys: string[] | null; canEdit: boolean; onEdit: (keys: string[]) => void; onDelete: (keys: string[]) => void }) {
  const { t } = useTranslation();
  if (!keys) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("Row actions")} />}><EllipsisVerticalIcon /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuGroup>
          {canEdit && <DropdownMenuItem onClick={() => onEdit(keys)}>{t("Edit")}</DropdownMenuItem>}
          <DropdownMenuItem variant="destructive" onClick={() => onDelete(keys)}>{t("Delete")}</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------- Structure

function StructurePanel({ table, structure }: { table: string; structure: DbStructureDto }) {
  const { t } = useTranslation();
  const { access } = useDb();
  const [dialog, setDialog] = useState<{ kind: "add-column" | "add-index" } | { kind: "edit-column" | "drop-column" | "drop-index"; name: string } | null>(null);
  const editable = structure.kind === "table" && canChange(access);
  const close = (open: boolean) => !open && setDialog(null);
  const column = dialog && "name" in dialog ? structure.columns.find((item) => item.name === dialog.name) ?? null : null;
  return (
    <div className="flex flex-col gap-6">
      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "add-column" })}><PlusIcon />{t("Add column")}</Button>
          <Button variant="outline" size="sm" onClick={() => setDialog({ kind: "add-index" })}><PlusIcon />{t("Add index")}</Button>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead>{t("Column")}</TableHead>
              <TableHead>{t("Type")}</TableHead>
              <TableHead>NULL</TableHead>
              <TableHead>{t("Default")}</TableHead>
              <TableHead>{t("Key")}</TableHead>
              <TableHead>{t("Extra")}</TableHead>
              <TableHead>{t("Comment")}</TableHead>
              {editable && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {structure.columns.map((column) => (
              <TableRow key={column.name}>
                <TableCell className="font-mono font-medium">{column.name}</TableCell>
                <TableCell className="font-mono text-xs">{column.type}</TableCell>
                <TableCell>{column.nullable ? t("Yes") : t("No")}</TableCell>
                <TableCell className="font-mono text-xs">{column.default ?? <span className="text-muted-foreground italic">{column.nullable ? "NULL" : "—"}</span>}</TableCell>
                <TableCell>{column.key && <Badge variant="outline">{column.key}</Badge>}</TableCell>
                <TableCell className="text-xs">{column.extra}</TableCell>
                <TableCell className="text-muted-foreground">{column.comment}</TableCell>
                {editable && (
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("Actions for {{name}}", { name: column.name })} />}><EllipsisVerticalIcon /></DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-36">
                        <DropdownMenuGroup>
                          <DropdownMenuItem onClick={() => setDialog({ kind: "edit-column", name: column.name })}>{t("Edit")}</DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" disabled={structure.columns.length === 1} onClick={() => setDialog({ kind: "drop-column", name: column.name })}>{t("Delete")}</DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {structure.kind === "table" && (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">{t("Indexes")}</h3>
          {structure.indexes.length === 0
            ? <p className="text-sm text-muted-foreground">{t("The table has no indexes.")}</p>
            : (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader className="bg-muted">
                    <TableRow>
                      <TableHead>{t("Name")}</TableHead>
                      <TableHead>{t("Columns")}</TableHead>
                      <TableHead>{t("Unique")}</TableHead>
                      <TableHead>{t("Type")}</TableHead>
                      {editable && <TableHead className="w-24" />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {structure.indexes.map((index) => (
                      <TableRow key={index.name}>
                        <TableCell className="font-mono">{index.name}</TableCell>
                        <TableCell className="font-mono text-xs">{index.columns.join(", ")}</TableCell>
                        <TableCell>{index.unique ? t("Yes") : t("No")}</TableCell>
                        <TableCell className="text-xs">{index.type}</TableCell>
                        {editable && (
                          <TableCell>
                            <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "drop-index", name: index.name })}>{t("Delete")}</Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
        </div>
      )}
      <div className="grid gap-2">
        <h3 className="text-sm font-medium">{t("Definition")}</h3>
        <pre className="max-h-96 overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs whitespace-pre">{structure.createSql}</pre>
      </div>
      {editable && (
        <>
          <AddColumnDialog table={table} columns={structure.columns} open={dialog?.kind === "add-column"} onOpenChange={close} />
          <AddIndexDialog table={table} structure={structure} open={dialog?.kind === "add-index"} onOpenChange={close} />
          <EditColumnDialog table={table} column={column} open={dialog?.kind === "edit-column"} onOpenChange={close} />
          {dialog?.kind === "drop-column" && (
            <ConfirmSqlDialog open onOpenChange={close} title={t("Delete column {{column}}", { column: dialog.name })} description={t("Deletes the column and its values in every row. It cannot be undone.")} sql={dropColumnSql(table, dialog.name)} submitLabel={t("Delete column")} success={t("Column {{column}} deleted", { column: dialog.name })} />
          )}
          {dialog?.kind === "drop-index" && (
            <ConfirmSqlDialog open onOpenChange={close} title={t("Delete index {{index}}", { index: dialog.name })} description={t("The data stays; queries that used the index may get slower.")} sql={dropIndexSql(table, dialog.name)} submitLabel={t("Delete index")} success={t("Index {{index}} deleted", { index: dialog.name })} />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- Page

function TableList({ tables, selected, onSelect }: { tables: DbTableDto[]; selected?: string; onSelect: (name: string) => void }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const visible = tables.filter((table) => table.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="flex flex-col gap-2">
      {tables.length > 8 && <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("Search tables")} aria-label={t("Search tables")} />}
      <nav aria-label={t("Tables")} className="flex max-h-[32rem] flex-col overflow-y-auto">
        {visible.map((table) => (
          <button
            key={table.name}
            type="button"
            onClick={() => onSelect(table.name)}
            aria-current={table.name === selected ? "true" : undefined}
            className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted aria-[current=true]:font-medium"
          >
            <span className="min-w-0 truncate font-mono">{table.name}</span>
            {table.kind === "view"
              ? <Badge variant="outline">{t("view")}</Badge>
              : <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{table.rows?.toLocaleString() ?? ""}</span>}
          </button>
        ))}
        {visible.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">{tables.length === 0 ? t("The database has no tables yet.") : t("No table matches.")}</p>}
      </nav>
    </div>
  );
}

export function DatabaseExplorerPage() {
  const { t } = useTranslation();
  const { username, database } = route.useParams();
  const search = route.useSearch();
  const navigate = useNavigate();
  const base = `/accounts/${username}/databases/${database}`;
  const account = useQuery({ queryKey: ["accounts", username], queryFn: () => api.get<AccountDto>(`/accounts/${username}`) });
  const tables = useQuery({ queryKey: ["db", username, database, "tables"], queryFn: () => api.get<DbTableDto[]>(`${base}/tables`) });
  const selected = tables.data?.find((table) => table.name === search.table);
  const structure = useQuery({
    queryKey: ["db", username, database, "structure", selected?.name],
    queryFn: () => api.get<DbStructureDto>(`${base}/tables/${encodeURIComponent(selected?.name ?? "")}/structure`),
    enabled: Boolean(selected),
  });
  const view: ExplorerView = search.view ?? "rows";
  const tab: ExplorerTab = search.tab ?? "tables";
  const access: DbAccess = account.data?.suspended ? "readonly" : account.data?.dbBlocked ? "blocked" : "full";
  const [creating, setCreating] = useState(false);
  const totalBytes = tables.data?.reduce((sum, table) => sum + table.dataBytes + table.indexBytes, 0) ?? 0;
  const go = (next: ExplorerSearch) => void navigate({ to: "/accounts/$username/databases/$database", params: { username, database }, search: next });

  return (
    <DbProvider value={{ username, database, base, access }}>
    <Page>
      <SqlTypeList />
      <div>
        <Button variant="link" className="h-auto p-0" nativeButton={false} render={<Link to="/accounts/$username/$tab" params={{ username, tab: "databases" }} />}>← {t("Databases of {{username}}", { username })}</Button>
        <h2 className="mt-1 font-mono text-lg font-medium">{database}</h2>
      </div>
      {account.data?.dbBlocked && (
        <Alert variant="destructive">
          <AlertTitle>{t("Writes blocked")}</AlertTitle>
          <AlertDescription>{t("The account exceeded its database limit: you can browse, export and delete data, but not add any.")}</AlertDescription>
        </Alert>
      )}
      {account.data?.suspended && (
        <Alert>
          <AlertTitle>{t("Account suspended")}</AlertTitle>
          <AlertDescription>{t("The database can be browsed and exported, but not changed.")}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}><DownloadIcon />{t("Export")}</DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuItem render={<a href={`/api${base}/export`} download />}>{t("Structure and data (.sql.gz)")}</DropdownMenuItem>
              <DropdownMenuItem render={<a href={`/api${base}/export?structure=1`} download />}>{t("Structure only (.sql.gz)")}</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {account.data && <ImportDialog account={account.data} database={database} />}
        <Tabs value={tab} onValueChange={(next) => go(next === "sql" || next === "processes" ? { tab: next } : { table: search.table })} className="ml-auto">
          <TabsList>
            <TabsTrigger value="tables">{t("Tables")}</TabsTrigger>
            <TabsTrigger value="sql">SQL</TabsTrigger>
            <TabsTrigger value="processes">{t("Processes")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {tab === "sql" && <Card><CardContent><SqlConsole /></CardContent></Card>}
      {tab === "processes" && <Card><CardContent><ProcessesPanel /></CardContent></Card>}
      {tab === "tables" && tables.isError && <Alert variant="destructive"><AlertDescription>{tables.error.message}</AlertDescription></Alert>}
      {tab === "tables" && tables.isPending && <Skeleton className="h-64 w-full" />}
      {tab === "tables" && tables.data && (
        <div className="grid items-start gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <Card size="sm">
            <CardHeader>
              <CardTitle>{t("Tables")}</CardTitle>
              <CardDescription>{t("{{count}} tables · {{size}}", { count: tables.data.length, size: formatBytes(totalBytes) })}</CardDescription>
              {canChange(access) && (
                <CardAction>
                  <Button variant="outline" size="icon-sm" aria-label={t("New table")} onClick={() => setCreating(true)}><PlusIcon /></Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent>
              <TableList tables={tables.data} selected={selected?.name} onSelect={(table) => go({ table })} />
            </CardContent>
          </Card>
          <Card className="min-w-0">
            {!selected && (
              <CardContent>
                <p className="text-sm text-muted-foreground">{search.table ? t("The table {{table}} does not exist.", { table: search.table }) : t("Choose a table to see its rows and structure.")}</p>
              </CardContent>
            )}
            {selected && (
              <>
                <CardHeader>
                  <CardTitle className="font-mono">{selected.name}</CardTitle>
                  <CardDescription>
                    {selected.kind === "view"
                      ? t("View")
                      : [selected.engine, formatBytes(selected.dataBytes + selected.indexBytes), selected.collation, selected.comment].filter(Boolean).join(" · ")}
                  </CardDescription>
                  <CardAction className="flex flex-wrap items-center justify-end gap-2">
                    <TableActions key={selected.name} table={selected} onRenamed={(name) => go({ table: name, view: search.view })} onDropped={() => go({})} />
                    <Tabs value={view} onValueChange={(next) => go({ table: selected.name, view: next === "structure" ? "structure" : undefined })}>
                      <TabsList>
                        <TabsTrigger value="rows">{t("Rows")}</TabsTrigger>
                        <TabsTrigger value="structure">{t("Structure")}</TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  {structure.isError && <Alert variant="destructive"><AlertDescription>{structure.error.message}</AlertDescription></Alert>}
                  {structure.isPending && <Skeleton className="h-48 w-full" />}
                  {structure.data && view === "structure" && <StructurePanel table={selected.name} structure={structure.data} />}
                  {structure.data && view === "rows" && (
                    <RowsPanel key={selected.name} base={base} cacheKey={["db", username, database]} table={selected.name} structure={structure.data} />
                  )}
                </CardContent>
              </>
            )}
          </Card>
        </div>
      )}
      <CreateTableDialog open={creating} onOpenChange={setCreating} onCreated={(table) => go({ table, view: "structure" })} />
    </Page>
    </DbProvider>
  );
}

