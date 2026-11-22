import { assert } from "@std/assert";
import { GALLERY_DIALOGS, GALLERY_HTML, GALLERY_SCRIPT } from "../../web/gallery.ts";
import { BASE_STYLE } from "../../web/styles.ts";

Deno.test("gallery section exposes its hooks", () => {
  const html = GALLERY_HTML;
  assert(html.includes('data-section="gallery"'));
  assert(html.includes('data-role="gallery-grid"'));
  assert(html.includes('data-action="clear-gallery"'));
  assert(html.includes('data-role="gallery-search"'));
  assert(html.includes("还没有归档图片"));
  assert(html.includes('data-role="gallery-empty"'));
  assert(html.includes('data-role="gallery-sentinel"'));
});

Deno.test("gallery script pages with an IntersectionObserver and deletes images", () => {
  assert(GALLERY_SCRIPT.includes("/admin/api/gallery"));
  assert(GALLERY_SCRIPT.includes("IntersectionObserver"));
  assert(GALLERY_SCRIPT.includes('"delete-image"'));
  assert(GALLERY_SCRIPT.includes("/content"));
  assert(GALLERY_SCRIPT.includes('image.loading = "lazy"'));
  assert(!GALLERY_SCRIPT.includes("http://"));
  assert(!GALLERY_SCRIPT.includes("https://"));
});

Deno.test("gallery lightbox supports keyboard paging and actions", () => {
  const html = GALLERY_DIALOGS;
  assert(html.includes('data-action="gallery-prev"'));
  assert(html.includes('data-action="gallery-next"'));
  assert(html.includes("lightbox-close"));
  assert(!html.includes("gallery-counter"));
  assert(html.includes('data-action="toggle-prompt"'));
  assert(html.includes("is-clamped"));
  assert(GALLERY_SCRIPT.includes("setPrompt"));
  assert(GALLERY_SCRIPT.includes("is-clamped"));
  assert(GALLERY_SCRIPT.includes('data-action="gallery-copy"'));
  assert(GALLERY_SCRIPT.includes('data-action="gallery-delete"'));
  assert(html.includes('data-role="gallery-download"'));
  assert(GALLERY_SCRIPT.includes("ArrowLeft"));
  assert(GALLERY_SCRIPT.includes("ArrowRight"));
  assert(GALLERY_SCRIPT.includes("download"));
});

Deno.test("gallery lightbox nsfw line keeps only the five base classes", () => {
  assert(GALLERY_SCRIPT.includes("暂无 NSFW 数据"));
  assert(!GALLERY_SCRIPT.includes("非 NSFW "));
  assert(!GALLERY_SCRIPT.includes("nsfwPercent"));
});

Deno.test("gallery cards fall back to the source URL when unarchived", () => {
  assert(GALLERY_SCRIPT.includes("gallery-placeholder"));
  assert(GALLERY_SCRIPT.includes("sourceUrl"));
  assert(GALLERY_SCRIPT.includes("noreferrer noopener"));
});

Deno.test("gallery filtering is client-side and preserves day grouping", () => {
  assert(GALLERY_SCRIPT.includes("searchText"));
  assert(GALLERY_SCRIPT.includes("timeline-day"));
  assert(GALLERY_SCRIPT.includes("filteredItems"));
});

Deno.test("gallery exposes tag filters, thumbnails and backfill", () => {
  assert(GALLERY_HTML.includes('data-role="gallery-tags"'));
  assert(GALLERY_HTML.includes('data-action="filter-tag"'));
  assert(GALLERY_HTML.includes('data-tag="safe"'));
  assert(GALLERY_HTML.includes('data-tag="uncategorized"'));
  assert(GALLERY_HTML.includes('data-action="enrich-gallery"'));
  assert(GALLERY_SCRIPT.includes("/thumbnail"));
  assert(GALLERY_SCRIPT.includes("hasThumbnail"));
  assert(GALLERY_SCRIPT.includes("gallery-dialog-tag"));
  assert(GALLERY_SCRIPT.includes("gallery-dialog-nsfw"));
  assert(GALLERY_SCRIPT.includes("nextBefore"));
  assert(GALLERY_SCRIPT.includes("TAG_LABELS"));
});

Deno.test("gallery lightbox hides the stale frame while the next image loads", () => {
  assert(GALLERY_SCRIPT.includes("setDialogImage"));
  assert(GALLERY_SCRIPT.includes('"is-loading"'));
  assert(GALLERY_SCRIPT.includes("image.onload"));
  assert(GALLERY_SCRIPT.includes("image.onerror"));
  assert(BASE_STYLE.includes(".lightbox-stage.is-loading"));
  assert(BASE_STYLE.includes(".lightbox-stage.is-loading img"));
});

Deno.test("gallery backfill button reflects idle, running and error states", () => {
  assert(GALLERY_HTML.includes('class="btn primary is-unavailable" data-action="enrich-gallery"'));
  assert(GALLERY_HTML.includes('title="请先在设置里填写 Edge-Images 基础地址"'));
  assert(GALLERY_SCRIPT.includes("setEnrichState"));
  assert(GALLERY_SCRIPT.includes("is-running"));
  assert(GALLERY_SCRIPT.includes("is-error"));
  assert(GALLERY_SCRIPT.includes('setEnrichState(hadError ? "error" : "idle")'));
});

Deno.test("gallery backfill is unavailable until the image service is configured", () => {
  assert(GALLERY_SCRIPT.includes("setEnrichAvailability"));
  assert(GALLERY_SCRIPT.includes("imageServiceConfigured"));
  assert(GALLERY_SCRIPT.includes("imageServiceBaseUrl"));
  assert(GALLERY_SCRIPT.includes("is-unavailable"));
  assert(GALLERY_SCRIPT.includes('"agnes:settings"'));
});
