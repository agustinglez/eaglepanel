import { z } from "zod";
import type { VulnerabilityDto } from "./packages";
import { docRootSchema, usernameSchema } from "./validators";

/** Plugin or theme of an installation, as its own header declares it. */
const wpExtensionSchema = z.object({
  /** Directory name (or file name without `.php` for a single-file plugin): what WordPress.org and Wordfence index by. */
  slug: z.string(),
  name: z.string(),
  /** Empty when the header has no `Version:`. */
  version: z.string(),
});

const wpInstallSchema = z.object({
  username: z.string(),
  vhost: z.number().int(),
  /** Relative to the account home directory: `sites/acme/public_html` or `sites/acme/public_html/blog`. */
  path: z.string(),
  version: z.string(),
  multisite: z.boolean(),
  plugins: z.array(wpExtensionSchema),
  themes: z.array(wpExtensionSchema),
});

export const MAX_WORDPRESS_SITES = 2000;

export const wordpressOps = {
  /**
   * Looks for WordPress installations in the document roots of the given environments and one or two levels below
   * them (a blog in `/blog`), and reads the versions of core, plugins and themes from their files. It runs as each
   * account user and never loads PHP: it only reads headers.
   */
  "wordpress.scan": {
    params: z
      .object({
        sites: z.array(z.object({ username: usernameSchema, vhost: z.number().int().positive(), docRoot: docRootSchema }).strict()).max(MAX_WORDPRESS_SITES),
      })
      .strict(),
    result: z.object({
      installs: z.array(wpInstallSchema),
      /** Accounts whose scan failed, with the reason. Their installations are missing from `installs`. */
      errors: z.array(z.object({ username: z.string(), message: z.string() })),
    }),
  },
} as const;

export type WpExtension = z.infer<typeof wpExtensionSchema>;
export type WpInstall = z.infer<typeof wpInstallSchema>;

/**
 * `up-to-date` / `outdated`: compared with WordPress.org. `unknown`: not on WordPress.org (premium, custom or
 * removed long ago), so nothing can tell whether it is current. `closed`: WordPress.org closed it and it gets no more
 * updates; `closedReason` says why (a security issue, the author asked...).
 */
export type WpExtensionStatus = "up-to-date" | "outdated" | "unknown" | "closed";

export interface WpExtensionDto extends WpExtension {
  latest: string | null;
  status: WpExtensionStatus;
  closedReason: string | null;
  vulnerabilities: VulnerabilityDto[];
}

/** `insecure`: WordPress.org marks that release as having known security problems; `outdated`: there is a newer one. */
export type WpCoreStatus = "latest" | "outdated" | "insecure" | "unknown";

export interface WordPressInstallDto {
  /** `<vhost>:<path>`: stable while the installation stays in place. */
  id: string;
  username: string;
  vhostId: number;
  vhostSlug: string;
  vhostName: string;
  hostname: string;
  /** Relative to the account home directory. */
  path: string;
  /** Below the document root, with a leading slash: "/" or "/blog". What a visitor sees in the URL. */
  urlPath: string;
  version: string;
  latest: string | null;
  coreStatus: WpCoreStatus;
  multisite: boolean;
  coreVulnerabilities: VulnerabilityDto[];
  plugins: WpExtensionDto[];
  themes: WpExtensionDto[];
}

export interface WordPressStatusDto {
  installs: WordPressInstallDto[];
  /** Newest WordPress release. */
  latestCore: string | null;
  /** Last finished scan of the server. */
  checkedAt: number | null;
  checking: boolean;
  /** The scan failed (agent not responding), or some accounts could not be read. */
  error: string | null;
  /** WordPress.org did not answer: versions keep their last known latest. */
  versionsError: string | null;
  vulnerabilities: {
    /** Whether a Wordfence Intelligence API key is saved. Without it, no vulnerabilities are looked up. */
    configured: boolean;
    /** When the Wordfence feed was last downloaded. */
    updatedAt: number | null;
    /** Records in the feed index (plugins, themes and core). */
    records: number;
    error: string | null;
  };
}

export interface WordPressSettingsDto {
  wordfenceConfigured: boolean;
}
