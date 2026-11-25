import { expect, test, type Page, type Route } from "@playwright/test";
import { gotoSection, listGallery, login } from "./helpers";

type StorageStatus =
  | { initialized: false }
  | { initialized: true; mode: "local" }
  | {
      initialized: true;
      mode: "imgbed";
      imgbedBaseUrl: string;
      hasImgbedToken: boolean;
    };

async function fulfill(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });
}

async function mockStorage(page: Page, state: { status: StorageStatus; posted?: unknown }): Promise<void> {
  await page.route("**/admin/api/storage", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      state.posted = request.postDataJSON();
      state.status = {
        initialized: true,
        mode: "imgbed",
        imgbedBaseUrl: "https://img.example.com",
        hasImgbedToken: true,
      };
      await fulfill(route, 201, state.status);
      return;
    }
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as { imgbedBaseUrl: string; imgbedToken?: string };
      state.status = {
        initialized: true,
        mode: "imgbed",
        imgbedBaseUrl: body.imgbedBaseUrl,
        hasImgbedToken: true,
      };
      await fulfill(route, 200, state.status);
      return;
    }
    await fulfill(route, 200, state.status);
  });
}

test("same-document ImgBed address updates refresh all loaded gallery URLs", async ({ page }) => {
  await login(page);
  const item = (await listGallery(page)).find((entry) => entry.archived && entry.imageUrl?.endsWith(".png"))!;
  const data = await (await page.request.get(item.imageUrl!)).body();
  const state: { status: StorageStatus } = { status: { initialized: true, mode: "imgbed", imgbedBaseUrl: "https://old.example.com", hasImgbedToken: true } };
  await mockStorage(page, state);
  await page.route(/https:\/\/(old|new)\.example\.com\//, (route) => route.fulfill({ status: 200, contentType: "image/png", body: data }));
  await page.route(/\/admin\/api\/gallery\?/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const origin = state.status.initialized && state.status.mode === "imgbed" ? state.status.imgbedBaseUrl : "";
    body.items = [{ ...item, imageUrl: origin + "/file/random.png", thumbnailUrl: null }];
    body.nextBefore = null;
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await gotoSection(page, "gallery");
  const image = page.locator(".gallery-card img").first();
  await expect(image).toHaveAttribute("src", "https://old.example.com/file/random.png");
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(64);
  await gotoSection(page, "settings");
  await page.getByLabel("ImgBed 地址").fill("https://new.example.com");
  await page.getByRole("button", { name: "保存存储配置" }).click();
  await expect(page.getByText("存储配置已保存", { exact: true })).toBeVisible();
  await gotoSection(page, "gallery");
  await expect(image).toHaveAttribute("src", "https://new.example.com/file/random.png");
  await page.getByRole("button", { name: "查看图片：" + item.prompt }).click();
  await expect(page.getByRole("dialog").locator("img")).toHaveAttribute("src", "https://new.example.com/file/random.png");
});

test("setup requires an explicit choice, is keyboard operable and fits 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await login(page);
  const state: { status: StorageStatus; posted?: unknown } = { status: { initialized: false } };
  await mockStorage(page, state);

  await page.goto("/admin/setup");
  await expect(page.getByRole("heading", { name: "选择原图存储方式" })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/setup$/);
  const local = page.getByRole("radio", { name: /本地存储/ });
  const imgbed = page.getByRole("radio", { name: /ImgBed 图床/ });
  await expect(local).not.toBeChecked();
  await expect(imgbed).not.toBeChecked();
  const submit = page.getByRole("button", { name: "初始化存储" });
  await expect(submit).toBeDisabled();

  await local.focus();
  await page.keyboard.press("ArrowDown");
  await expect(imgbed).toBeChecked();
  await page.getByLabel("ImgBed 地址").fill("https://img.example.com");
  await page.getByLabel("ImgBed Token").fill("secret-token");
  await expect(submit).toBeEnabled();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);

  await submit.click();
  await expect(page).toHaveURL(/\/admin#overview$/);
  expect(state.posted).toEqual({
    mode: "imgbed",
    imgbedBaseUrl: "https://img.example.com",
    imgbedToken: "secret-token",
  });
  await expect(page.getByText("secret-token")).toHaveCount(0);
});

test("initialization conflict refetches the fixed status", async ({ page }) => {
  await login(page);
  let status: StorageStatus = { initialized: false };
  await page.route("**/admin/api/storage", async (route) => {
    if (route.request().method() === "POST") {
      status = { initialized: true, mode: "local" };
      await fulfill(route, 409, {
        error: {
          message: "storage is already initialized",
          type: "invalid_request_error",
          param: null,
          code: "already_initialized",
        },
      });
      return;
    }
    await fulfill(route, 200, status);
  });

  await page.goto("/admin/setup");
  await page.getByRole("radio", { name: /本地存储/ }).check();
  await page.getByRole("button", { name: "初始化存储" }).click();
  await expect(page).toHaveURL(/\/admin#overview$/);
  await expect(page.getByRole("heading", { level: 2, name: "当日概览" })).toBeVisible();
});

test("settings keeps the fixed mode read only and never echoes the token", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await login(page);
  await page.goto("/admin/settings");

  // The preview itself is initialized in local mode.
  await expect(page.getByText("本地文件", { exact: true })).toBeVisible();
  await expect(page.getByLabel("新 Token")).not.toBeVisible();

  const status: StorageStatus = {
    initialized: true,
    mode: "imgbed",
    imgbedBaseUrl: "https://img.example.com",
    hasImgbedToken: true,
  };
  await page.route("**/admin/api/storage", (route) => fulfill(route, 200, status));
  await page.reload();
  await expect(page.getByText("ImgBed 图床", { exact: true })).toBeVisible();
  await expect(page.getByText("已配置", { exact: true })).toBeVisible();
  await expect(page.getByLabel("新 Token")).toHaveValue("");
  await expect(
    page.locator('[data-role="storage-card"]').getByRole("radio"),
  ).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
});
