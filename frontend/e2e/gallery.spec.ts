import { expect, test } from "@playwright/test";
import { generateImages, listGallery, login, gotoSection, waitForPrompt } from "./helpers";

test.describe.configure({ mode: "serial" });

test("HTTPS 图床原图直接展示且不请求代理内容接口", async ({ page }) => {
  await login(page);
  const item = (await listGallery(page)).find((entry) => entry.archived && entry.imageUrl?.endsWith(".png"))!;
  expect(item).toBeTruthy();
  const data = await (await page.request.get(item.imageUrl!)).body();
  const external = "https://img.example.com/file/agnes-image-proxy/2026-11-25/random.png";
  let externalImages = 0;
  let proxyImages = 0;
  await page.route("https://img.example.com/**", (route) => {
    externalImages++;
    expect(route.request().resourceType()).toBe("image");
    return route.fulfill({ status: 200, contentType: "image/png", body: data });
  });
  await page.route(/\/admin\/api\/gallery\?/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.items = [{ ...item, imageUrl: external, thumbnailUrl: null }];
    body.nextBefore = null;
    await route.fulfill({ response, json: body });
  });
  page.on("request", (request) => {
    if (/\/admin\/api\/gallery\/\d+\/(content|thumbnail)$/.test(request.url())) proxyImages++;
  });
  await gotoSection(page, "gallery");
  const card = page.locator(".gallery-card img").first();
  await expect(card).toHaveAttribute("src", external);
  await expect.poll(() => card.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64);
  await page.getByRole("button", { name: "查看图片：" + item.prompt }).click();
  const original = page.getByRole("dialog").locator("img");
  await expect(original).toHaveAttribute("src", external);
  await expect.poll(() => original.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64);
  expect(externalImages).toBeGreaterThan(0);
  expect(proxyImages).toBe(0);
});

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

test("模拟生成后可查看原图、下载，删除取消不删除", async ({ page, playwright, baseURL }) => {
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
  await expect(original).toHaveAttribute("src", target.imageUrl!);
  expect(target.imageUrl).toMatch(/^\/images\/[0-9a-f]{32}\/original\.(png|jpg|webp)$/);
  await expect(page.locator(`.gallery-card[data-id="${target.id}"] img`)).not.toHaveAttribute("src", /^blob:/);
  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    const response = await anonymous.get(target.imageUrl!);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.headers()["set-cookie"]).toBeUndefined();
  } finally {
    await anonymous.dispose();
  }

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
  await page.route(/\/images\/[0-9a-f]{32}\/original\.png$/, async (route) => {
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
