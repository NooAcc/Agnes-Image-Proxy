import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/errors";
import { useLogin, useSession } from "./use-session";

interface LocationState {
  from?: { pathname?: string };
}

export function LoginPage() {
  const session = useSession();
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const [apiKey, setApiKey] = useState("");
  const state = location.state as LocationState | null;
  const destination = state?.from?.pathname ?? "/overview";

  if (session.data?.authenticated) {
    return <Navigate to={destination} replace />;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!apiKey.trim() || login.isPending) {
      return;
    }
    login.mutate(apiKey.trim(), {
      onSuccess: () => navigate(destination, { replace: true }),
    });
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-4">
      <section aria-labelledby="login-heading" className="w-full max-w-sm rounded-[var(--component-radius)] border border-border bg-surface p-6 shadow-sm">
        <h1 id="login-heading" className="text-lg font-semibold">登录</h1>
        <p className="mt-1 text-sm text-muted-foreground">使用管理密钥进入 Agnes 控制台。</p>
        <form className="mt-4 grid gap-4" onSubmit={submit} noValidate>
          <Field>
            <FieldLabel htmlFor="api-key">管理密钥</FieldLabel>
            <Input
              id="api-key"
              type="password"
              autoComplete="current-password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              aria-invalid={login.isError ? true : undefined}
            />
            <FieldDescription>密钥只用于本次登录，不会保存在浏览器中。</FieldDescription>
            {login.isError ? <FieldError>{errorMessage(login.error)}</FieldError> : null}
          </Field>
          <Button type="submit" disabled={login.isPending || apiKey.trim() === ""}>
            {login.isPending ? "登录中…" : "登录"}
          </Button>
        </form>
      </section>
    </main>
  );
}
