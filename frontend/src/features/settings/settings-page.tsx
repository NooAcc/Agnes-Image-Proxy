import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ConfirmAction } from "@/components/confirm-action";
import { ErrorState, LoadingState } from "@/components/data-state";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorMessage, fieldErrorFor, fieldErrors } from "@/lib/errors";
import type { Settings } from "@/lib/schemas";
import { useRevokeSessions } from "@/features/auth/use-session";
import { useSettings, useUpdateSettings } from "./use-settings";

const FIELD_LABELS: Record<string, string> = {
  agnesBaseUrl: "Agnes 基础地址",
  defaultSize: "默认尺寸",
  imageParamMode: "图片参数位置",
  probeModel: "探测模型",
  probeConcurrency: "探测并发",
  requestTimeoutMs: "请求超时",
  autoRefreshIntervalMs: "自动刷新间隔",
  maxAttempts: "最大尝试次数",
  imageServiceBaseUrl: "图片服务地址",
  thumbnailWidth: "缩略图宽度",
  thumbnailQuality: "缩略图质量",
  enrichTimeoutMs: "富化超时",
};

type NumberKey =
  | "probeConcurrency"
  | "requestTimeoutMs"
  | "autoRefreshIntervalMs"
  | "maxAttempts"
  | "thumbnailWidth"
  | "thumbnailQuality"
  | "enrichTimeoutMs";

