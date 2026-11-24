import { expect, test } from "@playwright/test";
import {
  generateImages,
  listGallery,
  login,
  mainNav,
  waitForPrompt,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test("标签筛选由 URL 驱动，未归档图片显示源链接", async ({ page }) => {
  await login(page);
  await page.goto("/admin/gallery?tag=porn");
  await expect(page.getByRole("heading", { level: 2, name: "图库" })).toBeVisible();
  await expect(page.getByLabel("标签")).toHaveValue("porn");
  await expect(page.getByRole("button", { name: /查看图片 #/ }).first()).toBeVisible();

  await page.getByLabel("标签").selectOption("");
  await expect(page).toHaveURL(/\/admin\/gallery$/);

  const metadataCard = page.locator("li").filter({ hasText: "preview: metadata only" }).first();
  await expect(metadataCard).toBeVisible();
  await metadataCard.getByRole("button", { name: /查看图片 #/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("未归档");
  await expect(dialog.getByRole("link", { name: "打开源链接" })).toHaveAttribute(
    "href",
    /\/mock\/png\/unarchived$/,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("模拟生成后可下载原图，删除取消不删除", async ({ page }) => {
  await login(page);
  const prompt = "e2e gallery image";
  await generateImages(page, prompt, 2);
  const items = await waitForPrompt(page, prompt, 2);
  const target = items[0];

  await page.goto("/admin/gallery");
  await page.getByRole("button", { name: `查看图片 #${target.id}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(prompt);
  const original = dialog.locator("img");
  await expect(original).toBeVisible();
  await expect.poll(() => original.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64);

  // Headless Chrome does not always surface an <a download> as a Playwright
  // download event, so verify the link contract and the attachment response.
  const downloadLink = dialog.getByRole("link", { name: "下载原图" });
  await expect(downloadLink).not.toHaveAttribute("download", /.+/);
  const href = await downloadLink.getAttribute("href");
  expect(href).toBeTruthy();
  const downloaded = await page.request.get(href ?? "");
  expect(downloaded.status()).toBe(200);
  expect(downloaded.headers()["content-disposition"]).toContain("attachment");
  expect((await downloaded.body()).byteLength).toBeGreaterThan(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: `删除图片 #${target.id}` }).click();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("button", { name: `查看图片 #${target.id}` })).toBeVisible();
  expect((await listGallery(page)).some((item) => item.id === target.id)).toBe(true);

  await page.getByRole("button", { name: `删除图片 #${target.id}` }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("button", { name: `查看图片 #${target.id}` })).toHaveCount(0);
  // The second generated item survives, so the gallery is not emptied.
  expect((await listGallery(page)).some((item) => item.id === items[1].id)).toBe(true);
});

test("JPEG 与 WebP 下载使用服务器实际后缀", async ({ page }) => {
  await login(page);
  await generateImages(page, "e2e download MIME matrix", 3);
  const items = await waitForPrompt(page, "e2e download MIME matrix", 3);
  for (const extension of ["jpeg", "webp"]) {
    const target = items.find((item) => (item.sourceUrl ?? "").includes(`/mock/${extension}/`));
    expect(target).toBeTruthy();
    await page.goto("/admin/gallery");
    await page.getByRole("button", { name: `查看图片 #${target!.id}` }).click();
    const event = page.waitForEvent("download");
    await page.getByRole("dialog").getByRole("link", { name: "下载原图" }).click();
    const download = await event;
    expect(download.suggestedFilename()).toMatch(extension === "jpeg" ? /\.jpg$/ : /\.webp$/);
    expect(await download.failure()).toBeNull();
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

  await page.goto("/admin/gallery");
  await page.getByRole("button", { name: `查看图片 #${first.id}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(first.prompt);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: `查看图片 #${second.id}` }).click();
  await expect(dialog).toContainText(second.prompt);
  const image = dialog.locator("img");
  await expect(image).toBeVisible();
  await expect
    .poll(async () => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  await expect(dialog).not.toContainText("图片加载失败");
});

test("补齐元数据在运行中、隐藏标签页暂停轮询、恢复后完成", async ({ page }) => {
  await login(page);
  await page.goto("/admin/gallery");

  const statusRequests: number[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().includes("/admin/api/gallery/enrich")) {
      statusRequests.push(Date.now());
    }
  });

  await page.getByRole("button", { name: "补齐元数据" }).click();
  await expect(page.getByRole("status")).toContainText("富化任务已开始", { timeout: 10_000 });
  const baseline = statusRequests.length;

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(2_500);
  expect(statusRequests.length - baseline).toBeLessThanOrEqual(1);

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByRole("status")).toContainText(/富化完成|没有需要补齐/, {
    timeout: 15_000,
  });
});

test("撤销全部会话后重新登录会重新请求图库", async ({ page }) => {
  await login(page);
  await page.goto("/admin/gallery");
  await expect(page.getByRole("button", { name: /查看图片 #/ }).first()).toBeVisible();

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

  await page.goto("/admin/overview");
  await expect(page).toHaveURL(/\/admin\/login$/, { timeout: 15_000 });
  await page.getByLabel("管理密钥").fill("preview");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/);

  await mainNav(page).getByRole("link", { name: "图库" }).click();
  await expect.poll(() => galleryRequests.length).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: /查看图片 #/ }).first()).toBeVisible();
});
