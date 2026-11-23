import { assert } from "@std/assert";
import { renderAdminPage } from "../../web/ui.ts";

Deno.test("auto refresh is global, active-section scoped and configurable", () => {
  const html = renderAdminPage();
  assert(html.includes('data-role="auto-refresh-toggle"'));
  assert(html.includes('data-action="toggle-auto-refresh"'));
  assert(html.includes('"agnes-auto-refresh"'));
  assert(html.includes("autoRefresh"));
  assert(html.includes("setInterval"));
  assert(html.includes("selectionchange"));
  assert(html.includes("document.hidden"));
  assert(html.includes("is-active"));
  assert(html.includes("/admin/api/settings"));
  assert(html.includes('data-filter="bad"'));
  assert(html.includes('data-action="clear-logs"'));
  assert(html.includes('data-category="request"'));
  assert(html.includes('data-category="enrich"'));
  assert(html.includes("图片信息"));
  // The logs section no longer owns its own auto-refresh toggle or preference.
  assert(!html.includes("agnes-logs-auto"));
  assert(!html.includes('data-role="logs-auto"'));
});

Deno.test("every section registers a refresh hook with the shared scheduler", () => {
  const html = renderAdminPage();
  for (const name of ["overview", "gallery", "accounts", "logs", "settings"]) {
    assert(html.includes(`A.autoRefresh.register("${name}"`), `missing refresh hook for ${name}`);
  }
});

Deno.test("settings form exposes every setting", () => {
  const html = renderAdminPage();
  for (
    const field of [
      "agnesBaseUrl",
      "defaultResponseFormat",
      "defaultSize",
      "imageParamMode",
      "probeModel",
      "probeConcurrency",
      "requestTimeoutMs",
      "autoRefreshIntervalMs",
      "maxAttempts",
      "imageServiceBaseUrl",
      "thumbnailWidth",
      "thumbnailQuality",
      "enrichTimeoutMs",
    ]
  ) {
    assert(html.includes(`name="${field}"`), `missing setting ${field}`);
  }
  assert(html.includes('name="imageServiceBaseUrl"'));
  assert(html.includes('name="thumbnailWidth"'));
  assert(html.includes('name="thumbnailQuality"'));
  assert(html.includes('name="enrichTimeoutMs"'));
  assert(html.includes('type="radio" name="defaultSize" value="4K"'));
  assert(!html.includes('name="defaultRatio"'));
  assert(!html.includes('name="imageParamMode" value="auto"'));
  assert(html.includes('name="imageParamMode" value="nested"'));
  assert(html.includes('name="imageParamMode" value="top_level"'));
  assert(html.includes('name="defaultResponseFormat" value="b64_json" disabled'));
  assert(html.includes('name="defaultResponseFormat" value="url" checked'));
  assert(html.includes('data-role="settings-status"'));
});

Deno.test("gallery timeline and lightbox are part of the console", () => {
  const html = renderAdminPage();
  assert(html.includes('data-role="gallery-grid"'));
  assert(html.includes('data-action="clear-gallery"'));
  assert(html.includes('data-role="gallery-search"'));
  assert(html.includes('data-role="gallery-tags"'));
  assert(html.includes('data-action="enrich-gallery"'));
  assert(html.includes("IntersectionObserver"));
  assert(html.includes('data-action="delete-image"'));
  assert(html.includes('data-action="gallery-prev"'));
  assert(html.includes('data-action="gallery-next"'));
  assert(html.includes('data-role="gallery-download"'));
  assert(html.includes("ArrowLeft"));
  assert(html.includes("ArrowRight"));
  // Auto refresh merges only new items in place instead of resetting pagination.
  assert(html.includes("refreshNewest"));
  assert(html.includes("concat(state.items)"));
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

Deno.test("console uses upstream counters and five-field metrics", () => {
  const html = renderAdminPage();
  assert(html.includes("上游调用"));
  assert(html.includes("upstreamRequests"));
  assert(html.includes("upstreamImages"));
  assert(html.includes("partials"));
  assert(html.includes("failures"));
});
