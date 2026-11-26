import { expect, test } from "@playwright/test";
import { gotoSection, login, section } from "./helpers";

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "UTC" });

test("总览按 UTC+8 选择今天，分别请求所选日与 14 天趋势", async ({ page }) => {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/admin/api/overview")) urls.push(request.url());
  });
  await page.clock.setFixedTime(new Date("2026-11-26T16:00:00Z"));
  await login(page);
  const today = "2026-11-27";
  const trendStart = "2026-11-14";
  await expect(page.getByLabel("日期", { exact: true })).toHaveValue(today);
  await expect.poll(() => urls.some((url) => url.includes(`start=${today}&end=${today}`))).toBe(true);
  await expect.poll(() => urls.some((url) => url.includes(`start=${trendStart}&end=${today}`))).toBe(true);

  await page.getByLabel("日期", { exact: true }).fill("2026-11-25");
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.getByLabel("日期", { exact: true })).toHaveValue(today);
});

test("图片分组与日志时间不受浏览器时区影响", async ({ page }) => {
  await login(page);
  const before = "2026-11-26T15:59:59.999999999Z";
  const midnight = "2026-11-26T16:00:00Z";
  await page.route(/\/admin\/api\/gallery\?/, (route) => route.fulfill({
    json: {
      items: [
        { id: 2, createdAt: midnight, prompt: "UTC+8 午夜", model: "m" },
        { id: 1, createdAt: before, prompt: "UTC+8 午夜前", model: "m" },
      ],
      nextBefore: null,
    },
  }));
  await gotoSection(page, "gallery");
  await expect(page.locator(".timeline-day")).toHaveText(["2026-11-27", "2026-11-26"]);

  await page.route(/\/admin\/api\/logs\?/, (route) => route.fulfill({
    json: {
      items: [{ id: 1, ts: midnight, category: "request", status: 200, images: 1, ok: true }],
      nextBefore: null,
    },
  }));
  await gotoSection(page, "logs");
  await expect(page.getByRole("cell", { name: "2026/11/27 00:00:00" })).toBeVisible();
  await page.getByRole("button", { name: "查看请求详情" }).click();
  await expect(page.getByRole("dialog", { name: "请求详情" })).toContainText("2026/11/27 00:00:00");
});

test("运行中的 401 停止板块请求并带安全目标返回登录", async ({ page }) => {
  await login(page);
  const origin = new URL(page.url()).origin;
  const revoke = await page.request.post("/admin/api/session/revoke", {
    headers: { Origin: origin },
  });
  expect(revoke.status()).toBe(204);

  await page.locator('.sidebar [data-nav="logs"]').click();
  await expect(page).toHaveURL(/\/admin\/login\?next=/, { timeout: 15_000 });
  const next = new URL(page.url()).searchParams.get("next");
  expect(next).toBe("/admin#logs");

  await page.getByLabel("访问密钥").fill("preview");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/admin#logs$/);
  await expect(section(page, "logs")).toHaveClass(/is-active/);
});

test("initialization_required 停止板块请求并转到 setup", async ({ page }) => {
  await login(page);
  await page.route("**/admin/api/accounts", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ error: { code: "initialization_required", message: "storage is not initialized" } }),
    }),
  );
  await page.route("**/admin/api/storage", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ initialized: false }),
    }),
  );
  await page.locator('.sidebar [data-nav="accounts"]').click();
  await expect(page).toHaveURL(/\/admin\/setup$/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "选择原图存储方式" })).toBeVisible();
});

test("缩略图失败时回退到公开原图", async ({ page }) => {
  let thumbnailRequests = 0;
  let contentRequests = 0;
  await page.route(/\/images\/[0-9a-f]{32}\/thumb-[0-9a-f]{32}\.(png|jpg|webp)$/, (route) => {
    thumbnailRequests += 1;
    return route.fulfill({ status: 404, body: "" });
  });
  await page.route(/\/images\/[0-9a-f]{32}\/original\.(png|jpg|webp)$/, (route) => {
    contentRequests += 1;
    return route.continue();
  });
  await login(page);
  await gotoSection(page, "gallery");
  const image = page.locator(".gallery-card img").first();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64);
  expect(thumbnailRequests).toBeGreaterThan(0);
  expect(contentRequests).toBeGreaterThan(0);
});

test("清空图片失败时提示可能部分完成并重新读取列表", async ({ page }) => {
  await login(page);
  await gotoSection(page, "gallery");
  await expect(page.locator(".gallery-card").first()).toBeVisible();

  await page.route("**/admin/api/gallery", (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({
        status: 500,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ error: { message: "write failed", code: "server_error" } }),
      });
    }
    return route.continue();
  });

  await page.getByRole("button", { name: "清空全部" }).click();
  await page.locator('[data-role="confirm-dialog"]').getByRole("button", { name: "清空全部", exact: true }).click();
  await expect(page.getByText(/清空可能只完成了一部分/)).toBeVisible();
  await expect(page.locator(".gallery-card").first()).toBeVisible();
});

test("导入格式错误时阻止提交并标出原始行", async ({ page }) => {
  await login(page);
  await gotoSection(page, "accounts");
  await page.getByRole("button", { name: "批量导入" }).click();
  await page.getByLabel("每行一个「名称,Key」").fill("valid,key\nbroken-line");
  await page.getByRole("button", { name: "导入", exact: true }).click();
  const dialog = page.locator('[data-role="import-dialog"]');
  await expect(dialog.getByText(/第 2 行缺少逗号/)).toBeVisible();
  await expect(dialog.getByText(/本次未提交任何账号/)).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();
});
