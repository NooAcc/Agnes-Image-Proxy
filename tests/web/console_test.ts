import { assert } from "@std/assert";
import { renderAdminPage } from "../../web/ui.ts";

Deno.test("logs section refreshes every five seconds and pauses on selection", () => {
  const html = renderAdminPage();
  assert(html.includes("5 秒"));
  assert(html.includes("选中文字"));
  assert(html.includes("成功/请求"));
  assert(html.includes("entry.error"));
  assert(html.includes("state.logsPaused"));
  assert(html.includes("setInterval"));
  assert(html.includes("5000"));
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
});

Deno.test("gallery timeline is part of the console", () => {
  const html = renderAdminPage();
  assert(html.includes('data-role="gallery-grid"'));
  assert(html.includes('data-action="clear-gallery"'));
  assert(html.includes("IntersectionObserver"));
  assert(html.includes('data-action="delete-image"'));
});
