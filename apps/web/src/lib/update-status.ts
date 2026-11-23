import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PanelUpgradeStatusDto, UpdateStatusDto } from "@eaglepanel/shared";
import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";

/** Installed and latest version. The API checks the source every 30 min; this only reads its result. */
export function useUpdateStatus() {
  return useQuery({
    queryKey: ["update-status"],
    queryFn: () => api.get<UpdateStatusDto>("/system/update"),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });
}

// Whether this tab started an upgrade: shared by the updates dialog, which starts it, and the Updates page, which follows it.
let following = false;
const listeners = new Set<() => void>();
function setFollowing(value: boolean) {
  following = value;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * The panel upgrade started from the panel. While this tab follows it, it is polled every 2 s; the API restarts in the
 * middle, so failed requests are expected then and are not retried by react-query (the next poll retries).
 */
export function usePanelUpgrade() {
  const isFollowing = useSyncExternalStore(subscribe, () => following);
  const progress = useQuery({
    queryKey: ["panel-upgrade"],
    queryFn: () => api.get<PanelUpgradeStatusDto>("/system/update/install"),
    refetchInterval: (query) => (isFollowing || query.state.data?.running ? 2000 : false),
    retry: false,
  });
  return { progress, following: isFollowing };
}

/** Starts `eagle upgrade` to the latest version; the Updates page then shows its progress. */
export function useStartPanelUpgrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/system/update/install"),
    onSuccess: () => {
      setFollowing(true);
      void queryClient.invalidateQueries({ queryKey: ["panel-upgrade"] });
    },
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
