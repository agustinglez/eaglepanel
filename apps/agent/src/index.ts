import { chmodSync, chownSync, rmSync } from "node:fs";
import { SandboxHost, SystemHost } from "./host";
import { MAX_REQUEST_BYTES, handle } from "./server";

if (process.env.EAGLEPANEL_SANDBOX === "1") {
  const host = new SandboxHost(process.env.EAGLEPANEL_SANDBOX_DIR ?? ".sandbox");
  const port = Number(process.env.AGENT_DEV_PORT ?? 8091);
  // TCP exists only in sandbox mode, and only on loopback. Production uses the Unix socket.
  Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, maxRequestBodySize: MAX_REQUEST_BYTES, fetch: (req) => handle(req, host) });
  console.log(`[agent] SANDBOX at 127.0.0.1:${port}`);
} else {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("The real agent requires Linux and root. For development, set EAGLEPANEL_SANDBOX=1");
  }
  const socketPath = process.env.AGENT_SOCKET ?? "/run/eaglepanel/agent.sock";
  const socketGid = Number(process.env.AGENT_SOCKET_GID);
  if (!Number.isInteger(socketGid) || socketGid <= 0) {
    throw new Error("AGENT_SOCKET_GID must be the GID of the eaglepanel group");
  }

  const host = new SystemHost();
  rmSync(socketPath, { force: true });
  Bun.serve({ unix: socketPath, maxRequestBodySize: MAX_REQUEST_BYTES, fetch: (req) => handle(req, host) });
  chownSync(socketPath, 0, socketGid);
  chmodSync(socketPath, 0o660);
  console.log(`[agent] listening on ${socketPath}`);
}
