import { ENABLED_LOCALES, LOCALE_NAMES, type Locale } from "@eaglepanel/shared";
import { LanguagesIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { currentLocale } from "@/lib/i18n";

const items = ENABLED_LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale] }));

/** Interface language. The choice is kept in this browser. */
export function LanguageSelect({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  return (
    <Select items={items} value={currentLocale()} onValueChange={(next) => next && void i18n.changeLanguage(next as Locale)}>
      <SelectTrigger size="sm" className={className} aria-label={t("Language")}>
        <LanguagesIcon />
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
