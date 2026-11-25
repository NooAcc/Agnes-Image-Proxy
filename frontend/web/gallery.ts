import { icon } from "./icons.ts";
import { enrichSummaryText } from "./contracts.ts";

/** Gallery section: archived output images grouped by UTC day. */
export const GALLERY_HTML = `
<section class="panel" data-section="gallery" data-title="图片">
  <div class="section-head">
    <div class="section-lead">
      <h2>图片时间线</h2>
      <p>每次成功生成并返回给客户端的输出图；按 UTC 日期分组，点击图片查看大图与提示词。</p>
    </div>
    <div class="toolbar">
      <button class="btn primary is-unavailable" data-action="enrich-gallery" type="button"
        title="请先在设置里填写 Edge-Images 基础地址" disabled>${icon("bolt")}补齐历史图片</button>
      <span class="logs-status" data-role="enrich-status" aria-live="polite"></span>
      <button class="btn" data-action="refresh-gallery" type="button">${
  icon("refresh")
}刷新</button>
      <button class="btn danger" data-action="clear-gallery" type="button">${
  icon("trash")
}清空全部</button>
    </div>
  </div>
  <div class="filter-bar">
    <div class="search">
      ${icon("search")}
      <input class="input" data-role="gallery-search" type="search" placeholder="搜索已加载图片的提示词、模型或账号…" aria-label="搜索图片">
    </div>
    <div class="tag-chips" data-role="gallery-tags" role="group" aria-label="按标签筛选">
      <button class="chip is-active" type="button" data-action="filter-tag" data-tag="">全部</button>
      <button class="chip" type="button" data-action="filter-tag" data-tag="safe">普通</button>
      <button class="chip" type="button" data-action="filter-tag" data-tag="drawing">绘画</button>
      <button class="chip" type="button" data-action="filter-tag" data-tag="sexy">性感</button>
      <button class="chip" type="button" data-action="filter-tag" data-tag="porn">色情</button>
      <button class="chip" type="button" data-action="filter-tag" data-tag="hentai">动漫色情</button>
      <button class="chip" type="button" data-action="filter-tag" data-tag="unclassified">未分类</button>
    </div>
    <span class="logs-status" data-role="gallery-status">加载中…</span>
  </div>
  <div class="empty card" data-role="gallery-empty" hidden>
    ${icon("image")}
    <strong>还没有归档图片</strong>
    <span data-role="gallery-empty-text">成功生成的输出图会自动出现在这里。</span>
  </div>
  <div class="gallery-grid" data-role="gallery-grid"></div>
  <div class="gallery-sentinel" data-role="gallery-sentinel">向下滚动加载更多</div>
</section>`;

export const GALLERY_DIALOGS = `
<dialog class="lightbox" data-role="gallery-dialog" aria-labelledby="gallery-dialog-title">
  <div class="lightbox-body">
    <div class="dialog-head">
      <h2 id="gallery-dialog-title">图片详情</h2>
      <button class="btn small lightbox-close" type="button" data-action="close-gallery-dialog" aria-label="关闭">${
  icon("close")
}<span>关闭</span></button>
    </div>
    <div class="lightbox-stage">
      <button class="lightbox-nav prev" type="button" data-action="gallery-prev" aria-label="上一张">${
  icon("chevronLeft")
}</button>
      <img data-role="gallery-dialog-image" alt="生成图片">
      <button class="lightbox-nav next" type="button" data-action="gallery-next" aria-label="下一张">${
  icon("chevronRight")
}</button>
    </div>
    <div class="lightbox-foot">
      <div class="lightbox-info">
        <div class="lightbox-prompt-wrap">
          <p class="lightbox-prompt is-clamped" data-role="gallery-dialog-prompt"></p>
          <button class="lightbox-prompt-toggle" type="button" data-action="toggle-prompt"
            aria-expanded="false" hidden>展开全部</button>
        </div>
        <p class="lightbox-meta" data-role="gallery-dialog-meta"></p>
        <p class="lightbox-meta" data-role="gallery-dialog-tag"></p>
        <p class="lightbox-meta" data-role="gallery-dialog-nsfw"></p>
      </div>
      <div class="lightbox-actions">
        <button class="btn small" type="button" data-action="gallery-copy">${
  icon("copy")
}复制提示词</button>
        <a class="btn small" data-role="gallery-download">${icon("download")}下载</a>
        <button class="btn small danger" type="button" data-action="gallery-delete">${
  icon("trash")
}删除</button>
      </div>
    </div>
  </div>
</dialog>`;

