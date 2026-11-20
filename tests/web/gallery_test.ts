import { assert } from "@std/assert";
import { GALLERY_SCRIPT, renderGallerySection } from "../../web/gallery.ts";

Deno.test("gallery section exposes its hooks", () => {
  const html = renderGallerySection();
  assert(html.includes('data-section="gallery"'));
  assert(html.includes('data-role="gallery-grid"'));
  assert(html.includes('data-action="clear-gallery"'));
  assert(html.includes("还没有归档图片"));
  assert(html.includes('data-role="gallery-empty"'));
});

Deno.test("gallery script pages with an IntersectionObserver and deletes images", () => {
  assert(GALLERY_SCRIPT.includes("/admin/api/gallery"));
  assert(GALLERY_SCRIPT.includes("IntersectionObserver"));
  assert(GALLERY_SCRIPT.includes('data-action="delete-image"'));
  assert(GALLERY_SCRIPT.includes("/content"));
  assert(GALLERY_SCRIPT.includes('loading = "lazy"'));
  assert(!GALLERY_SCRIPT.includes("http://"));
  assert(!GALLERY_SCRIPT.includes("https://"));
});

Deno.test("gallery cards fall back to the source URL when unarchived", () => {
  assert(GALLERY_SCRIPT.includes("gallery-placeholder"));
  assert(GALLERY_SCRIPT.includes("sourceUrl"));
  assert(GALLERY_SCRIPT.includes("noreferrer noopener"));
});
