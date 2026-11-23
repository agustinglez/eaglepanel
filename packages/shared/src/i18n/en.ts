/**
 * English needs entries only for plural forms: every other key is already its own English text.
 * i18next picks `key_one` / `key_other` from `count`.
 */
export const en: Record<string, string> = {
  "{{count}} environments_one": "{{count}} environment",
  "{{count}} environments_other": "{{count}} environments",
  "Restarted {{count}} times since the last start._one": "Restarted once since the last start.",
  "Restarted {{count}} times since the last start._other": "Restarted {{count}} times since the last start.",
  "{{count}} deployments queued._one": "{{count}} deployment queued.",
  "{{count}} deployments queued._other": "{{count}} deployments queued.",
  "app · {{count}} variables_one": "app · {{count}} variable",
  "app · {{count}} variables_other": "app · {{count}} variables",
  "{{count}} rows_one": "{{count}} row",
  "{{count}} rows_other": "{{count}} rows",
  "{{count}} tables · {{size}}_one": "{{count}} table · {{size}}",
  "{{count}} tables · {{size}}_other": "{{count}} tables · {{size}}",
  "First {{count}} rows, in {{ms}} ms. Add a LIMIT or a WHERE to see others._one": "Showing {{count}} row, in {{ms}} ms. Add a LIMIT or a WHERE to see others.",
  "First {{count}} rows, in {{ms}} ms. Add a LIMIT or a WHERE to see others._other": "First {{count}} rows, in {{ms}} ms. Add a LIMIT or a WHERE to see others.",
  "{{count}} rows in {{ms}} ms._one": "{{count}} row in {{ms}} ms.",
  "{{count}} rows in {{ms}} ms._other": "{{count}} rows in {{ms}} ms.",
  "{{count}} known vulnerabilities in {{names}}_one": "{{count}} known vulnerability in {{names}}",
  "{{count}} known vulnerabilities in {{names}}_other": "{{count}} known vulnerabilities in {{names}}",
  "{{count}} installations_one": "{{count}} installation",
  "{{count}} installations_other": "{{count}} installations",
  "{{count}} need attention_one": "{{count}} needs attention",
  "{{count}} need attention_other": "{{count}} need attention",
};
