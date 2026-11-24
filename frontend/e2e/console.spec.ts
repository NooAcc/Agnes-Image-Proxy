import { expect, test } from "@playwright/test";
import { gotoPage, login, mainNav } from "./helpers";

test.describe.configure({ mode: "serial" });

test("登录后浏览五个页面，深链接刷新仍保持会话", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);

  const pages = [
    { label: "图库", path: "/gallery", heading: "图库" },
    { label: "账号", path: "/accounts", heading: "上游账号" },
    { label: "日志", path: "/logs", heading: "请求日志" },
    { label: "设置", path: "/settings", heading: "服务设置" },
    { label: "总览", path: "/overview", heading: "总览" },
  ];
  for (const entry of pages) {
    await gotoPage(page, entry.label, entry.path, entry.heading);
  }

  for (const entry of pages) {
    await page.goto(`/admin${entry.path}`);
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: entry.heading })).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: entry.label })).toBeVisible();
  }
});

test("设置表单校验、保存与恢复", async ({ page }) => {
  await login(page);
  await gotoPage(page, "设置", "/settings", "服务设置");

  const refresh = page.getByLabel("自动刷新间隔（毫秒）");
  await refresh.fill("6000");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存。")).toBeVisible();

  await refresh.fill("5000");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存。")).toBeVisible();

  const timeout = page.getByLabel("请求超时（毫秒）");
  await timeout.fill("1000");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();

  await timeout.fill("300000");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("账号新增、探测、启停、导入、取消删除与确认删除", async ({ page }) => {
  await login(page);
  await gotoPage(page, "账号", "/accounts", "上游账号");

  await page.getByRole("button", { name: "新增账号" }).click();
  await page.getByLabel("名称").fill("e2e-account");
  await page.getByLabel("密钥").fill("e2e-secret");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("cell", { name: "e2e-account", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "测试 e2e-account" }).click();
  await expect(page.getByRole("status")).toContainText("测试 e2e-account：正常");

  await page.getByRole("button", { name: "停用 e2e-account" }).click();
  await expect(page.getByRole("button", { name: "启用 e2e-account" })).toBeVisible();
  await page.getByRole("button", { name: "启用 e2e-account" }).click();
  await expect(page.getByRole("button", { name: "停用 e2e-account" })).toBeVisible();

  await page.getByRole("button", { name: "导入" }).click();
  await page.getByLabel("账号列表").fill("e2e-import,e2e-import-key");
  await page.getByRole("button", { name: "导入账号" }).click();
  await expect(page.getByRole("status")).toContainText("已导入 1 个账号");
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("cell", { name: "e2e-import", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "删除 e2e-account" }).click();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("cell", { name: "e2e-account", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "删除 e2e-account" }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("cell", { name: "e2e-account", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "删除 e2e-import" }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("cell", { name: "e2e-import", exact: true })).toHaveCount(0);
});

test("日志分类由 URL 驱动，详情可打开，清空可取消", async ({ page }) => {
  await login(page);
  await gotoPage(page, "日志", "/logs", "请求日志");

  const tabs = page.getByRole("tablist", { name: "日志分类" });
  await tabs.getByRole("tab", { name: "富化" }).click();
  await expect(page).toHaveURL(/category=enrich/);
  await expect(page.getByText("preview-enrich-failure")).toBeVisible();

  await page.getByRole("button", { name: "查看 preview-enrich-failure" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("preview-enrich-failure");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "清空日志" }).click();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByText("preview-enrich-failure")).toBeVisible();
});
