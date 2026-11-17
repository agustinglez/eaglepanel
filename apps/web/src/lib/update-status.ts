import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateStatusDto } from "@eaglepanel/shared";
import { api } from "@/lib/api";

/** Installed and latest version. The API checks the source every 6 h; this only reads its result. */
export function useUpdateStatus() {
  return useQuery({
    queryKey: ["update-status"],
    queryFn: () => api.get<UpdateStatusDto>("/system/update"),
    refetchInterval: 60 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
  });
}

/** Asks the API to check now, instead of waiting for the next scheduled check. */
export function useCheckForUpdates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<UpdateStatusDto>("/system/update/check"),
    onSuccess: (data) => queryClient.setQueryData(["update-status"], data),
  });
}

const DISMISS_KEY = "eaglepanel.update-dismissed";

/** The notice can be hidden for one version: it shows again when a newer one is published. */
export function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function dismissVersion(version: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, version);
  } catch {
    // Without storage the notice simply stays.
  }
}