function ErrorSummary({ error }: { error: unknown }) {
  const issues = fieldErrors(error);
  if (issues.length === 0) return null;
  return (
    <div className="grid gap-1 rounded-[var(--component-radius)] border border-danger/40 p-3">
      <p role="alert" aria-label="表单错误" className="text-sm font-medium text-danger">
        {errorMessage(error)}
      </p>
      <ul aria-label="表单错误" className="grid gap-1 text-sm">
        {issues.map((issue, index) => (
          <li key={`${issue.field ?? "general"}-${index}`}>
            {issue.field ? (
              <a
                href={`#settings-${issue.field}`}
                className="underline underline-offset-4"
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById(`settings-${issue.field}`)?.focus();
                }}
              >
                {FIELD_LABELS[issue.field] ?? issue.field}
              </a>
            ) : (
              "请求"
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SettingsForm({ initial }: { initial: Settings }) {
  const [draft, setDraft] = useState<Settings>(initial);
  const [saved, setSaved] = useState(false);
  const update = useUpdateSettings();
  const revoke = useRevokeSessions();
  const navigate = useNavigate();

  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const issue = (field: string) => fieldErrorFor(update.error, field);
  const control = (field: string) => ({
    id: `settings-${field}`,
    "aria-invalid": issue(field) ? true : undefined,
    "aria-describedby": issue(field) ? `settings-${field}-error` : undefined,
  });
  const errorFor = (field: string) =>
    issue(field) ? <FieldError id={`settings-${field}-error`}>{issue(field)}</FieldError> : null;
  const setNumber = (key: NumberKey, raw: string) =>
    setDraft((current) => ({ ...current, [key]: Number(raw) }));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (update.isPending) return;
    setSaved(false);
    update.mutate(draft, { onSuccess: () => setSaved(true) });
  }

  return (
    <form className="grid max-w-3xl gap-6" onSubmit={submit} noValidate>
      <fieldset className="grid gap-4">
        <legend className="text-base font-semibold">上游</legend>
        <Field>
          <FieldLabel htmlFor="settings-agnesBaseUrl">Agnes 基础地址</FieldLabel>
          <Input
            {...control("agnesBaseUrl")}
            value={draft.agnesBaseUrl}
            onChange={(event) => setDraft({ ...draft, agnesBaseUrl: event.target.value })}
          />
          <FieldDescription>例如 https://apihub.agnes-ai.com/v1；仅本地回环允许 http。</FieldDescription>
          {errorFor("agnesBaseUrl")}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="settings-maxAttempts">最大尝试次数</FieldLabel>
            <Input
              {...control("maxAttempts")}
              type="number"
              min={1}
              max={10}
              value={draft.maxAttempts}
              onChange={(event) => setNumber("maxAttempts", event.target.value)}
            />
            {errorFor("maxAttempts")}
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-requestTimeoutMs">请求超时（毫秒）</FieldLabel>
            <Input
              {...control("requestTimeoutMs")}
              type="number"
              min={60_000}
              max={360_000}
              value={draft.requestTimeoutMs}
              onChange={(event) => setNumber("requestTimeoutMs", event.target.value)}
            />
            {errorFor("requestTimeoutMs")}
          </Field>
        </div>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="text-base font-semibold">尺寸与输出</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="settings-defaultSize">默认尺寸</FieldLabel>
            <select
              {...control("defaultSize")}
              value={draft.defaultSize}
              onChange={(event) => setDraft({ ...draft, defaultSize: event.target.value as Settings["defaultSize"] })}
              className="h-11 rounded-[var(--component-radius)] border border-control bg-surface px-2 text-sm text-foreground"
            >
              {(["1K", "2K", "3K", "4K"] as const).map((tier) => (
                <option key={tier} value={tier}>{tier}</option>
              ))}
            </select>
            {errorFor("defaultSize")}
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-imageParamMode">图片参数位置</FieldLabel>
            <select
              {...control("imageParamMode")}
              value={draft.imageParamMode}
              onChange={(event) =>
                setDraft({ ...draft, imageParamMode: event.target.value as Settings["imageParamMode"] })
              }
              className="h-11 rounded-[var(--component-radius)] border border-control bg-surface px-2 text-sm text-foreground"
            >
              <option value="nested">嵌套（image_url）</option>
              <option value="top_level">顶层（image）</option>
            </select>
            {errorFor("imageParamMode")}
          </Field>
        </div>
        <Field>
          <FieldDescription>
            默认返回图片 URL；客户端可用 response_format=b64_json 或 return_base64=true 显式请求 base64，此项不可在控制台切换。
          </FieldDescription>
        </Field>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="text-base font-semibold">图片服务（可选）</legend>
        <Field>
          <FieldLabel htmlFor="settings-imageServiceBaseUrl">图片服务地址</FieldLabel>
          <Input
            {...control("imageServiceBaseUrl")}
            value={draft.imageServiceBaseUrl}
            onChange={(event) => setDraft({ ...draft, imageServiceBaseUrl: event.target.value })}
            placeholder="https://edge.example"
          />
          <FieldDescription>留空即关闭尺寸测量、缩略图与 NSFW 富化。</FieldDescription>
          {errorFor("imageServiceBaseUrl")}
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="settings-thumbnailWidth">缩略图宽度</FieldLabel>
            <Input
              {...control("thumbnailWidth")}
              type="number"
              min={128}
              max={2_048}
              value={draft.thumbnailWidth}
              onChange={(event) => setNumber("thumbnailWidth", event.target.value)}
            />
            {errorFor("thumbnailWidth")}
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-thumbnailQuality">缩略图质量</FieldLabel>
            <Input
              {...control("thumbnailQuality")}
              type="number"
              min={40}
              max={100}
              value={draft.thumbnailQuality}
              onChange={(event) => setNumber("thumbnailQuality", event.target.value)}
            />
            {errorFor("thumbnailQuality")}
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-enrichTimeoutMs">富化超时（毫秒）</FieldLabel>
            <Input
              {...control("enrichTimeoutMs")}
              type="number"
              min={5_000}
              max={60_000}
              value={draft.enrichTimeoutMs}
              onChange={(event) => setNumber("enrichTimeoutMs", event.target.value)}
            />
            {errorFor("enrichTimeoutMs")}
          </Field>
        </div>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="text-base font-semibold">探测与刷新</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="settings-probeModel">探测模型</FieldLabel>
            <Input
              {...control("probeModel")}
              value={draft.probeModel}
              onChange={(event) => setDraft({ ...draft, probeModel: event.target.value })}
            />
            {errorFor("probeModel")}
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-probeConcurrency">探测并发</FieldLabel>
            <Input
              {...control("probeConcurrency")}
              type="number"
              min={1}
              max={10}
              value={draft.probeConcurrency}
              onChange={(event) => setNumber("probeConcurrency", event.target.value)}
            />
            {errorFor("probeConcurrency")}
          </Field>
          <Field>
            <FieldLabel htmlFor="settings-autoRefreshIntervalMs">自动刷新间隔（毫秒）</FieldLabel>
            <Input
              {...control("autoRefreshIntervalMs")}
              type="number"
              min={2_000}
              max={60_000}
              value={draft.autoRefreshIntervalMs}
              onChange={(event) => setNumber("autoRefreshIntervalMs", event.target.value)}
            />
            {errorFor("autoRefreshIntervalMs")}
          </Field>
        </div>
      </fieldset>

      <ErrorSummary error={update.error} />
      {saved ? <p role="status" className="text-sm text-success">设置已保存。</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? "保存中…" : "保存设置"}
        </Button>
      </div>

      <fieldset className="grid gap-3 rounded-[var(--component-radius)] border border-border p-4">
        <legend className="px-1 text-base font-semibold">会话</legend>
        <p className="text-sm text-muted-foreground">撤销后所有设备都需要使用管理密钥重新登录。</p>
        <ConfirmAction
          trigger={<Button variant="destructive" className="w-fit">撤销全部会话</Button>}
          title="撤销全部会话？"
          description="当前浏览器也会退出登录，需要重新输入管理密钥。"
          confirmLabel="撤销"
          pending={revoke.isPending}
          onConfirm={() =>
            revoke.mutate(undefined, {
              onSuccess: () => navigate("/login", { replace: true }),
            })
          }
        />
      </fieldset>
    </form>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  if (settings.isPending) return <LoadingState label="正在加载设置" />;
  if (settings.error) {
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  }
  if (!settings.data) return null;
  return (
    <section aria-labelledby="settings-heading" className="grid gap-4">
      <h2 id="settings-heading" className="text-base font-semibold">服务设置</h2>
      <SettingsForm initial={settings.data} />
    </section>
  );
}
