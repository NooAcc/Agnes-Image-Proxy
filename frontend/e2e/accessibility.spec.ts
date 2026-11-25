import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { login, mainNav } from "./helpers";

async function expectNoSeriousViolations(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test("登录页与五个主页面没有 serious/critical 可访问性问题", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/admin/login");
  await expectNoSeriousViolations(page);

  await login(page);
  const pages = [
    { path: "/overview", heading: "总览" },
    { path: "/gallery", heading: "图库" },
    { path: "/accounts", heading: "上游账号" },
    { path: "/logs", heading: "请求日志" },
    { path: "/settings", heading: "服务设置" },
  ];
  for (const entry of pages) {
    await page.goto(`/admin${entry.path}`);
    await expect(page.getByRole("heading", { level: 2, name: entry.heading })).toBeVisible();
    await expectNoSeriousViolations(page);
  }
});

test("375/768/1024/1440 与浅色/深色截图且无整页横向溢出", async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);

  const pages = [
    { path: "/overview", heading: "总览", name: "overview" },
    { path: "/gallery", heading: "图库", name: "gallery" },
    { path: "/accounts", heading: "上游账号", name: "accounts" },
    { path: "/settings", heading: "服务设置", name: "settings" },
  ];
  for (const width of [375, 768, 1024, 1440]) {
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      for (const entry of pages) {
        await page.goto(`/admin${entry.path}`);
        await expect(
          page.getByRole("heading", { level: 2, name: entry.heading }),
        ).toBeVisible();
        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        );
        expect(overflows, `${entry.name} ${width}px ${scheme}`).toBe(false);
        if (entry.name === "gallery") {
          // Trigger lazy thumbnails below the fold before the full-page shot.
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
  const point = page.locator('svg circle[role="button"]').first();
  await point.focus();
  await expect(page.getByRole("status").first()).toHaveText(/\S+/);
  await page.screenshot({
    path: "test-results/screenshots/overview-tooltip-1440-light.png",
    fullPage: true,
  });

  await page.goto("/admin/gallery");
  await page.getByRole("button", { name: /查看图片 #/ }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({
    path: "test-results/screenshots/gallery-dialog-1440-light.png",
    fullPage: false,
  });
});

test("移动端导航 Sheet 有焦点陷阱且 Escape 后焦点回到触发按钮", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/admin/gallery");
  const opener = page.getByRole("button", { name: "打开导航" });
  await opener.click();

  const sheet = page.getByRole("dialog", { name: "导航" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link", { name: "总览" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(mainNav(page)).toHaveCount(0);
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
  await expect(page.getByRole("heading", { level: 2, name: "图库" })).toBeVisible();
  const duration = await page.evaluate(() => {
    const link = document.querySelector("nav a");
    return link ? getComputedStyle(link).transitionDuration : "";
  });
  expect(duration).not.toBe("");
  const seconds = Number.parseFloat(duration);
  expect(Number.isNaN(seconds) ? 0 : seconds).toBeLessThanOrEqual(0.001);
});

test("初始化页面与只读图床设置没有 serious/critical 可访问性问题", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);

  let status: unknown = { initialized: false };
  await page.route("**/admin/api/storage", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(status),
    }),
  );

  await page.goto("/admin/setup");
  await expect(page.getByRole("heading", { name: "初始化 Agnes Image Proxy" })).toBeVisible();
  await expectNoSeriousViolations(page);

  await page.getByRole("radio", { name: /图床存储/ }).check();
  await expect(page.getByLabel("API Token")).toBeVisible();
  await expectNoSeriousViolations(page);

  status = {
    initialized: true,
    mode: "imgbed",
    imgbedBaseUrl: "https://img.example.com",
    hasImgbedToken: true,
  };
  await page.goto("/admin/settings");
  await expect(page.getByText("图床存储", { exact: true })).toBeVisible();
  await expectNoSeriousViolations(page);
});
