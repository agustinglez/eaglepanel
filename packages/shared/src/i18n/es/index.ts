import { common } from "./common";
import { server } from "./server";
import { web } from "./web";

/**
 * Spanish (neutral) catalog. Key: the English text exactly as it appears in the code. Value: the translation.
 * Keep `{{placeholders}}` identical. Plurals use `_one` / `_other` suffixes, as in i18next.
 * Split by area only to keep files manageable: all of them end up in one flat catalog.
 */
export const es: Record<string, string> = { ...common, ...web, ...server };

/** Only what the server can send: the web UI texts stay out, so they never match a server message by accident. */
export const esServer: Record<string, string> = { ...common, ...server };
