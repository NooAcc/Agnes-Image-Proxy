import { expect, test } from "@playwright/test";
import { gotoSection, login, mainNav, SECTIONS, section } from "./helpers";

test.describe.configure({ mode: "serial" });

test("登录后浏览全部板块，直接路径与 hash 刷新都保持同一板块", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);

  for (const entry of SECTIONS) {
    await gotoSection(page, entry.id);
    await expect(page.getByRole("heading", { level: 2, name: entry.heading })).toBeVisible();
    await expect(mainNav(page).locator(`[data-nav="${entry.id}"]`)).toHaveClass(/is-active/);
  }

  for (const entry of SECTIONS) {
    await page.goto(`/admin/${entry.id}`);
    await expect(page).toHaveURL(new RegExp(`/admin#${entry.id}$`));
    await expect(section(page, entry.id)).toHaveClass(/is-active/);
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/admin#${entry.id}$`));
    await expect(section(page, entry.id)).toHaveClass(/is-active/);
    await expect(page.getByRole("heading", { level: 2, name: entry.heading })).toBeVisible();
  }
});

test("设置表单保存、校验失败与恢复，且不再有响应格式控件", async ({ page }) => {
  await login(page);
  await gotoSection(page, "settings");

  await expect(page.getByText("默认响应格式")).toHaveCount(0);
  await expect(page.getByLabel("签名链接有效期（小时）")).toBeVisible();
  await expect(page.getByLabel("图片公开地址")).toBeVisible();

  const refresh = page.getByLabel("自动刷新间隔（毫秒）");
  await refresh.fill("6000");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存").first()).toBeVisible();

  await refresh.fill("2000");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存").first()).toBeVisible();

  const timeout = page.getByLabel("上游超时（毫秒）");
  await page.locator('[data-role="settings-form"]').evaluate((form: HTMLFormElement) => {
    form.noValidate = true;
  });
  await timeout.fill("1000");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("保存失败").first()).toBeVisible();

  await timeout.fill("300000");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存").first()).toBeVisible();
});

test("账号新增、探测、启停、导入、取消删除与确认删除", async ({ page }) => {
  await login(page);
  await gotoSection(page, "accounts");

  await page.getByRole("button", { name: "添加账号" }).click();
  const addDialog = page.locator('[data-role="account-dialog"]');
  await addDialog.getByLabel("名称").fill("e2e-account");
  await addDialog.getByLabel("API Key").fill("e2e-secret");
  await addDialog.getByRole("button", { name: "保存" }).click();
  const accountCard = page.locator(".account-card").filter({ hasText: "e2e-account" });
  await expect(accountCard).toBeVisible();

  await page.getByRole("button", { name: "测试 e2e-account" }).click();
  await expect(page.getByText(/「e2e-account」/)).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "停用 e2e-account" }).click();
  await expect(page.getByRole("button", { name: "启用 e2e-account" })).toBeVisible();
  await page.getByRole("button", { name: "启用 e2e-account" }).click();
  await expect(page.getByRole("button", { name: "停用 e2e-account" })).toBeVisible();

  await page.getByRole("button", { name: "批量导入" }).click();
  const importDialog = page.locator('[data-role="import-dialog"]');
  await importDialog.getByLabel("每行一个「名称,Key」").fill("e2e-import,e2e-import-key");
  await importDialog.getByRole("button", { name: "导入" }).click();
  await expect(page.getByText("已导入 1 个账号").first()).toBeVisible();
  await expect(page.locator(".account-card").filter({ hasText: "e2e-import" })).toBeVisible();

  await page.getByRole("button", { name: "删除 e2e-account" }).click();
  await page.locator('[data-role="confirm-dialog"]').getByRole("button", { name: "取消" }).click();
  await expect(accountCard).toBeVisible();

  await page.getByRole("button", { name: "删除 e2e-account" }).click();
  await page.locator('[data-role="confirm-dialog"]').getByRole("button", { name: "删除", exact: true }).click();
  await expect(accountCard).toHaveCount(0);

  await page.getByRole("button", { name: "删除 e2e-import" }).click();
  await page.locator('[data-role="confirm-dialog"]').getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.locator(".account-card").filter({ hasText: "e2e-import" })).toHaveCount(0);
});

