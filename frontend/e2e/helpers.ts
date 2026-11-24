import { expect, type Page } from "@playwright/test";

export const ADMIN_KEY = "preview";

export interface GalleryItem {
  id: number;
  prompt: string;
  nsfwTag: string;
  enrichStatus: string;
  archived: boolean;
  sourceUrl: string | null;
}

export async function login(page: Page): Promise<void> {
  await page.goto("/admin/login");
  await page.getByLabel("管理密钥").fill(ADMIN_KEY);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/);
  await expect(page.getByRole("heading", { level: 2, name: "总览" })).toBeVisible();
}

export function mainNav(page: Page) {
  return page.getByRole("navigation", { name: "主导航" });
}

export async function gotoPage(
  page: Page,
  label: string,
  path: string,
  heading: string,
): Promise<void> {
  await mainNav(page).getByRole("link", { name: label }).click();
  await expect(page).toHaveURL(new RegExp(`${path.replaceAll("/", "\\/")}$`));
  await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
}

export async function generateImages(page: Page, prompt: string, n: number): Promise<void> {
  const response = await page.request.post("/v1/images/generations", {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    data: { model: "agnes-image-2.5-flash", prompt, n },
  });
  expect(response.ok()).toBeTruthy();
}

export async function listGallery(page: Page): Promise<GalleryItem[]> {
  const response = await page.request.get("/admin/api/gallery?limit=100");
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { items: GalleryItem[] };
  return body.items;
}

export async function waitForPrompt(page: Page, prompt: string, count: number): Promise<GalleryItem[]> {
  await expect
    .poll(async () => (await listGallery(page)).filter((item) => item.prompt === prompt).length, {
      timeout: 15_000,
    })
    .toBe(count);
  return (await listGallery(page)).filter((item) => item.prompt === prompt);
}
