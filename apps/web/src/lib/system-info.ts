import { useQuery } from "@tanstack/react-query";
import { api, type SystemInfo } from "@/lib/api";

/** Server status from the agent, refreshed every 15 s. Shared by the shell, the sidebar and the overview. */
export function useSystemInfo() {
  return useQuery({
    queryKey: ["system-info"],
    queryFn: () => api.get<SystemInfo>("/system/info"),
    refetchInterval: 15_000,
    retry: false,
  });
}