test("日志分类、详情与清空取消", async ({ page }) => {
  await login(page);
  await gotoSection(page, "logs");

  const regular = page.getByRole("button", { name: "常规请求", exact: true });
  const images = page.getByRole("button", { name: "图片请求", exact: true });
  const rows = page.locator('[data-role="logs-table"] tbody tr');
  const imageRows = rows.filter({ hasText: "图片请求" });
  const regularRows = rows.filter({ hasText: "常规请求" });
  await expect(regular).toHaveAttribute("aria-pressed", "true");
  await expect(images).toHaveAttribute("aria-pressed", "false");
  await expect(regularRows.first()).toBeVisible();
  await expect(imageRows).toHaveCount(0);
  await expect(page.getByRole("button", { name: "全部类型" })).toHaveCount(0);
  await images.click();
  await expect(imageRows.first()).toBeVisible();
  await expect(regularRows.first()).toBeVisible();
  await regular.click();
  await expect(regularRows).toHaveCount(0);
  await expect(imageRows.first()).toBeVisible();
  await images.click();
  await expect(page.getByText("请选择要显示的请求类型。")).toBeVisible();
  await images.click();

  await imageRows.first().getByRole("button", { name: "查看请求详情" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("图片请求");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "清空" }).click();
  await page.locator('[data-role="confirm-dialog"]').getByRole("button", { name: "取消" }).click();
  await expect(imageRows.first()).toBeVisible();
});

test("常规日志保留密钥名称，点击请求定位所有对应图片", async ({ page }) => {
  await login(page);
  const origin = new URL(page.url()).origin;
  const prompt = "log gallery jump " + Date.now();
  const create = await page.request.post("/admin/api/api-keys", { headers: { Origin: origin }, data: { name: "日志测试客户端" } });
  expect(create.status()).toBe(201);
  const { id } = await create.json();
  const keyPath = `/admin/api/api-keys/${id}`;
  const { apiKey } = await (await page.request.get(keyPath)).json();
  const response = await page.request.post("/v1/images/generations", {
    headers: { Authorization: `Bearer ${apiKey}` },
    data: { prompt, model: "agnes-image-2.5-flash", n: 2 },
  });
  expect(response.ok()).toBeTruthy();
  const requestId = response.headers()["x-request-id"];
  expect((await page.request.delete(keyPath, { headers: { Origin: origin } })).status()).toBe(204);
  const panelResponse = await page.request.post("/admin/api/images/generations", {
    headers: { Origin: origin },
    data: { prompt: "panel log attribution", model: "agnes-image-2.5-flash" },
  });
  expect(panelResponse.ok()).toBeTruthy();
  const panelRequestId = panelResponse.headers()["x-request-id"];
  const timeline = section(page, "gallery");
  const firstPage = await page.request.get(`/admin/api/gallery?limit=1&requestId=${requestId}`);
  const { items: firstItems, nextBefore } = await firstPage.json();
  expect(firstItems).toHaveLength(1);
  expect(firstItems[0].requestId).toBe(requestId);
  const secondPage = await page.request.get(`/admin/api/gallery?limit=1&requestId=${requestId}&before=${nextBefore}`);
  const { items: secondItems } = await secondPage.json();
  expect(secondItems).toHaveLength(1);
  expect(secondItems[0].requestId).toBe(requestId);

  await gotoSection(page, "logs");
  const logs = section(page, "logs");
  const panelLog = await page.request.get("/admin/api/logs?category=request");
  const { items: entries } = await panelLog.json();
  expect(entries.find((entry) => entry.requestId === panelRequestId)?.apiKeyName).toBe("WEB");
  await expect(logs.getByRole("cell", { name: "WEB", exact: true }).first()).toBeVisible();
  await logs.getByRole("cell", { name: "日志测试客户端", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#gallery\\?requestId=${requestId}$`));
  const matches = timeline.locator(".gallery-card.is-request-match");
  await expect(matches).toHaveCount(2);
  await expect(timeline.locator(".gallery-card")).toHaveCount(2);
  await expect(matches.first()).toBeFocused();
  await expect(matches.first()).toBeInViewport();
  await expect(matches.first()).toContainText(prompt);
  await page.screenshot({ path: "test-results/screenshots/log-gallery-highlight.png" });
  await page.reload();
  await expect(matches).toHaveCount(2);
  await timeline.getByRole("link", { name: "返回完整时间线" }).click();
  await expect(page).toHaveURL(/#gallery$/);
  await expect(matches).toHaveCount(0);
  await expect(timeline.locator(".gallery-card").first()).toBeVisible();
});
