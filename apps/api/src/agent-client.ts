import { agentOps, type AgentOpName, type AgentOpParams, type AgentOpResult, type AgentResponse } from "@eaglepanel/shared";

export interface AgentClient {
  call<N extends AgentOpName>(op: N, params: AgentOpParams<N>): Promise<AgentOpResult<N>>;
  /**
   * File manager uploads and downloads: the content is streamed, without loading it into memory.
   * Returns the agent response as is; if it is not 2xx, it carries `{ error }`.
   */
  stream?(path: "/files/download" | "/files/upload" | "/exports/download" | "/db/export" | "/db/upload" | "/mail/import/upload", query: Record<string, string>, body?: ReadableStream<Uint8Array>, length?: number): Promise<Response>;
}

export type AgentTarget = { socket: string } | { url: string };

export function createAgentClient(target: AgentTarget): AgentClient {
  return {
    async call(op, params) {
      const init: RequestInit & { unix?: string } = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, params }),
        // A build can take up to 20 minutes: the agent stops it before that.
        signal: AbortSignal.timeout(25 * 60 * 1000),
      };
      const endpoint = "socket" in target ? "http://agent/op" : `${target.url}/op`;
      if ("socket" in target) init.unix = target.socket;

      const response = await fetch(endpoint, init);
      const body = (await response.json()) as AgentResponse;
      if (!body.ok) {
        throw new Error(body.error.message);
      }
      return agentOps[op].result.parse(body.result) as AgentOpResult<typeof op>;
    },
    async stream(path, query, body, length) {
      const search = new URLSearchParams(query).toString();
      const endpoint = "socket" in target ? `http://agent${path}?${search}` : `${target.url}${path}?${search}`;
      const init: RequestInit & { unix?: string; duplex?: "half" } = {
        method: "POST",
        headers: length === undefined ? {} : { "content-length": String(length) },
        ...(body ? { body, duplex: "half" as const } : {}),
      };
      if ("socket" in target) init.unix = target.socket;
      return fetch(endpoint, init);
    },
  };
}
