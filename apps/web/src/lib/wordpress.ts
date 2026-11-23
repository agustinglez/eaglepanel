import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VulnerabilityDto, WordPressInstallDto, WordPressStatusDto } from "@eaglepanel/shared";
import { api } from "@/lib/api";

/** WordPress installations, versions and vulnerabilities. The API checks every hour; this only reads its result. */
export function useWordPressStatus() {
  return useQuery({
    queryKey: ["wordpress"],
    queryFn: () => api.get<WordPressStatusDto>("/wordpress"),
    // While a check runs, ask again soon to show its result.
    refetchInterval: (query) => (query.state.data?.checking ? 3000 : 5 * 60 * 1000),
    staleTime: 60 * 1000,
  });
}

/** Scans the sites and asks WordPress.org and Wordfence again, without waiting for the next scheduled check. */
export function useCheckWordPress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<WordPressStatusDto>("/wordpress/check"),
    onSuccess: (data) => queryClient.setQueryData(["wordpress"], data),
  });
}

export function installVulnerabilities(install: WordPressInstallDto): VulnerabilityDto[] {
  return [...install.coreVulnerabilities, ...install.plugins.flatMap((p) => p.vulnerabilities), ...install.themes.flatMap((t) => t.vulnerabilities)];
}

/** Something to act on: an old or insecure core, an outdated or closed extension, or a known vulnerability. */
export function needsAttention(install: WordPressInstallDto): boolean {
  return (
    install.coreStatus === "outdated" ||
    install.coreStatus === "insecure" ||
    [...install.plugins, ...install.themes].some((e) => e.status === "outdated" || e.status === "closed") ||
    installVulnerabilities(install).length > 0
  );
}
