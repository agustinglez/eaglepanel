import i18n, { serverText } from "@/lib/i18n";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "x-eaglepanel": "1",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new ApiError(response.status, data?.error ? serverText(data.error) : i18n.t("Unexpected server error"));
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
};

export interface SystemInfo {
  hostname: string;
  platform: string;
  release: string;
  /** Distribution name, such as "Ubuntu 24.04.1 LTS". Null where /etc/os-release does not exist. */
  osName: string | null;
  uptimeSeconds: number;
  loadAverage: number[];
  memory: { totalBytes: number; freeBytes: number };
  sandbox: boolean;
}
