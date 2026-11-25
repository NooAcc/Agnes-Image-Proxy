import { expect, type Page } from "@playwright/test";

export const ADMIN_KEY = "preview";

export interface GalleryItem {
  id: number;
  prompt: string;
  nsfwTag: string;
  enrichStatus: string;
  archived: boolean;
  sourceUrl: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  createdAt: string;
}

export interface Section {
  id: string;
  heading: string;
}

export const SECTIONS: Section[] = [
  { id: "overview", heading: "当日概览" },
  { id: "generate", heading: "创建生图" },
  { id: "gallery", heading: "图片时间线" },
  { id: "accounts", heading: "Key 池" },
  { id: "logs", heading: "请求日志" },
  { id: "settings", heading: "运行设置" },
];

export function section(page: Page, id: string) {
  return page.locator(`[data-section="${id}"]`);
}

export async function login(page: Page, next = "/admin#overview"): Promise<void> {
  await page.goto("/admin/login");
  await page.getByLabel("访问密钥").fill(ADMIN_KEY);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(new RegExp(`${next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(section(page, "overview")).toHaveClass(/is-active/);
}

export function mainNav(page: Page) {
  return page.locator(".sidebar nav");
}

export async function gotoSection(page: Page, id: string): Promise<void> {
  await page.locator(`.sidebar [data-nav="${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/admin#${id}$`));
  await expect(section(page, id)).toHaveClass(/is-active/);
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
