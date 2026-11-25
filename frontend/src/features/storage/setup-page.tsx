import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorMessage, fieldErrorFor } from "@/lib/errors";
import type { StorageInit } from "@/lib/schemas";
import { UploadRules } from "./upload-rules";
import { useInitializeStorage } from "./use-storage";

type Mode = "local" | "imgbed" | null;

export function SetupPage() {
  const navigate = useNavigate();
  const initialize = useInitializeStorage();
  const [mode, setMode] = useState<Mode>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");

  const baseError = fieldErrorFor(initialize.error, "imgbedBaseUrl");
  const tokenError = fieldErrorFor(initialize.error, "imgbedToken");
  const invalid =
    mode === null || (mode === "imgbed" && (baseUrl.trim() === "" || token.trim() === ""));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid || initialize.isPending || mode === null) return;
    const input: StorageInit =
      mode === "local"
        ? { mode: "local" }
        : { mode: "imgbed", imgbedBaseUrl: baseUrl.trim(), imgbedToken: token.trim() };
    initialize.mutate(input, {
      onSuccess: () => {
        setToken("");
        setBaseUrl("");
        navigate("/overview", { replace: true });
      },
      // A conflict leaves the form mounted; the status refetch redirects once
      // the storage guard observes the fixed configuration.
    });
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-4">
      <section
        aria-labelledby="setup-heading"
        className="w-full max-w-xl rounded-[var(--component-radius)] border border-border bg-surface p-6 shadow-sm"
      >
        <h1 id="setup-heading" className="text-lg font-semibold">初始化 Agnes Image Proxy</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          选择原图存储方式，完成后不可切换。生成图片前必须完成此步骤。
        </p>
        <form className="mt-5 grid gap-5" onSubmit={submit} noValidate>
          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium text-foreground">原图存储方式</legend>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--component-radius)] border border-border px-3">
              <input
                type="radio"
                name="storage-mode"
                value="local"
                checked={mode === "local"}
                onChange={() => setMode("local")}
                className="h-5 w-5"
              />
              <span className="text-sm">本地存储</span>
            </label>
            <p className="pl-8 text-sm text-muted-foreground">
              原图保存在 DATA_DIR/images，需要为容器挂载持久化卷。
            </p>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--component-radius)] border border-border px-3">
              <input
                type="radio"
                name="storage-mode"
                value="imgbed"
                checked={mode === "imgbed"}
                onChange={() => setMode("imgbed")}
                className="h-5 w-5"
              />
              <span className="text-sm">图床存储</span>
            </label>
            <p className="pl-8 text-sm text-muted-foreground">
              原图上传到 CloudFlare ImgBed；本程序仍只返回自己的签名链接。
            </p>
          </fieldset>

          {mode === "imgbed" ? (
            <div className="grid gap-4 rounded-[var(--component-radius)] border border-border p-3">
              <Field>
                <FieldLabel htmlFor="setup-base-url">图床站点地址</FieldLabel>
                <Input
                  id="setup-base-url"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://img.example.com"
                  aria-invalid={baseError ? true : undefined}
                  aria-describedby={baseError ? "setup-base-url-error" : "setup-base-url-help"}
                />
                <FieldDescription id="setup-base-url-help">
                  填写站点根地址（HTTPS origin），不要填文档地址或 /upload。
                </FieldDescription>
                {baseError ? <FieldError id="setup-base-url-error">{baseError}</FieldError> : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="setup-token">API Token</FieldLabel>
                <Input
                  id="setup-token"
                  type="password"
                  autoComplete="new-password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  aria-invalid={tokenError ? true : undefined}
                  aria-describedby={tokenError ? "setup-token-error" : "setup-token-help"}
                />
                <FieldDescription id="setup-token-help">
                  Token 需要 upload 与 delete 权限，不需要 list 或 manage。
                </FieldDescription>
                {tokenError ? <FieldError id="setup-token-error">{tokenError}</FieldError> : null}
              </Field>
              <UploadRules />
            </div>
          ) : null}

          <div className="grid gap-1 rounded-[var(--component-radius)] border border-danger/40 p-3 text-sm text-muted-foreground">
            <p>选定后无法切换存储方式；如需更改只能重建数据库并重新初始化。</p>
            <p>更换图床地址时，旧站点的文件不会迁移，也不会保留旧地址。</p>
          </div>

          {initialize.error ? (
            <p role="alert" className="text-sm font-medium text-danger">{errorMessage(initialize.error)}</p>
          ) : null}

          <Button type="submit" disabled={invalid || initialize.isPending}>
            {initialize.isPending ? "初始化中…" : "完成初始化"}
          </Button>
        </form>
      </section>
    </main>
  );
}
