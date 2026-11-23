import {
  agentOps,
  agentRequestSchema,
  type AgentOpName,
  type AgentOpParams,
  type AgentOpResult,
  type AgentResponse,
} from "@eaglepanel/shared";
import { readFileSync } from "node:fs";
import { hostname, loadavg, platform, release, totalmem, freemem, uptime } from "node:os";
import type { Host } from "./host";
import { hostingHandlers } from "./hosting";
import { packageHandlers } from "./packages";
import { panelUpgradeHandlers } from "./panel-upgrade";
import { wordpressHandlers } from "./wordpress";

/** PRETTY_NAME from /etc/os-release, read once: it only changes with a distribution upgrade, which restarts the agent. */
let osName: string | null | undefined;
function readOsName(): string | null {
  if (osName !== undefined) return osName;
  try {
    const match = readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME=(?:"([^"]*)"|(.*))$/m);
    osName = match ? (match[1] ?? match[2] ?? "").trim() || null : null;
  } catch {
    osName = null;
  }
  return osName;
}

type Handlers = {
  [N in AgentOpName]: (params: AgentOpParams<N>, host: Host) => Promise<AgentOpResult<N>>;
};

const handlers: Handlers = {
  "system.ping": async (_params, host) => ({ pong: true, sandbox: host.sandbox }),
  "system.info": async (_params, host) => ({
    hostname: hostname(),
    platform: platform(),
    release: release(),
    osName: readOsName(),
    uptimeSeconds: uptime(),
    loadAverage: loadavg(),
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    sandbox: host.sandbox,
  }),
  ...hostingHandlers,
  ...packageHandlers,
  ...panelUpgradeHandlers,
  ...wordpressHandlers,
};

function isOpName(op: string): op is AgentOpName {
  return Object.hasOwn(agentOps, op);
}

export async function dispatch(body: unknown, host: Host): Promise<AgentResponse> {
  const request = agentRequestSchema.safeParse(body);
  if (!request.success) {
    return { ok: false, error: { code: "invalid_request", message: "Invalid request" } };
  }

  const { op, params } = request.data;
  if (!isOpName(op)) {
    return { ok: false, error: { code: "unknown_op", message: "Unknown operation" } };
  }

  const parsed = agentOps[op].params.safeParse(params);
  if (!parsed.success) {
    return { ok: false, error: { code: "invalid_params", message: parsed.error.issues[0]?.message ?? "Invalid parameters" } };
  }

  try {
    const handler = handlers[op] as (params: unknown, host: Host) => Promise<unknown>;
    return { ok: true, result: await handler(parsed.data, host) };
  } catch (error) {
    console.error(`[agent] ${op} failed:`, error);
    return { ok: false, error: { code: "op_failed", message: error instanceof Error ? error.message : "Internal error" } };
  }
}
