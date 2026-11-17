import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MeDto } from "@eaglepanel/shared";
import { useState, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSelect } from "@/components/language-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Wordmark } from "@/components/logo";
import { api } from "@/lib/api";

type LoginResponse = MeDto | { totpRequired: true };

export function LoginPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);

  const login = useMutation({
    mutationFn: () =>
      api.post<LoginResponse>("/auth/login", {
        username,
        password,
        ...(needsTotp ? { totp } : {}),
      }),
    onSuccess: (data) => {
      if ("totpRequired" in data) {
        setNeedsTotp(true);
        return;
      }
      queryClient.setQueryData(["me"], data);
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: () => setTotp(""),
  });

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    login.mutate();
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Wordmark className="h-8 w-auto self-center text-foreground" />
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">{needsTotp ? t("Two-factor authentication") : t("Sign in")}</CardTitle>
            <CardDescription>
              {needsTotp ? t("Enter the code from your authenticator app") : t("Enter your credentials to manage the server")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-4">
              {needsTotp ? (
                <div className="grid gap-2">
                  <Label htmlFor="totp">{t("Code")}</Label>
                  <Input
                    id="totp"
                    value={totp}
                    onChange={(event) => setTotp(event.target.value.replace(/\D/g, ""))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    autoFocus
                    required
                  />
                </div>
              ) : (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="username">{t("Username")}</Label>
                    <Input id="username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="password">{t("Password")}</Label>
                    <Input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
                  </div>
                </>
              )}
              {login.isError && (
                <Alert variant="destructive">
                  <AlertDescription>{login.error.message}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={login.isPending}>
                {login.isPending ? t("Verifying…") : needsTotp ? t("Verify") : t("Sign in")}
              </Button>
            </form>
          </CardContent>
        </Card>
        <LanguageSelect className="self-center" />
      </div>
    </div>
  );
}
