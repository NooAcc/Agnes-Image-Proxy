import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ADMIN_KEY, gotoSection, login, section } from "./helpers";

const keysAPI = "/admin/api/api-keys";

test("create, copy, use and revoke a scoped API key", async ({ page, playwright }) => {
  await login(page);
  await gotoSection(page, "api-keys");
  const keys = section(page, "api-keys");
  const label = "分发测试客户端";
  await keys.getByRole("button", { name: "新建密钥" }).click();
  const create = page.getByRole("dialog", { name: "新建生图密钥" });
  await create.getByLabel("密钥名称").fill(label);
  await create.getByRole("button", { name: "创建密钥" }).click();
  const card = keys.getByRole("article").filter({ hasText: label });
  await expect(card).toContainText(/sk-agnes-.+…/);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await expect(card).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).include('[data-section="api-keys"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(violations).toEqual([]);
  }

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await card.getByRole("button", { name: /复制密钥/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "已复制生图密钥" })).toBeVisible();
  const key = await page.evaluate(() => navigator.clipboard.readText());
  expect(key).toMatch(/^sk-agnes-[A-Za-z0-9_-]+$/);
  await expect(card).not.toContainText(key);
  await page.reload();
  await card.getByRole("button", { name: /复制密钥/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "已复制生图密钥" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);

  const client = await playwright.request.newContext({ baseURL: new URL(page.url()).origin, extraHTTPHeaders: { Authorization: `Bearer ${key}` } });
  try {
    expect((await client.get(keysAPI)).status()).toBe(401);
    expect((await client.post("/admin/api/session", { data: { apiKey: key } })).status()).toBe(401);
    const payload = { model: "agnes-image-2.5-flash", prompt: "scoped key e2e" };
    const generated = await client.post("/v1/images/generations", { data: payload });
    expect(generated.ok()).toBeTruthy();
    const { data } = await generated.json();
    const edit = await client.post("/v1/images/edits", { data: { ...payload, image: data[0].url } });
    expect(edit.ok()).toBeTruthy();

    await card.getByRole("button", { name: /撤销密钥/ }).click();
    await page.getByRole("dialog", { name: "撤销生图密钥？" }).getByRole("button", { name: "撤销密钥" }).click();
    await expect(card).toHaveCount(0);
    expect((await client.post("/v1/images/generations", { data: payload })).status()).toBe(401);
  } finally {
    await client.dispose();
  }
});

test("mobile API key deep link redirects to login and keeps the tab", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/admin/api-keys");
  await expect(page).toHaveURL(/\/admin\/login\?next=/);
  await page.getByLabel("访问密钥").fill(ADMIN_KEY);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/admin#api-keys$/);
  await expect(section(page, "api-keys").getByRole("heading", { name: "生图 API 密钥" })).toBeVisible();
  await expect(page.locator('.bottom-nav [data-bottom-nav="api-keys"]')).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
