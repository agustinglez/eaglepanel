import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PackagesStatusDto, SystemPackageDto, VulnerabilityDto } from "@eaglepanel/shared";
import { api } from "@/lib/api";
import { useUpdateStatus } from "@/lib/update-status";

/** Versions, updates and CVEs of the system packages. The API checks every 30 min; this only reads its result. */
export function usePackagesStatus() {
  return useQuery({
    queryKey: ["system-packages"],
    queryFn: () => api.get<PackagesStatusDto>("/system/packages"),
    // While a check runs, ask again soon to show its result.
    refetchInterval: (query) => (query.state.data?.checking ? 3000 : 5 * 60 * 1000),
    staleTime: 60 * 1000,
  });
}

/** Refreshes the apt lists and asks the vulnerability sources again, without waiting for the next scheduled check. */
export function useCheckPackages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<PackagesStatusDto>("/system/packages/check"),
    onSuccess: (data) => queryClient.setQueryData(["system-packages"], data),
  });
}

/** Only critical and high ones raise a notice; the rest are listed on the Updates page. */
export const noticeable = (v: VulnerabilityDto) => v.severity === "critical" || v.severity === "high";

export interface Attention {
  panelUpdate: string | null;
  updates: SystemPackageDto[];
  vulnerable: SystemPackageDto[];
  vulnerabilities: number;
  /** Changes when something new appears: a notice hidden for one set shows again for the next. */
  signature: string;
  total: number;
}

/** What deserves a notice: a new panel version, package updates and known vulnerabilities. */
export function useAttention(): Attention | null {
  const panel = useUpdateStatus();
  const packages = usePackagesStatus();
  if (!panel.data && !packages.data) return null;
  const list = packages.data?.packages ?? [];
  const updates = list.filter((p) => p.pending.length > 0);
  const vulnerable = list.filter((p) => p.vulnerabilities.some(noticeable));
  const vulnerabilities = vulnerable.reduce((sum, p) => sum + p.vulnerabilities.filter(noticeable).length, 0);
  const panelUpdate = panel.data?.updateAvailable ? panel.data.latest : null;
  const signature = [
    panelUpdate ?? "",
    ...updates.map((p) => `${p.id}@${p.available}`),
    ...vulnerable.flatMap((p) => p.vulnerabilities.filter(noticeable).map((v) => v.id)),
  ].sort().join(",");
  return { panelUpdate, updates, vulnerable, vulnerabilities, signature, total: (panelUpdate ? 1 : 0) + updates.length + vulnerabilities };
}

const BANNER_KEY = "eaglepanel.updates-banner-hidden";
const MODAL_KEY = "eaglepanel.updates-modal-shown";

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // Without storage the notice simply shows again.
  }
}

/** The top notice can be hidden for one set of updates and CVEs: it shows again when something new appears. */
export const bannerHiddenFor = () => read(() => localStorage, BANNER_KEY);
export const hideBannerFor = (signature: string) => write(() => localStorage, BANNER_KEY, signature);
/** The dialog shows once each time the panel is opened (per browser tab session). */
export const modalShown = () => read(() => sessionStorage, MODAL_KEY) === "1";
export const markModalShown = () => write(() => sessionStorage, MODAL_KEY, "1");
