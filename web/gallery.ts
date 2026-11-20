import { icon } from "./icons.ts";

/** Gallery timeline section for the console. */
export function renderGallerySection(): string {
  return `
<section class="panel" data-section="gallery">
  <div class="panel-head">
    <div>
      <h1>图片</h1>
      <p>每次成功生成并返回给客户端的输出图；按 UTC 日期分组，点击查看大图与提示词。</p>
    </div>
    <div class="toolbar">
      <button class="btn danger" data-action="clear-gallery" type="button">${
    icon("trash")
  }清空全部</button>
    </div>
  </div>
  <div class="gallery-empty empty" data-role="gallery-empty">还没有归档图片。生成的输出图会自动出现在这里。</div>
  <div class="gallery-grid" data-role="gallery-grid"></div>
  <div class="gallery-sentinel muted" data-role="gallery-sentinel">向下滚动加载更多</div>
  <dialog data-role="gallery-dialog">
    <div class="dialog-body">
      <div class="dialog-head">
        <h1>图片详情</h1>
        <button class="btn ghost" type="button" data-action="close-gallery-dialog">${
    icon("close")
  }</button>
      </div>
      <img class="gallery-preview" data-role="gallery-dialog-image" alt="生成图片">
      <p class="muted" data-role="gallery-dialog-meta"></p>
    </div>
  </dialog>
</section>`;
}

/** Client script for the gallery timeline. Uses IntersectionObserver for paging. */
export const GALLERY_SCRIPT = String.raw`
(function () {
  "use strict";
  // Card buttons carry data-action="delete-image"; they are handled below.
  var state = { before: null, loading: false, exhausted: false, lastDay: null, loaded: false };

  function bySelector(selector) { return document.querySelector(selector); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function fmtTime(value) {
    if (!value) return "";
    try { return new Date(value).toLocaleString(); } catch (error) { return String(value); }
  }
  function dayOf(value) {
    return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : "未知日期";
  }

  function metaText(item) {
    var parts = [];
    if (item.model) parts.push(item.model);
    if (item.size) parts.push(item.size);
    if (item.accountName) parts.push(item.accountName);
    parts.push(fmtTime(item.ts));
    if (item.byteSize) parts.push(Math.round(item.byteSize / 1024) + " KB");
    return parts.join(" · ");
  }

  function openDialog(item, src) {
    var dialog = bySelector('[data-role="gallery-dialog"]');
    var image = bySelector('[data-role="gallery-dialog-image"]');
    var meta = bySelector('[data-role="gallery-dialog-meta"]');
    if (!dialog || !image || !meta) return;
    image.src = src;
    meta.textContent = (item.prompt || "(无提示词)") + " — " + metaText(item);
    dialog.showModal();
  }

  function buildCard(item) {
    var card = el("article", "gallery-card");
    card.setAttribute("data-id", String(item.id));
    var media = el("div", "gallery-media");
    if (item.archived) {
      var image = document.createElement("img");
      image.loading = "lazy";
      image.alt = item.prompt || "生成图片";
      image.src = "/admin/api/gallery/" + item.id + "/content";
      image.addEventListener("click", function () { openDialog(item, image.src); });
      media.append(image);
    } else {
      media.classList.add("gallery-placeholder");
      media.append(el("span", null, "未归档"));
      if (item.sourceUrl) {
        var link = document.createElement("a");
        link.href = item.sourceUrl;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        link.textContent = "查看原图";
        media.append(link);
      }
    }
    card.append(media);

    var body = el("div", "gallery-body");
    var prompt = el("p", "gallery-prompt", item.prompt || "(无提示词)");
    prompt.title = item.prompt || "";
    body.append(prompt);
    body.append(el("p", "gallery-meta", metaText(item)));

    var actions = el("div", "gallery-actions");
    var remove = el("button", "btn small danger", "删除");
    remove.type = "button";
    remove.setAttribute("data-action", "delete-image");
    remove.setAttribute("data-id", String(item.id));
    actions.append(remove);
    body.append(actions);
    card.append(body);
    return card;
  }

  function renderItems(items) {
    var grid = bySelector('[data-role="gallery-grid"]');
    var empty = bySelector('[data-role="gallery-empty"]');
    if (!grid) return;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var day = dayOf(item.ts);
      if (day !== state.lastDay) {
        grid.append(el("h2", "timeline-day", day));
        state.lastDay = day;
      }
      grid.append(buildCard(item));
      state.loaded = true;
    }
    if (state.loaded && empty) empty.hidden = true;
  }

  function updateSentinel() {
    var sentinel = bySelector('[data-role="gallery-sentinel"]');
    if (!sentinel) return;
    sentinel.textContent = state.exhausted ? "没有更多图片了" : "向下滚动加载更多";
  }

  async function loadPage() {
    if (state.loading || state.exhausted) return;
    state.loading = true;
    var url = "/admin/api/gallery?limit=24" + (state.before === null ? "" : "&before=" + state.before);
    try {
      var response = await fetch(url, { credentials: "same-origin" });
      var page = await response.json();
      if (!response.ok) {
        throw new Error(page && page.error && page.error.message ? page.error.message : "加载失败");
      }
      renderItems(page.items || []);
      state.before = page.nextBefore;
      state.exhausted = page.nextBefore === null;
      updateSentinel();
    } catch (error) {
      var sentinel = bySelector('[data-role="gallery-sentinel"]');
      if (sentinel) sentinel.textContent = "加载失败：" + error.message;
    }
    state.loading = false;
  }

  function resetGallery() {
    var grid = bySelector('[data-role="gallery-grid"]');
    if (grid) grid.replaceChildren();
    state.before = null;
    state.loading = false;
    state.exhausted = false;
    state.lastDay = null;
    state.loaded = false;
    loadPage();
  }

  async function removeImage(id) {
    try {
      await fetch("/admin/api/gallery/" + id, { method: "DELETE", credentials: "same-origin" });
      resetGallery();
    } catch (error) { /* keep the timeline usable */ }
  }

  async function clearGallery() {
    try {
      await fetch("/admin/api/gallery", { method: "DELETE", credentials: "same-origin" });
      resetGallery();
    } catch (error) { /* ignore */ }
  }

  document.addEventListener("click", function (event) {
    var close = event.target.closest('[data-action="close-gallery-dialog"]');
    if (close) {
      var dialog = close.closest("dialog");
      if (dialog) dialog.close();
      return;
    }
    var remove = event.target.closest('[data-action="delete-image"]');
    if (remove) {
      if (confirm("确定删除这张图片？")) removeImage(remove.getAttribute("data-id"));
      return;
    }
    var clear = event.target.closest('[data-action="clear-gallery"]');
    if (clear && confirm("确定清空全部归档图片？")) clearGallery();
  });

  var sentinel = bySelector('[data-role="gallery-sentinel"]');
  if (sentinel && typeof IntersectionObserver === "function") {
    var observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) loadPage();
      }
    }, { rootMargin: "240px" });
    observer.observe(sentinel);
  }
  loadPage();
})();
`;
