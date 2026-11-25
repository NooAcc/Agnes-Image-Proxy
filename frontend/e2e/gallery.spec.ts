import { expect, test } from "@playwright/test";
import { generateImages, listGallery, login, gotoSection, waitForPrompt } from "./helpers";

test.describe.configure({ mode: "serial" });

test("标签筛选、未归档占位与清除筛选", async ({ page }) => {
  await login(page);
  await gotoSection(page, "gallery");

  await expect(page.locator(".gallery-card").first()).toBeVisible();
  await page.getByRole("button", { name: "色情", exact: true }).click();
  await expect(page.getByText("preview: abstract blue shapes")).toBeVisible();
  await expect(page.locator(".gallery-card")).toHaveCount(1);

  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.locator(".gallery-card").filter({ hasText: "preview: metadata only" })).toContainText("未归档");
});

test("模拟生成后可查看原图、下载，删除取消不删除", async ({ page }) => {
  await login(page);
  const prompt = "e2e gallery image";
  await generateImages(page, prompt, 2);
  const items = await waitForPrompt(page, prompt, 2);
  const target = items[0];

  await gotoSection(page, "gallery");
  await page.getByRole("button", { name: `查看图片：${prompt}` }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(prompt);
  const original = dialog.locator("img");
  await expect(original).toBeVisible();
  await expect.poll(() => original.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64);

  const downloadLink = dialog.getByRole("link", { name: "下载" });
  await expect(downloadLink).not.toHaveAttribute("download", /.+/);
  const href = await downloadLink.getAttribute("href");
  expect(href).toContain(`/admin/api/gallery/${target.id}/content?download=1`);
  const downloaded = await page.request.get(href ?? "");
  expect(downloaded.status()).toBe(200);
  expect(downloaded.headers()["content-disposition"]).toContain("attachment");
  expect((await downloaded.body()).byteLength).toBeGreaterThan(0);
  await page.keyboard.press("Escape");

  const card = page.locator(`.gallery-card[data-id="${target.id}"]`);
  await card.getByRole("button", { name: "删除图片" }).click();
  await page.locator('[data-role="confirm-dialog"]').getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("button", { name: `查看图片：${prompt}` })).toHaveCount(2);
  expect((await listGallery(page)).some((item) => item.id === target.id)).toBe(true);

  await card.getByRole("button", { name: "删除图片" }).click();
  await page.locator('[data-role="confirm-dialog"]').getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("button", { name: `查看图片：${prompt}` })).toHaveCount(1);
  expect((await listGallery(page)).some((item) => item.id === items[1].id)).toBe(true);
});

test("JPEG 与 WebP 下载使用服务器实际后缀", async ({ page }) => {
  await login(page);
  await generateImages(page, "e2e download MIME matrix", 3);
  const items = await waitForPrompt(page, "e2e download MIME matrix", 3);
  for (const extension of ["jpeg", "webp"]) {
    const target = items.find((item) => (item.sourceUrl ?? "").includes(`/mock/${extension}/`));
    expect(target).toBeTruthy();
    await gotoSection(page, "gallery");
    await page
      .locator(`.gallery-card[data-id="${target!.id}"]`)
      .getByRole("button", { name: /查看图片：/ })
      .click();
    const dialog = page.getByRole("dialog");
    const href = await dialog.getByRole("link", { name: "下载" }).getAttribute("href");
    const response = await page.request.get(href ?? "");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-disposition"]).toMatch(
      extension === "jpeg" ? /\.jpg"$/ : /\.webp"$/,
    );
    await page.keyboard.press("Escape");
  }
});

test("快速切换原图不残留上一张", async ({ page }) => {
  await login(page);
  const pngItems = (await listGallery(page)).filter(
    (item) => item.archived && (item.sourceUrl ?? "").includes("/mock/png/"),
  );
  expect(pngItems.length).toBeGreaterThanOrEqual(2);
  const [first, second] = pngItems;

  let delayed = false;
  await page.route(/\/admin\/api\/gallery\/\d+\/content$/, async (route) => {
    if (!delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    await route.continue();
  });

  await gotoSection(page, "gallery");
  await page.getByRole("button", { name: "查看图片：" + first.prompt }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(first.prompt);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "查看图片：" + second.prompt }).first().click();
  await expect(dialog).toContainText(second.prompt);
  const image = dialog.locator("img");
  await expect(image).toBeVisible();
  await expect
    .poll(async () => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
});

test("补齐历史图片启动一次后台任务并显示累计状态", async ({ page }) => {
  await login(page);
  await gotoSection(page, "gallery");

  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/admin/api/gallery/enrich")) {
      posts.push(request.url());
    }
  });

  await page.getByRole("button", { name: "补齐历史图片" }).click();
  await expect(page.getByText("已开始补齐历史图片").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-role="enrich-status"]')).toContainText(/已处理 \d+/, {
    timeout: 20_000,
  });
  expect(posts).toHaveLength(1);
  await expect(page.locator('[data-role="enrich-status"]')).toContainText(/补齐已结束/, {
    timeout: 30_000,
  });
});

test("撤销全部会话后重新登录会重新请求图库", async ({ page }) => {
  await login(page);
  await gotoSection(page, "gallery");
  await expect(page.getByRole("button", { name: /查看图片：/ }).first()).toBeVisible();

  const origin = new URL(page.url()).origin;
  const revoke = await page.request.post("/admin/api/session/revoke", {
    headers: { Origin: origin },
  });
  expect(revoke.status()).toBe(204);

  const galleryRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().includes("/admin/api/gallery?")) {
      galleryRequests.push(request.url());
    }
  });

  await page.goto("/admin/overview#gallery");
  await expect(page).toHaveURL(/\/admin\/login\?next=/, { timeout: 15_000 });
  await page.getByLabel("访问密钥").fill("preview");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/admin#gallery$/);

  await expect.poll(() => galleryRequests.length).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: /查看图片：/ }).first()).toBeVisible();
});
