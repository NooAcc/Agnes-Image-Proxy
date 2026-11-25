import { useEffect, useState, type FormEvent } from "react";
import { ErrorState, LoadingState } from "@/components/data-state";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorMessage, fieldErrorFor } from "@/lib/errors";
import type { StorageUpdate } from "@/lib/schemas";
import { UploadRules } from "./upload-rules";
import { useStorage, useUpdateImgbedStorage } from "./use-storage";

export function StorageSettings() {
  const storage = useStorage();
  if (storage.isPending) return <LoadingState label="正在加载原图存储设置" />;
  if (storage.error) {
    return <ErrorState error={storage.error} onRetry={() => void storage.refetch()} />;
  }
  if (!storage.data?.initialized) return null;
  if (storage.data.mode === "local") {
    return (
      <div className="grid max-w-3xl gap-2 rounded-[var(--component-radius)] border border-border p-4">
        <p className="text-sm font-medium">本地存储</p>
        <p className="text-sm text-muted-foreground">
          原图保存在 DATA_DIR/images；缩略图同样位于该目录，请确保持久化卷已挂载。
        </p>
        <p className="text-sm text-muted-foreground">存储方式已固定，不能在本页面切换。</p>
      </div>
    );
  }
  return (
    <ImgbedSettings
      baseUrl={storage.data.imgbedBaseUrl}
      hasToken={storage.data.hasImgbedToken}
    />
  );
}

function ImgbedSettings({ baseUrl: initialBaseUrl, hasToken }: { baseUrl: string; hasToken: boolean }) {
  const update = useUpdateImgbedStorage();
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setBaseUrl(initialBaseUrl);
  }, [initialBaseUrl]);

  const baseError = fieldErrorFor(update.error, "imgbedBaseUrl");
  const tokenError = fieldErrorFor(update.error, "imgbedToken");
  const invalid = baseUrl.trim() === "";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid || update.isPending) return;
    setSaved(false);
    const input: StorageUpdate = {
      imgbedBaseUrl: baseUrl.trim(),
      // An empty field retains the stored token; a value replaces it. The token
      // is never cleared by this form.
      ...(token.trim() === "" ? {} : { imgbedToken: token.trim() }),
    };
    update.mutate(input, {
      onSuccess: () => {
        setToken("");
        setSaved(true);
      },
    });
  }

  return (
    <form className="grid max-w-3xl gap-4" onSubmit={submit} noValidate>
      <div className="grid gap-1 rounded-[var(--component-radius)] border border-border p-4">
        <p className="text-sm font-medium">图床存储</p>
        <p className="text-sm text-muted-foreground">当前方式固定为图床存储，不能切换为本地存储。</p>
        <p className="text-sm text-muted-foreground">
          {hasToken ? "Token 已配置。" : "Token 尚未配置。"}已保存的 Token 不会显示，也不会写入浏览器存储。
        </p>
      </div>

      <Field>
        <FieldLabel htmlFor="storage-base-url">图床站点地址</FieldLabel>
        <Input
          id="storage-base-url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          aria-invalid={baseError ? true : undefined}
          aria-describedby={baseError ? "storage-base-url-error" : undefined}
        />
        <FieldDescription>
          必须是 HTTPS 站点根地址。更换地址前，请确认新站点已有同一套文件（相同路径），程序不会迁移图片。
        </FieldDescription>
        {baseError ? <FieldError id="storage-base-url-error">{baseError}</FieldError> : null}
      </Field>

      <Field>
        <FieldLabel htmlFor="storage-token">更新 API Token</FieldLabel>
        <Input
          id="storage-token"
          type="password"
          autoComplete="new-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="留空保留现有 Token"
          aria-invalid={tokenError ? true : undefined}
          aria-describedby={tokenError ? "storage-token-error" : "storage-token-help"}
        />
        <FieldDescription id="storage-token-help">
          留空表示保留现有 Token；填写新值表示替换。本页面不支持清除 Token。
        </FieldDescription>
        {tokenError ? <FieldError id="storage-token-error">{tokenError}</FieldError> : null}
      </Field>

      <UploadRules />

      {update.error ? (
        <p role="alert" className="text-sm font-medium text-danger">{errorMessage(update.error)}</p>
      ) : null}
      {saved ? <p role="status" className="text-sm text-success">原图存储设置已保存。</p> : null}

      <Button type="submit" disabled={invalid || update.isPending}>
        {update.isPending ? "保存中…" : "保存原图存储"}
      </Button>
    </form>
  );
}
