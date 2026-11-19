import { ACCOUNT_HOOK_PATH, GLOBAL_HOOK_PATH } from "@eaglepanel/shared";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Env, Hono } from "hono";

/**
 * GitHub webhook, like the Coolify "manual webhook": one URL for several apps, one secret per app, and the app is
 * chosen by the repository and branch of the push. The API listens only on 127.0.0.1: requests arrive through OLS,
 * which publishes only these paths, on the server-wide domain or on the one each account chose.
 */

/** GitHub sends pushes of several MB when they carry many commits: more than this is not a reasonable push. */
export const MAX_HOOK_BYTES = 5 * 1024 * 1024;

/** `github.com/user/repo` in lowercase, whether HTTPS, SSH or with .git: this is how the panel URL and the push URL are compared. */
export function normalizeRepo(url: string): string | null {
  const match = /^(?:https:\/\/|ssh:\/\/git@|git@)([a-z0-9.-]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}` : null;
}

/** `X-Hub-Signature-256`: HMAC-SHA256 of the body exactly as received, with the app secret. */
export function validSignature(secret: string, body: Uint8Array, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** GitHub sends JSON or, if the webhook is configured that way, the JSON inside the `payload` field of a form. */
export function parsePayload(contentType: string | undefined, body: Uint8Array): Record<string, unknown> | null {
  try {
    const text = new TextDecoder().decode(body);
    const json = contentType?.includes("application/x-www-form-urlencoded") ? new URLSearchParams(text).get("payload") : text;
    const parsed: unknown = json ? JSON.parse(json) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface HookApp {
  /** Its environment. */
  vhost: number;
  username: string;
  repoUrl: string;
  branch: string;
  webhookSecret: string | null;
}

export interface WebhookDeps {
  /** Server-wide domain, if one is configured. */
  hooksDomain: () => string | null;
  /** Account that chose this environment as its webhook domain. */
  accountForHookDomain: (fqdn: string) => string | null;
  apps: () => HookApp[];
  /** Enters the app queue: starts now or when the running deployment finishes. */
  deploy: (vhost: number, trigger: string, commit?: string) => { jobId: string | null; position: number } | { error: string };
}

export function registerWebhookRoutes<E extends Env>(app: Hono<E>, { hooksDomain, accountForHookDomain, apps, deploy }: WebhookDeps) {
  const handler = (path: string) => app.post(path, async (c) => {
    // OLS picks the vhost by Host: the domain GitHub called arrives here.
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "").toLowerCase();
    const username = path === ACCOUNT_HOOK_PATH ? accountForHookDomain(host) : null;
    if (path === GLOBAL_HOOK_PATH ? host !== hooksDomain() : !username) return c.json({ error: "Not found" }, 404);

    if (Number(c.req.header("content-length") ?? 0) > MAX_HOOK_BYTES) return c.json({ error: "Too large" }, 413);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > MAX_HOOK_BYTES) return c.json({ error: "Too large" }, 413);
    const payload = parsePayload(c.req.header("content-type"), body);
    const repository = payload?.repository as Record<string, unknown> | undefined;
    const repo = [repository?.html_url, repository?.clone_url, repository?.ssh_url]
      .map((value) => (typeof value === "string" ? normalizeRepo(value) : null)).find(Boolean);

    // No response reveals whether the repository exists in the panel: without a valid signature, it is always the same.
    const signature = c.req.header("x-hub-signature-256");
    const verified = apps().filter((item) =>
      item.webhookSecret && (username === null || item.username === username)
      && repo && normalizeRepo(item.repoUrl) === repo && validSignature(item.webhookSecret, body, signature));
    if (verified.length === 0) return c.json({ error: "Invalid signature" }, 401);

    const event = c.req.header("x-github-event");
    if (event === "ping") return c.json({ ok: true, apps: verified.map(({ vhost }) => vhost) });
    if (event !== "push") return c.json({ ignored: `evento ${event ?? "desconocido"}` }, 202);
    const ref = typeof payload?.ref === "string" ? payload.ref : "";
    if (payload?.deleted === true || !ref.startsWith("refs/heads/")) return c.json({ ignored: "not a push to a branch" }, 202);
    const branch = ref.slice("refs/heads/".length);
    // The push commit is deployed, not the branch tip: if it is queued, each push gets its own release.
    const commit = typeof payload?.after === "string" && /^[0-9a-f]{40}$/.test(payload.after) ? payload.after : undefined;

    const deployed: number[] = [];
    const queued: { vhost: number; position: number }[] = [];
    const skipped: { vhost: number; reason: string }[] = [];
    for (const item of verified.filter((candidate) => candidate.branch === branch)) {
      const result = deploy(item.vhost, `GitHub webhook, ${branch} ${commit?.slice(0, 7) ?? ""}`.trim(), commit);
      if ("error" in result) skipped.push({ vhost: item.vhost, reason: result.error });
      else if (result.jobId) deployed.push(item.vhost);
      else queued.push({ vhost: item.vhost, position: result.position });
    }
    return c.json({ deployed, queued, skipped }, 202);
  });
  handler(GLOBAL_HOOK_PATH);
  handler(ACCOUNT_HOOK_PATH);
}
