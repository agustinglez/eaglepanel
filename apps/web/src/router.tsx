import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { AccountDetailPage } from "@/routes/account-detail";
import { DomainDetailPage } from "@/routes/account-domains";
import { AccountsPage } from "@/routes/accounts";
import { ActivityPage } from "@/routes/activity";
import { DashboardPage } from "@/routes/dashboard";
import { DatabaseExplorerPage, validateExplorerSearch } from "@/routes/database-explorer";
import { JobsPage } from "@/routes/jobs";
import { NewAccountPage } from "@/routes/new-account";
import { SettingsPage } from "@/routes/settings";
import { UpdatesPage } from "@/routes/updates";
import { validateVhostSearch, VhostDetailPage } from "@/routes/vhost-detail";

const rootRoute = createRootRoute({ component: AppShell });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/accounts", component: AccountsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/accounts/new", component: NewAccountPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/accounts/$username", component: AccountDetailPage }),
  // Each account tab has its own URL: reloading or following a link returns to the same tab.
  createRoute({ getParentRoute: () => rootRoute, path: "/accounts/$username/$tab", component: AccountDetailPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/accounts/$username/domains/$zone", component: DomainDetailPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/accounts/$username/environments/$slug", component: VhostDetailPage, validateSearch: validateVhostSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: "/accounts/$username/databases/$database", component: DatabaseExplorerPage, validateSearch: validateExplorerSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: "/jobs", component: JobsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/activity", component: ActivityPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/updates", component: UpdatesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
