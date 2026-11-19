import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import type { AccountDto, JobDto, MeDto } from "@eaglepanel/shared";
import {
  ActivityIcon,
  EllipsisVerticalIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  LogOutIcon,
  PackageIcon,
  ServerIcon,
  Settings2Icon,
  UserCircleIcon,
  UsersIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSelect } from "@/components/language-select";
import { Wordmark } from "@/components/logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { api } from "@/lib/api";
import { useSystemInfo } from "@/lib/system-info";
import { useAttention } from "@/lib/system-packages";

function useIsActive() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (to: string) => (to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The server this panel manages, in place of a workspace selector. */
function ServerCard() {
  const { t } = useTranslation();
  const info = useSystemInfo();
  return (
    <div className="mx-3 mb-6 flex items-center gap-2.5 rounded-ep border border-white/10 p-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-ep-chip bg-primary/30 text-lilac">
        <ServerIcon className="size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground">{info.data?.hostname ?? t("Server")}</p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-foreground/45">
          <span className={`size-1.5 shrink-0 rounded-full ${info.isError ? "bg-destructive" : info.data ? "bg-success" : "bg-foreground/30"}`} aria-hidden="true" />
          {info.isError ? t("Agent not responding") : info.data ? (info.data.osName ?? `${info.data.platform} ${info.data.release}`) : t("Connecting…")}
        </p>
      </div>
    </div>
  );
}

function NavUser() {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const queryClient = useQueryClient();
  const me = queryClient.getQueryData<MeDto>(["me"]);
  const initials = (me?.username ?? "").slice(0, 2).toUpperCase();

  const logout = useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSuccess: () => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "me" });
      return queryClient.resetQueries({ queryKey: ["me"] });
    },
  });

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="px-1! hover:bg-white/5! aria-expanded:bg-white/5" />}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/30 text-xs text-lilac">{initials}</span>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate text-sidebar-foreground/85">{me?.username}</span>
              <span className="truncate text-xs text-sidebar-foreground/45">{t("Administrator")}</span>
            </div>
            <EllipsisVerticalIcon className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/25 text-xs text-lilac">{initials}</span>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{me?.username}</span>
                    <span className="truncate text-xs text-muted-foreground">{t("Administrator")}</span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link to="/settings" />}>
                <UserCircleIcon />
                {t("Settings")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={logout.isPending} onClick={() => logout.mutate()}>
              <LogOutIcon />
              {t("Sign out")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation();
  const isActive = useIsActive();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<AccountDto[]>("/accounts") });
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => api.get<JobDto[]>("/jobs") });
  const running = jobs.data?.filter((job) => job.status === "running" || job.status === "pending").length ?? 0;
  const attention = useAttention();

  const nav = [
    { to: "/", title: "Overview", icon: LayoutDashboardIcon, badge: null },
    { to: "/accounts", title: "Accounts", icon: UsersIcon, badge: accounts.data ? pad(accounts.data.length) : null },
    { to: "/jobs", title: "Jobs", icon: ListChecksIcon, badge: running > 0 ? String(running) : null },
    { to: "/activity", title: "Activity", icon: ActivityIcon, badge: null },
    { to: "/updates", title: "Updates", icon: PackageIcon, badge: attention?.total ? String(attention.total) : null },
  ] as const;

  return (
    <Sidebar collapsible="offcanvas" className="border-r border-white/10" {...props}>
      <SidebarHeader className="gap-0 p-0">
        <Link to="/" className="flex h-20 items-center px-5 text-sidebar-foreground" aria-label="EaglePanel">
          <Wordmark className="h-6 w-auto" />
        </Link>
        <ServerCard />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-3 py-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {nav.map(({ to, title, icon: Icon, badge }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton className="rounded-ep! h-auto! gap-2.5! px-3! py-2.5! text-sm text-sidebar-foreground/55 hover:bg-white/5! hover:text-sidebar-foreground! data-active:bg-sidebar-primary! data-active:font-normal! data-active:text-sidebar-primary-foreground!" tooltip={t(title)} isActive={isActive(to)} render={<Link to={to} />}>
                    <Icon />
                    <span>{t(title)}</span>
                    {badge && <span className="ml-auto font-mono text-xs text-sidebar-foreground/35 group-data-active/menu-button:text-sidebar-primary-foreground/60">{badge}</span>}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="mt-auto px-3">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              <SidebarMenuItem>
                <SidebarMenuButton className="rounded-ep! h-auto! gap-2.5! px-3! py-2.5! text-sm text-sidebar-foreground/55 hover:bg-white/5! hover:text-sidebar-foreground! data-active:bg-sidebar-primary! data-active:font-normal! data-active:text-sidebar-primary-foreground!" isActive={isActive("/settings")} render={<Link to="/settings" />}>
                  <Settings2Icon />
                  <span>{t("Settings")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem className="px-2 pt-1">
                <LanguageSelect className="w-full" />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-3 pt-0 pb-4">
        <div className="border-t border-white/10 pt-3">
        <NavUser />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
