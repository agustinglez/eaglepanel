import type { AccountLimits } from "@eaglepanel/shared";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** As the form sees them: disk and database storage are edited in GB. */
export type LimitsForm = Record<keyof AccountLimits, string>;

export const limitsToForm = (limits: AccountLimits): LimitsForm => ({
  quotaMb: String(limits.quotaMb / 1024),
  domains: String(limits.domains),
  vhosts: String(limits.vhosts),
  databases: String(limits.databases),
  dbStorageMb: String(limits.dbStorageMb / 1024),
  appMemoryMb: String(limits.appMemoryMb),
});

export const limitsFromForm = (form: LimitsForm): AccountLimits => ({
  quotaMb: Math.round(Number(form.quotaMb) * 1024),
  domains: Number(form.domains),
  vhosts: Number(form.vhosts),
  databases: Number(form.databases),
  dbStorageMb: Math.round(Number(form.dbStorageMb) * 1024),
  appMemoryMb: Number(form.appMemoryMb),
});

const FIELDS: { key: keyof AccountLimits; label: string; min: string; step: string; hint?: string }[] = [
  { key: "quotaMb", label: "Disk (GB)", min: "0.1", step: "0.1" },
  { key: "domains", label: "Domains", min: "1", step: "1" },
  { key: "vhosts", label: "Additional environments", min: "0", step: "1", hint: "Excluding the primary one." },
  { key: "databases", label: "Databases", min: "0", step: "1" },
  { key: "dbStorageMb", label: "Database storage (GB)", min: "0.1", step: "0.1", hint: "Account total." },
  { key: "appMemoryMb", label: "App memory (MB)", min: "0", step: "64", hint: "Account total." },
];

export function LimitFields({ value, onChange }: { value: LimitsForm; onChange: (value: LimitsForm) => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {FIELDS.map(({ key, label, min, step, hint }) => (
        <div key={key} className="grid content-start gap-2">
          <Label htmlFor={`limit-${key}`}>{t(label)}</Label>
          <Input
            id={`limit-${key}`}
            type="number"
            min={min}
            step={step}
            value={value[key]}
            onChange={(event) => onChange({ ...value, [key]: event.target.value })}
            required
          />
          {hint && <p className="text-sm text-muted-foreground">{t(hint)}</p>}
        </div>
      ))}
    </div>
  );
}
