import { assert } from "@std/assert";
import { renderAdminPage } from "../../web/ui.ts";

Deno.test("logs refresh every five seconds and pause when hidden or selecting", () => {
  const html = renderAdminPage();
  assert(html.includes("5 秒"));
  assert(html.includes("自动刷新"));
  assert(html.includes("5000"));
  assert(html.includes("setInterval"));
  assert(html.includes("selectionchange"));
  assert(html.includes("document.hidden"));
  assert(html.includes("pausedBySelection"));
  assert(html.includes('data-filter="bad"'));
  assert(html.includes('data-action="clear-logs"'));
});

Deno.test("settings form exposes every setting", () => {
  const html = renderAdminPage();
  for (
    const field of [
      "agnesBaseUrl",
      "defaultResponseFormat",
      "defaultSize",
      "defaultRatio",
      "imageParamMode",
      "probeModel",
      "probeConcurrency",
      "requestTimeoutMs",
      "maxAttempts",
    ]
  ) {
    assert(html.includes(`name="${field}"`), `missing setting ${field}`);
  }
  assert(html.includes('type="radio" name="defaultSize" value="4K"'));
  assert(html.includes('data-role="settings-status"'));
});

Deno.test("gallery timeline and lightbox are part of the console", () => {
  const html = renderAdminPage();
  assert(html.includes('data-role="gallery-grid"'));
  assert(html.includes('data-action="clear-gallery"'));
  assert(html.includes('data-role="gallery-search"'));
  assert(html.includes("IntersectionObserver"));
  assert(html.includes('data-action="delete-image"'));
  assert(html.includes('data-action="gallery-prev"'));
  assert(html.includes('data-action="gallery-next"'));
  assert(html.includes('data-role="gallery-download"'));
  assert(html.includes("ArrowLeft"));
  assert(html.includes("ArrowRight"));
});

Deno.test("overview renders trend chart and model usage hooks", () => {
  const html = renderAdminPage();
  assert(html.includes('data-role="trend-chart"'));
  assert(html.includes('data-role="trend-readout"'));
  assert(html.includes('data-role="model-list"'));
  assert(html.includes('data-action="overview-today"'));
  assert(html.includes("/admin/api/overview"));
  assert(html.includes("data.trend"));
});