export const GALLERY_SCRIPT = String.raw`
(function () {
  "use strict";
  var A = window.Agnes;
  var section = document.querySelector('[data-section="gallery"]');
  if (!section) return;
  var enrichSummaryText = ${enrichSummaryText.toString()};
  var enrichButton = section.querySelector('[data-action="enrich-gallery"]');
  var enrichAvailable = false;
  var enrichPolling = false;
  var enrichTimer = null;
  var enrichWasRunning = false;

  var state = {
    items: [],
    visible: [],
    before: null,
    loading: false,
    exhausted: false,
    loaded: false,
    lastDay: null,
    query: "",
    tag: "",
    current: 0,
    generation: 0,
    imageToken: 0,
    imageUrls: {},
    objectUrls: [],
  };

  var TAG_LABELS = {
    safe: "普通",
    drawing: "绘画",
    sexy: "性感",
    porn: "色情",
    hentai: "动漫色情",
    "": "未分类",
  };

  function node(role) { return document.querySelector('[data-role="' + role + '"]'); }

  function pct(value) {
    return Math.round(Number(value) * 100) + "%";
  }

  function nsfwText(nsfw) {
    if (!nsfw) return "暂无 NSFW 数据";
    return "普通 " + pct(nsfw.safe) +
      " · 绘画 " + pct(nsfw.drawing) +
      " · 性感 " + pct(nsfw.sexy) +
      " · 色情 " + pct(nsfw.porn) +
      " · 动漫色情 " + pct(nsfw.hentai);
  }

  function tagOf(item) {
    return item.nsfwTag || "";
  }

  function tagLabel(item) {
    var tag = tagOf(item);
    return TAG_LABELS[tag] || tag || "未分类";
  }

  function promptToggleNode() {
    return document.querySelector('[data-action="toggle-prompt"]');
  }

  function setPrompt(text) {
    var prompt = node("gallery-dialog-prompt");
    var toggle = promptToggleNode();
    if (!prompt) return;
    prompt.textContent = text;
    prompt.classList.add("is-clamped");
    if (toggle) {
      toggle.hidden = true;
      toggle.textContent = "展开全部";
      toggle.setAttribute("aria-expanded", "false");
    }
    // Measure after layout: line-clamp keeps the full text in scrollHeight.
    requestAnimationFrame(function () {
      if (!toggle) return;
      toggle.hidden = prompt.scrollHeight <= prompt.clientHeight + 1;
    });
  }

  function metaParts(item) {
    return [item.model, item.size, item.accountName, A.fmtRelative(item.createdAt)]
      .filter(Boolean);
  }

  function cardMetaParts(item) {
    return [item.model, item.size, A.fmtRelative(item.createdAt)].filter(Boolean);
  }

  function metaText(item) {
    return metaParts(item).join(" · ");
  }

  function searchText(item) {
    return [item.prompt, item.model, item.accountName].filter(Boolean).join(" ").toLowerCase();
  }

  function filteredItems() {
    var query = state.query.trim().toLowerCase();
    if (!query) return state.items;
    return state.items.filter(function (item) {
      return searchText(item).indexOf(query) !== -1;
    });
  }

  function revokeImageUrls() {
    for (var i = 0; i < state.objectUrls.length; i++) {
      try { URL.revokeObjectURL(state.objectUrls[i]); } catch (error) { /* ignore */ }
    }
    state.objectUrls = [];
    state.imageUrls = {};
  }

  function showImageError(open, message) {
    open.replaceChildren();
    var placeholder = A.el("div", "gallery-placeholder");
    placeholder.append(A.icon("image"));
    placeholder.append(A.el("span", null, message));
    open.append(placeholder);
    open.disabled = true;
  }

  function fetchImageBlob(item, thumbnail) {
    var url = "/admin/api/gallery/" + item.id + "/" + (thumbnail ? "thumbnail" : "content");
    return fetch(url, { credentials: "same-origin" }).then(function (response) {
      if (thumbnail && response.status === 404) return null;
      if (!response.ok) {
        var error = new Error("图片加载失败（HTTP " + response.status + "）");
        error.status = response.status;
        throw error;
      }
      return response.blob();
    });
  }

  function loadCardImage(item, open, image) {
    var cached = state.imageUrls[item.id];
    if (cached === "error") {
      showImageError(open, "图片不可用");
      return;
    }
    if (cached) {
      image.src = cached;
      return;
    }
    fetchImageBlob(item, true).then(function (blob) {
      if (!blob) {
        // Only a definite 404 falls back to the authenticated original once.
        return fetchImageBlob(item, false).then(function (original) {
          if (!original) throw new Error("图片内容不存在");
          return original;
        });
      }
      return blob;
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      state.imageUrls[item.id] = url;
      state.objectUrls.push(url);
      image.src = url;
    }).catch(function () {
      state.imageUrls[item.id] = "error";
      showImageError(open, "图片不可用");
    });
  }

  function buildCard(item) {
    var card = A.el("article", "gallery-card");
    card.setAttribute("data-id", String(item.id));
    var media = A.el("div", "gallery-media");

    if (item.archived) {
      var open = A.el("button", "gallery-open");
      open.type = "button";
      open.setAttribute("data-action", "open-image");
      open.setAttribute("data-id", String(item.id));
      open.setAttribute("aria-label", "查看图片：" + (item.prompt || "生成图片"));
      var image = document.createElement("img");
      image.loading = "lazy";
      image.decoding = "async";
      image.alt = item.prompt || "生成图片";
      open.append(image);
      media.append(open);
      loadCardImage(item, open, image);

      var overlay = A.el("div", "gallery-overlay");
      var download = A.el("a", "icon-btn");
      download.href = "/admin/api/gallery/" + item.id + "/content?download=1";
      download.setAttribute("aria-label", "下载图片");
      download.title = "下载图片";
      download.append(A.icon("download"));
      var remove = A.el("button", "icon-btn danger");
      remove.type = "button";
      remove.setAttribute("data-action", "delete-image");
      remove.setAttribute("data-id", String(item.id));
      remove.setAttribute("aria-label", "删除图片");
      remove.title = "删除图片";
      remove.append(A.icon("trash"));
      overlay.append(download);
      overlay.append(remove);
      media.append(overlay);

      var tag = tagOf(item);
      media.append(A.el("span", "tag-badge tag-" + (tag || "none"), tagLabel(item)));
    } else {
      var placeholder = A.el("div", "gallery-placeholder");
      placeholder.append(A.icon("image"));
      placeholder.append(A.el("span", null, "未归档"));
      media.append(placeholder);
    }

    var body = A.el("div", "gallery-body");
    var prompt = A.el("p", "gallery-prompt", item.prompt || "(无提示词)");
    prompt.title = item.prompt || "";
    var meta = A.el("div", "gallery-meta");
    var parts = cardMetaParts(item);
    for (var p = 0; p < parts.length; p++) meta.append(A.el("span", null, parts[p]));
    body.append(prompt);
    body.append(meta);
    card.append(media);
    card.append(body);
    return card;
  }

  function render() {
    var grid = node("gallery-grid");
    var empty = node("gallery-empty");
    var emptyText = node("gallery-empty-text");
    var sentinel = node("gallery-sentinel");
    if (!grid) return;

    state.visible = filteredItems();
    var status = node("gallery-status");
    if (status) {
      status.textContent = state.visible.length + " 张" +
        (state.query ? " · 已加载 " + state.items.length + " 张" : "");
    }
    grid.replaceChildren();
    state.lastDay = null;

    var emptyMessage = state.items.length === 0
      ? (state.tag ? "该分类下还没有图片。" : "成功生成的输出图会自动出现在这里。")
      : "没有匹配的图片，试试其他关键词。";
    if (emptyText) emptyText.textContent = emptyMessage;
    if (empty) empty.hidden = state.visible.length > 0;
    grid.hidden = state.visible.length === 0;

    for (var i = 0; i < state.visible.length; i++) {
      var item = state.visible[i];
      var day = typeof item.createdAt === "string" && item.createdAt.length >= 10
        ? item.createdAt.slice(0, 10)
        : "未知日期";
      if (day !== state.lastDay) {
        state.lastDay = day;
        grid.append(A.el("h2", "timeline-day", day));
      }
      grid.append(buildCard(item));
    }

    if (sentinel) {
      sentinel.hidden = state.items.length === 0;
      if (!state.exhausted) sentinel.textContent = state.loading ? "加载中…" : "向下滚动加载更多";
    }
  }

  async function loadPage() {
    if (state.loading || state.exhausted) return;
    state.loading = true;
    var generation = state.generation;
    var sentinel = node("gallery-sentinel");
    if (sentinel) sentinel.classList.remove("is-error");
    render();
    if (state.items.length === 0) {
      var status = node("gallery-status");
      if (status) status.textContent = "加载中…";
    }
    var url = "/admin/api/gallery?limit=24" +
      (state.tag ? "&tag=" + encodeURIComponent(state.tag) : "") +
      (state.before === null ? "" : "&before=" + encodeURIComponent(state.before));
    try {
      var page = await A.api(url);
      if (generation !== state.generation) return;
      var items = (page && page.items) || [];
      for (var i = 0; i < items.length; i++) state.items.push(items[i]);
      state.before = page ? page.nextBefore : null;
      state.exhausted = state.before === null;
      state.loaded = true;
      state.loading = false;
      render();
      if (sentinel) sentinel.textContent = state.exhausted ? "没有更多图片了" : "向下滚动加载更多";
    } catch (error) {
      if (generation !== state.generation) return;
      state.loading = false;
      var statusNode = node("gallery-status");
      if (statusNode) statusNode.textContent = "加载失败";
      if (sentinel) {
        sentinel.classList.add("is-error");
        sentinel.textContent = "加载失败：" + error.message;
      }
    }
  }

  function reset() {
    state.generation += 1;
    revokeImageUrls();
    state.items = [];
    state.visible = [];
    state.before = null;
    state.loading = false;
    state.exhausted = false;
    state.loaded = false;
    state.lastDay = null;
    render();
    loadPage();
  }

  async function refreshNewest() {
    if (state.loading) return;
    if (!state.loaded) {
      await loadPage();
      return;
    }
    var dialog = node("gallery-dialog");
    if (dialog && dialog.open) return;
    try {
      var page = await A.api(
        "/admin/api/gallery?limit=24" + (state.tag ? "&tag=" + encodeURIComponent(state.tag) : ""),
      );
      var items = (page && page.items) || [];
      var known = {};
      for (var i = 0; i < state.items.length; i++) known[state.items[i].id] = true;
      var fresh = items.filter(function (item) { return !known[item.id]; });
      if (fresh.length === 0) return;
      var height = document.documentElement.scrollHeight;
      state.items = fresh.concat(state.items);
      render();
      var delta = document.documentElement.scrollHeight - height;
      if (delta > 0 && window.scrollY > 0) window.scrollBy(0, delta);
    } catch (error) {
      var status = node("gallery-status");
      if (status) status.textContent = "自动刷新失败";
    }
  }

  function setDialogImage(image, stage, item) {
    var token = ++state.imageToken;
    function settle() {
      if (token === state.imageToken && stage) stage.classList.remove("is-loading");
    }
    // Hide the previous frame until the new one is decoded, so opening or paging
    // never shows the image the user just left behind.
    if (stage) stage.classList.add("is-loading");
    image.onload = settle;
    image.onerror = function () {
      settle();
      var meta = node("gallery-dialog-meta");
      if (meta && token === state.imageToken) meta.textContent = "原图加载失败";
    };
    image.src = "/admin/api/gallery/" + item.id + "/content";
    image.alt = item.prompt || "生成图片";
  }

  function openAt(index) {
    var dialog = node("gallery-dialog");
    var image = node("gallery-dialog-image");
    var meta = node("gallery-dialog-meta");
    var tagInfo = node("gallery-dialog-tag");
    var nsfwInfo = node("gallery-dialog-nsfw");
    var download = node("gallery-download");
    var stage = dialog ? dialog.querySelector(".lightbox-stage") : null;
    var prev = dialog ? dialog.querySelector('[data-action="gallery-prev"]') : null;
    var next = dialog ? dialog.querySelector('[data-action="gallery-next"]') : null;
    if (!dialog || !image) return;
    if (index < 0 || index >= state.visible.length) return;

    state.current = index;
    var item = state.visible[index];
    setDialogImage(image, stage, item);
    setPrompt(item.prompt || "(无提示词)");
    if (meta) meta.textContent = metaText(item) + " · " + A.fmtTime(item.createdAt);
    if (tagInfo) tagInfo.textContent = "分类：" + tagLabel(item);
    if (nsfwInfo) nsfwInfo.textContent = nsfwText(item.nsfwScores);
    if (download) {
      download.href = "/admin/api/gallery/" + item.id + "/content?download=1";
    }
    if (prev) prev.disabled = index === 0;
    if (next) next.disabled = index === state.visible.length - 1;
    if (!dialog.open) dialog.showModal();
  }

  function findItem(id) {
    return state.items.filter(function (item) { return String(item.id) === String(id); })[0];
  }

  async function removeItem(item, fromDialog) {
    var ok = await A.confirm({
      title: "删除图片",
      message: "将永久删除这条归档记录与图片数据，此操作不可撤销。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await A.api("/admin/api/gallery/" + item.id, { method: "DELETE" });
      state.items = state.items.filter(function (entry) { return entry.id !== item.id; });
      render();
      if (fromDialog) {
        if (state.visible.length === 0) {
          var dialog = node("gallery-dialog");
          if (dialog) dialog.close();
        } else {
          openAt(Math.min(state.current, state.visible.length - 1));
        }
      }
      A.toast("图片已删除");
    } catch (error) {
      A.toast(error.message, "error");
    }
  }

  async function clearGallery() {
    var ok = await A.confirm({
      title: "清空图片",
      message: "将删除全部归档图片与本地原图，此操作不可撤销。",
      confirmLabel: "清空全部",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await A.api("/admin/api/gallery", { method: "DELETE" });
      var dialog = node("gallery-dialog");
      if (dialog && dialog.open) dialog.close();
      reset();
      A.toast("归档已清空");
    } catch (error) {
      A.toast("清空可能只完成了一部分，正在重新读取列表：" + error.message, "error");
      reset();
    }
  }

  function applyEnrichUi() {
    if (!enrichButton) return;
    var running = enrichButton.classList.contains("is-running");
    var unavailable = !enrichAvailable && !running;
    enrichButton.classList.toggle("is-unavailable", unavailable);
    enrichButton.disabled = running || !enrichAvailable;
    enrichButton.setAttribute("aria-busy", running ? "true" : "false");
    enrichButton.title = enrichAvailable ? "" : "请先在设置里填写 Edge-Images 基础地址";
    if (!enrichAvailable) {
      enrichButton.classList.remove("is-error");
    }
  }

  function applyEnrichStatus(status) {
    var value = status || {};
    var running = Boolean(value.running);
    if (enrichButton) {
      enrichButton.classList.toggle("is-running", running);
      enrichButton.classList.toggle("is-error", Boolean(value.error));
    }
    applyEnrichUi();
    var statusNode = node("enrich-status");
    if (statusNode && (running || enrichWasRunning || value.error || value.processed)) {
      statusNode.textContent = enrichSummaryText(value);
    }
    if (enrichWasRunning && !running) {
      enrichWasRunning = false;
      reset();
      var finished = node("enrich-status");
      if (finished) finished.textContent = enrichSummaryText(value) + " · 已刷新图库";
    } else if (running) {
      enrichWasRunning = true;
    }
  }

  function stopEnrichTracking() {
    if (enrichTimer !== null) {
      clearInterval(enrichTimer);
      enrichTimer = null;
    }
  }

  async function pollEnrich() {
    if (enrichPolling) return;
    enrichPolling = true;
    try {
      var status = await A.api("/admin/api/gallery/enrich");
      applyEnrichStatus(status);
      if (!status || !status.running) stopEnrichTracking();
    } catch (error) {
      stopEnrichTracking();
    }
    enrichPolling = false;
  }

  function ensureEnrichTracking() {
    if (enrichTimer !== null) return;
    enrichTimer = setInterval(pollEnrich, 2000);
  }

  function setEnrichAvailability(available) {
    enrichAvailable = Boolean(available);
    applyEnrichUi();
  }

  function imageServiceConfigured(settings) {
    return Boolean(
      settings && typeof settings.imageServiceBaseUrl === "string" &&
        settings.imageServiceBaseUrl.trim() !== "",
    );
  }

  async function enrichHistory() {
    if (!enrichButton || !enrichAvailable || enrichButton.classList.contains("is-running")) return;
    A.setBusy(enrichButton, true, "启动中…");
    try {
      var status = await A.api("/admin/api/gallery/enrich", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      applyEnrichStatus(status);
      ensureEnrichTracking();
      A.toast("已开始补齐历史图片", "info");
    } catch (error) {
      var code = error && error.body && error.body.error && error.body.error.code;
      if (code === "enrichment_running") {
        try {
          var current = await A.api("/admin/api/gallery/enrich");
          applyEnrichStatus(current);
          ensureEnrichTracking();
        } catch (readError) {
          A.toast(readError.message, "error");
        }
      } else if (code === "image_service_disabled") {
        A.toast("请先在设置里填写图片服务地址", "error");
      } else {
        A.toast(error.message, "error");
      }
    }
    A.setBusy(enrichButton, false);
    applyEnrichUi();
  }

  var search = section.querySelector('[data-role="gallery-search"]');
  if (search) {
    search.addEventListener("input", A.debounce(function () {
      state.query = search.value;
      render();
    }, 140));
  }

  section.addEventListener("click", function (event) {
    var open = event.target.closest('[data-action="open-image"]');
    if (open) {
      var item = findItem(open.getAttribute("data-id"));
      if (!item) return;
      var index = state.visible.indexOf(item);
      if (index !== -1) openAt(index);
      return;
    }
    var chip = event.target.closest('[data-action="filter-tag"]');
    if (chip) {
      state.tag = chip.getAttribute("data-tag") || "";
      var chips = section.querySelectorAll('[data-action="filter-tag"]');
      for (var c = 0; c < chips.length; c++) {
        chips[c].classList.toggle("is-active", chips[c] === chip);
      }
      reset();
      return;
    }
    var enrich = event.target.closest('[data-action="enrich-gallery"]');
    if (enrich) {
      enrichHistory();
      return;
    }
    var remove = event.target.closest('[data-action="delete-image"]');
    if (remove) {
      var target = findItem(remove.getAttribute("data-id"));
      if (target) removeItem(target, false);
      return;
    }
    var clear = event.target.closest('[data-action="clear-gallery"]');
    if (clear) {
      clearGallery();
      return;
    }
    var refresh = event.target.closest('[data-action="refresh-gallery"]');
    if (refresh) {
      reset();
      A.toast("已刷新图片时间线", "info");
    }
  });

  document.addEventListener("click", function (event) {
    var close = event.target.closest('[data-action="close-gallery-dialog"]');
    if (close) {
      var dialog = node("gallery-dialog");
      if (dialog) dialog.close();
      return;
    }
    var prev = event.target.closest('[data-action="gallery-prev"]');
    if (prev) {
      openAt(state.current - 1);
      return;
    }
    var next = event.target.closest('[data-action="gallery-next"]');
    if (next) {
      openAt(state.current + 1);
      return;
    }
    var promptToggle = event.target.closest('[data-action="toggle-prompt"]');
    if (promptToggle) {
      var promptEl = node("gallery-dialog-prompt");
      if (promptEl) {
        var clamped = promptEl.classList.toggle("is-clamped");
        promptToggle.textContent = clamped ? "展开全部" : "收起";
        promptToggle.setAttribute("aria-expanded", clamped ? "false" : "true");
      }
      return;
    }
    var copy = event.target.closest('[data-action="gallery-copy"]');
    if (copy) {
      var current = state.visible[state.current];
      if (!current) return;
      A.copyText(current.prompt || "").then(function (ok) {
        A.toast(ok ? "提示词已复制" : "复制失败，请手动选择文本", ok ? "ok" : "error");
      });
      return;
    }
    var remove = event.target.closest('[data-action="gallery-delete"]');
    if (remove) {
      var item = state.visible[state.current];
      if (item) removeItem(item, true);
    }
  });

  var dialog = node("gallery-dialog");
  if (dialog) {
    dialog.addEventListener("keydown", function (event) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        openAt(state.current - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        openAt(state.current + 1);
      }
    });
  }

  var sentinel = node("gallery-sentinel");
  if (sentinel && typeof IntersectionObserver === "function") {
    var observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) loadPage();
      }
    }, { rootMargin: "300px" });
    observer.observe(sentinel);
  }

  A.api("/admin/api/settings").then(function (settings) {
    setEnrichAvailability(imageServiceConfigured(settings));
  }).catch(function () { /* stay unavailable until settings arrive */ });

  document.addEventListener("agnes:settings", function (event) {
    setEnrichAvailability(imageServiceConfigured(event.detail));
  });

  // Resume the status of a backfill that was already running before reload.
  A.api("/admin/api/gallery/enrich").then(function (status) {
    applyEnrichStatus(status);
    if (status && status.running) ensureEnrichTracking();
  }).catch(function () { /* the button remains unavailable */ });

  A.autoRefresh.register("gallery", refreshNewest);
})();
`;
