import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { gotoSection, login, SECTIONS, section } from "./helpers";

async function expectNoSeriousViolations(page: import("@playwright/test").Page) {
  // Let the legacy panel fade-in finish; axe samples composited colors mid-animation.
  await page.waitForTimeout(400);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test("登录页、初始化页与各个板块没有 serious/critical 可访问性问题", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/admin/login");
  await expectNoSeriousViolations(page);

  await login(page);
  for (const entry of SECTIONS) {
    await gotoSection(page, entry.id);
    await expect(page.getByRole("heading", { level: 2, name: entry.heading })).toBeVisible();
    await expectNoSeriousViolations(page);
  }

  await page.route("**/admin/api/storage", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ initialized: false }),
    }),
  );
  await page.goto("/admin/setup");
  await expect(page.getByRole("heading", { name: "选择原图存储方式" })).toBeVisible();
  await expectNoSeriousViolations(page);
  await page.getByRole("radio", { name: /ImgBed 图床/ }).check();
  await expect(page.getByLabel("ImgBed Token")).toBeVisible();
  await expectNoSeriousViolations(page);
});

test("375/768/1024/1440 与浅色/深色截图且无整页横向溢出", async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);

  const pages = [
    { id: "overview", name: "overview" },
    { id: "generate", name: "generate" },
    { id: "gallery", name: "gallery" },
    { id: "accounts", name: "accounts" },
    { id: "api-keys", name: "api-keys" },
    { id: "settings", name: "settings" },
  ];
  for (const width of [375, 768, 1024, 1440]) {
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      for (const entry of pages) {
        await page.goto(`/admin/${entry.id}`);
        await expect(section(page, entry.id)).toHaveClass(/is-active/);
        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        );
        expect(overflows, `${entry.name} ${width}px ${scheme}`).toBe(false);
        if (entry.id === "gallery") {
          await page.evaluate(async () => {
            for (let y = 0; y < document.body.scrollHeight; y += 600) {
              window.scrollTo(0, y);
              await new Promise((resolve) => setTimeout(resolve, 60));
            }
            window.scrollTo(0, 0);
          });
          await page.waitForTimeout(300);
        }
        await page.screenshot({
          path: `test-results/screenshots/${entry.name}-${width}-${scheme}.png`,
          fullPage: true,
        });
      }
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/admin/overview");
  const bar = page.locator(".bar-col").first();
  await bar.focus();
  await expect(page.locator('[data-role="trend-readout"]')).toHaveText(/\S+/);
  await page.screenshot({
    path: "test-results/screenshots/overview-trend-1440-light.png",
    fullPage: true,
  });

  await page.goto("/admin/gallery");
  await page.getByRole("button", { name: /查看图片：/ }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({
    path: "test-results/screenshots/gallery-dialog-1440-light.png",
    fullPage: false,
  });
});

test("移动端底部导航、主题保持与灯箱 Escape", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/admin/gallery");

  const bottomNav = page.locator(".bottom-nav");
  await expect(bottomNav).toBeVisible();
  await bottomNav.locator('[data-bottom-nav="accounts"]').click();
  await expect(page).toHaveURL(/\/admin#accounts$/);
  await expect(section(page, "accounts")).toHaveClass(/is-active/);

  await page.getByRole("button", { name: /切换到.*主题/ }).click();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(["light", "dark"]).toContain(theme);
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);

  await page.goto("/admin/gallery");
  await page.getByRole("button", { name: /查看图片：/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("200% 缩放无横向溢出，reduced-motion 近似关闭过渡", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/admin/overview");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/admin/gallery");
  await expect(page.getByRole("heading", { level: 2, name: "图片时间线" })).toBeVisible();
  const duration = await page.evaluate(() => {
    const link = document.querySelector("nav a");
    return link ? getComputedStyle(link).transitionDuration : "";
  });
  expect(duration).not.toBe("");
  const seconds = Number.parseFloat(duration);
  expect(Number.isNaN(seconds) ? 0 : seconds).toBeLessThanOrEqual(0.001);
});
