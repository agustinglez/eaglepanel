import "./index.css";
import "@/lib/i18n";

import { QueryCache, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { MeDto } from "@eaglepanel/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api";
import { LoginPage } from "@/routes/login";
import { router } from "@/router";

const queryClient: QueryClient = new QueryClient({
  // When the session expires, every query gets a 401: the session is checked again and the sign-in page appears.
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (error instanceof ApiError && error.status === 401 && query.queryKey[0] !== "me") {
        void queryClient.resetQueries({ queryKey: ["me"] });
      }
    },
  }),
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

function App() {
  const { t } = useTranslation();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<MeDto>("/auth/me") });

  if (me.isPending) {
    return <div className="grid min-h-svh place-items-center text-sm text-muted-foreground">{t("Connecting…")}</div>;
  }
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <LoginPage />;
  }
  if (me.isError) {
    return (
      <div className="grid min-h-svh place-items-center p-6 text-center text-sm text-destructive">
        {t("Could not connect to the API: {{message}}", { message: me.error.message })}
      </div>
    );
  }
  return <RouterProvider router={router} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <App />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
