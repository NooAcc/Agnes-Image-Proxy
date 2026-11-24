import { useEffect, useState, type FormEvent } from "react";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState, ErrorState, LoadingState } from "@/components/data-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage, fieldErrorFor } from "@/lib/errors";
import type { AccountPatch, AccountSummary } from "@/lib/schemas";
import {
  useAccounts,
  useCreateAccount,
  useDeleteAccount,
  useImportAccounts,
  useProbeAccount,
  useProbeAllAccounts,
  useResetAccount,
  useUpdateAccount,
} from "./use-accounts";

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
}

function AccountDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: AccountSummary | null;
}) {
  const create = useCreateAccount();
  const update = useUpdateAccount();
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(account?.name ?? "");
    setApiKey("");
    create.reset();
    update.reset();
    // Reset is a stable mutation method; account identity drives the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account]);

  const pending = create.isPending || update.isPending;
  const error = account ? update.error : create.error;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || pending) return;
    const close = () => onOpenChange(false);
    if (account) {
      const patch: AccountPatch = { name: name.trim() };
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      update.mutate({ id: account.id, patch }, { onSuccess: close });
      return;
    }
    create.mutate({ name: name.trim(), apiKey: apiKey.trim() }, { onSuccess: close });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account ? "编辑账号" : "新增账号"}</DialogTitle>
          <DialogDescription>密钥保存后只显示掩码，不会回显完整内容。</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <Field>
            <FieldLabel htmlFor="account-name">名称</FieldLabel>
            <Input
              id="account-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={fieldErrorFor(error, "name") ? true : undefined}
              autoComplete="off"
            />
            {fieldErrorFor(error, "name") ? <FieldError>{fieldErrorFor(error, "name")}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="account-key">密钥</FieldLabel>
            <Input
              id="account-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              aria-invalid={fieldErrorFor(error, "apiKey") ? true : undefined}
              autoComplete="new-password"
            />
            <FieldDescription>
              {account ? "留空则保持原密钥。" : "上游 API Key，必填。"}
            </FieldDescription>
            {fieldErrorFor(error, "apiKey") ? <FieldError>{fieldErrorFor(error, "apiKey")}</FieldError> : null}
          </Field>
          {error ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {errorMessage(error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending || !name.trim() || (!account && !apiKey.trim())}>
              {pending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function parseImportLines(text: string): { accounts: { name: string; apiKey: string }[]; lines: string[] } {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const accounts = lines.map((line) => {
    const comma = line.indexOf(",");
    if (comma === -1) return { name: line, apiKey: "" };
    return { name: line.slice(0, comma).trim(), apiKey: line.slice(comma + 1).trim() };
  });
  return { accounts, lines };
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const importAccounts = useImportAccounts();
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ imported: number; errors: { index: number; message: string }[] } | null>(null);

  useEffect(() => {
    if (!open) return;
    setText("");
    setResult(null);
    importAccounts.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const parsed = parseImportLines(text);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (parsed.accounts.length === 0 || importAccounts.isPending) return;
    importAccounts.mutate(parsed.accounts, {
      onSuccess: (response) => {
        setResult(response);
        if (response.errors.length === 0) {
          setText("");
          return;
        }
        // Keep only failed rows so a retry never re-submits accounted rows.
        setText(response.errors.map((issue) => parsed.lines[issue.index] ?? "").filter(Boolean).join("\n"));
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>导入账号</DialogTitle>
          <DialogDescription>
            每行一个账号，格式为“名称,密钥”。已成功的行不会在重试时再次提交；同一账号的密钥不会叠加。
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <Field>
            <FieldLabel htmlFor="import-accounts">账号列表</FieldLabel>
            <textarea
              id="import-accounts"
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={6}
              className="w-full rounded-[var(--component-radius)] border border-control bg-surface p-3 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            />
          </Field>
          {result ? (
            <div className="grid gap-1 text-sm">
              <p role="status">已导入 {result.imported} 个账号</p>
              {result.errors.length > 0 ? (
                <ul role="list" aria-label="导入错误" className="grid gap-1 text-danger">
                  {result.errors.map((issue) => (
                    <li key={issue.index}>第 {issue.index + 1} 行：{issue.message}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {importAccounts.error ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {errorMessage(importAccounts.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={importAccounts.isPending || parsed.accounts.length === 0}>
              {importAccounts.isPending ? "导入中…" : "导入账号"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AccountsPage() {
  const accounts = useAccounts();
  const update = useUpdateAccount();
  const remove = useDeleteAccount();
  const probe = useProbeAccount();
  const probeAll = useProbeAllAccounts();
  const reset = useResetAccount();
  const [dialog, setDialog] = useState<{ open: boolean; account: AccountSummary | null }>({
    open: false,
    account: null,
  });
  const [importOpen, setImportOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section aria-labelledby="accounts-heading" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="accounts-heading" className="text-base font-semibold">上游账号</h2>
          <p className="text-sm text-muted-foreground">名称用于日志展示，密钥永远不会完整返回。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setDialog({ open: true, account: null })}>新增账号</Button>
          <Button variant="outline" onClick={() => setImportOpen(true)}>导入</Button>
          <Button
            variant="outline"
            disabled={probeAll.isPending}
            onClick={() =>
              probeAll.mutate(undefined, {
                onSuccess: (items) => {
                  const failed = items.items.filter((item) => !item.ok).length;
                  setMessage(`批量测试完成：${items.items.length - failed} 个正常，${failed} 个失败。`);
                },
              })
            }
          >
            {probeAll.isPending ? "测试中…" : "批量测试"}
          </Button>
        </div>
      </div>

      {[update.error, probe.error, probeAll.error, reset.error].filter(Boolean).map((error, index) => (
        <p key={index} role="alert" className="text-sm text-danger">{errorMessage(error)}；请重试对应操作。</p>
      ))}
      {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}

      {accounts.isPending ? <LoadingState label="正在加载账号" /> : null}
      {accounts.error ? (
        <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : null}
      {accounts.data && accounts.data.length === 0 ? (
        <EmptyState title="还没有上游账号" description="新增或导入账号后即可开始生成图片。" />
      ) : null}
      {accounts.data && accounts.data.length > 0 ? (
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">名称</TableHead>
              <TableHead scope="col">密钥</TableHead>
              <TableHead scope="col">状态</TableHead>
              <TableHead scope="col">失败次数</TableHead>
              <TableHead scope="col">最近使用</TableHead>
              <TableHead scope="col" className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.data.map((account) => (
              <TableRow key={account.id}>
                <TableCell className="font-medium">{account.name}</TableCell>
                <TableCell><code className="text-xs">{account.apiKeyMasked}</code></TableCell>
                <TableCell>
                  <StatusBadge status={account.status} />
                  {account.cooldownUntil ? (
                    <span className="ml-2 text-xs text-muted-foreground">至 {formatTime(account.cooldownUntil)}</span>
                  ) : null}
                </TableCell>
                <TableCell>{account.failCount}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatTime(account.lastUsedAt)}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button variant="ghost" aria-label={`编辑 ${account.name}`} onClick={() => setDialog({ open: true, account })}>
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`${account.enabled ? "停用" : "启用"} ${account.name}`}
                      disabled={update.isPending}
                      onClick={() => update.mutate({ id: account.id, patch: { enabled: !account.enabled } })}
                    >
                      {account.enabled ? "停用" : "启用"}
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`测试 ${account.name}`}
                      disabled={probe.isPending}
                      onClick={() =>
                        probe.mutate(account.id, {
                          onSuccess: (result) =>
                            setMessage(`测试 ${account.name}：${result.ok ? "正常" : "失败"}（${result.status}）`),
                        })
                      }
                    >
                      测试
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`重置 ${account.name}`}
                      disabled={reset.isPending}
                      onClick={() => reset.mutate(account.id)}
                    >
                      重置
                    </Button>
                    <ConfirmAction
                      trigger={
                        <Button variant="ghost" aria-label={`删除 ${account.name}`} className="text-danger">
                          删除
                        </Button>
                      }
                      title={`删除账号 ${account.name}？`}
                      description="删除后无法恢复；历史日志与图库会保留账号名称快照。"
                      confirmLabel="删除"
                      onConfirm={() => remove.mutateAsync(account.id)}
                      pending={remove.isPending}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      <AccountDialog
        open={dialog.open}
        account={dialog.account}
        onOpenChange={(open) => setDialog({ open, account: open ? dialog.account : null })}
      />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </section>
  );
}
