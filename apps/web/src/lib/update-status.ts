import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateStatusDto } from "@eaglepanel/shared";
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

/** Asks the API to check now, instead of waiting for the next scheduled check. */
export function useCheckForUpdates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<UpdateStatusDto>("/system/update/check"),
    onSuccess: (data) => queryClient.setQueryData(["update-status"], data),
  });
}
