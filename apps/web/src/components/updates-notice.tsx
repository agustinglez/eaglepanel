import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ShieldAlertIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { bannerHiddenFor, hideBannerFor, markModalShown, modalShown, useAttention, type Attention } from "@/lib/system-packages";

function useSummary(attention: Attention | null): string[] {
  const { t } = useTranslation();
  if (!attention) return [];
  const lines: string[] = [];
  if (attention.panelUpdate) lines.push(t("EaglePanel {{version}} is available", { version: attention.panelUpdate }));
  if (attention.updates.length) {
    lines.push(t("Updates for {{names}}", { names: attention.updates.map((p) => p.name).join(", ") }));
  }
  if (attention.vulnerabilities) {
    lines.push(
      t("{{count}} known vulnerabilities in {{names}}", {
        count: attention.vulnerabilities,
        names: attention.vulnerable.map((p) => p.name).join(", "),
      }),
    );
  }
  return lines;
}

/** Top of every page while there are updates or CVEs. Hidden for one set: it shows again when something new appears. */
export function UpdatesBanner() {
  const { t } = useTranslation();
  const attention = useAttention();
  const summary = useSummary(attention);
  const onUpdates = useRouterState({ select: (state) => state.location.pathname === "/updates" });
  const [hidden, setHidden] = useState(() => bannerHiddenFor());
  if (!attention || attention.total === 0 || onUpdates || hidden === attention.signature) return null;
  const critical = attention.vulnerable.some((p) => p.vulnerabilities.some((v) => v.severity === "critical" || v.severity === "high"));

  return (
    <div className="px-4 pt-4 sm:px-6 lg:px-7">
      <Alert variant={critical ? "destructive" : "default"} className="pr-24">
        <ShieldAlertIcon />
        <AlertTitle>{t("Updates and vulnerabilities")}</AlertTitle>
        <AlertDescription>{summary.join(" · ")}</AlertDescription>
        <AlertAction className="flex items-center gap-1">
          <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/updates" />}>
            {t("Review")}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("Hide until something new appears")}
            onClick={() => {
              hideBannerFor(attention.signature);
              setHidden(attention.signature);
            }}
          >
            <XIcon />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}

/** Once each time the panel is opened, if there is something to update or a known vulnerability. */
export function UpdatesDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const attention = useAttention();
  const summary = useSummary(attention);
  const [open, setOpen] = useState(false);
  const pending = attention !== null && attention.total > 0;

  useEffect(() => {
    if (pending && !modalShown()) {
      markModalShown();
      setOpen(true);
    }
  }, [pending]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Updates and vulnerabilities")}</DialogTitle>
          <DialogDescription>{t("The server has pending updates or known vulnerabilities.")}</DialogDescription>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("Later")}
          </Button>
          <Button
            onClick={() => {
              setOpen(false);
              void navigate({ to: "/updates" });
            }}
          >
            {t("Review")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
