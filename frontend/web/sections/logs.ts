import { icon } from "../icons.ts";
import { mergeById } from "../contracts.ts";

/** Logs section: live request table with filtering and a detail dialog. */
export const LOGS_HTML = `
<section class="panel" data-section="logs" data-title="日志">
  <div class="section-head">
    <div class="section-lead">
      <h2>请求日志</h2>
      <p>时间统一显示为 UTC+8；按类型读取最近日志，每次加载 50 条。刷新会合并新记录，不清除已加载的历史页。</p>
    </div>
    <div class="toolbar">
      <button class="btn" data-action="load-more-logs" type="button">${icon("download")}加载更多</button>
      <button class="btn" data-action="refresh-logs" type="button">${icon("refresh")}刷新</button>
      <button class="btn danger" data-action="clear-logs" type="button">${
  icon("trash")
}清空</button>
    </div>
  </div>
  <div class="filter-bar">
    <div class="search">
      ${icon("search")}
      <input class="input" data-role="logs-search" type="search" placeholder="搜索已加载日志的模型、API-KEY、账号或错误…" aria-label="搜索已加载日志">
    </div>
    <div class="toolbar" role="group" aria-label="按类型筛选">
      <button class="btn small" data-category="request" aria-pressed="true" type="button">常规请求</button>
      <button class="btn small" data-category="enrich" aria-pressed="false" type="button">图片请求</button>
    </div>
    <div class="toolbar" role="group" aria-label="按状态筛选">
      <button class="btn small" data-filter="all" aria-pressed="true" type="button">全部</button>
      <button class="btn small" data-filter="ok" aria-pressed="false" type="button">成功</button>
      <button class="btn small" data-filter="bad" aria-pressed="false" type="button">失败</button>
    </div>
    <span class="logs-status" data-role="logs-status" aria-live="polite">加载中…</span>
  </div>
  <div class="table-wrap is-stacked">
    <table class="table--stack" data-role="logs-table">
      <thead>
        <tr>
          <th scope="col">时间</th>
          <th scope="col">类型</th>
          <th scope="col">端点</th>
          <th scope="col">API-KEY</th>
          <th scope="col">模型</th>
          <th scope="col">状态</th>
          <th scope="col" class="num">图片</th>
          <th scope="col" class="num">耗时</th>
          <th scope="col">账号</th>
          <th scope="col">错误</th>
          <th scope="col"><span class="sr-only">操作</span></th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>
</section>`;

export const LOGS_DIALOGS = `
<dialog data-role="log-detail" aria-labelledby="log-detail-title">
  <div class="dialog-body">
    <div class="dialog-head">
      <h2 id="log-detail-title">请求详情</h2>
      <button class="icon-btn" type="button" data-action="close-log-detail" aria-label="关闭">${
  icon("close")
}</button>
    </div>
    <dl class="detail-grid" data-role="log-detail-grid"></dl>
    <div class="detail-block" data-role="log-attempts-block" hidden>
      <h3>尝试记录</h3>
      <pre class="detail-pre" data-role="log-attempts"></pre>
    </div>
    <div class="detail-block" data-role="log-delivery-block" hidden>
      <h3>交付失败</h3>
      <pre class="detail-pre" data-role="log-delivery"></pre>
    </div>
  </div>
</dialog>`;

export const LOGS_SCRIPT = String.raw`
(function () {
  "use strict";
  var A = window.Agnes;
  var section = document.querySelector('[data-section="logs"]');
  if (!section) return;
  var mergeById = ${mergeById.toString()};
  var PAGE_SIZE = 50;

  var state = {
    entries: [],
    nextBefore: null,
    loading: false,
    filter: "all",
    categories: { request: true, enrich: false },
    generation: 0,
    loadFailed: false,
    query: "",
    at: null,
    loaded: false,
  };

  function node(role) { return document.querySelector('[data-role="' + role + '"]'); }

  function logBody() { return section.querySelector('[data-role="logs-table"] tbody'); }
  function cell(label, value, className) {
    var td = A.el("td", className, value);
    td.setAttribute("data-label", label);
    return td;
  }

  function attemptsOf(entry) { return entry.attempts || []; }
  function lastAttempt(entry) {
    var attempts = attemptsOf(entry);
    return attempts.length ? attempts[attempts.length - 1] : null;
  }
  function deliveryFailures(entry) { return entry.deliveryFailures || []; }

  function accountName(entry) {
    var attempt = lastAttempt(entry);
    return attempt && attempt.accountName ? attempt.accountName : "—";
  }

  function errorText(entry) {
    var attempt = lastAttempt(entry);
    var failures = deliveryFailures(entry);
    if (failures.length > 0) {
      return "交付失败 " + failures.length + " 项";
    }
    if (attempt && !entry.ok) {
      return attempt.code
        ? attempt.code + (attempt.message ? "：" + attempt.message : "")
        : (attempt.message || "HTTP " + attempt.status);
    }
    return "—";
  }

  function visibleEntries() {
    var query = state.query.trim().toLowerCase();
    return state.entries.filter(function (entry) {
      if (state.filter === "ok" && !entry.ok) return false;
      if (state.filter === "bad" && entry.ok) return false;
      if (!query) return true;
      var parts = [entry.model, entry.endpoint, entry.path, entry.status, entry.requestId, entry.stage, entry.apiKeyName];
      var attempts = attemptsOf(entry);
      for (var i = 0; i < attempts.length; i++) {
        parts.push(attempts[i].accountName, attempts[i].code, attempts[i].message);
      }
      return parts.filter(Boolean).join(" ").toLowerCase().indexOf(query) !== -1;
    });
  }

  function categoryLabel(category) {
    return category === "enrich" ? "图片请求" : "常规请求";
  }

  function emptyRow(message) {
    var row = A.el("tr", "table-empty");
    var td = A.el("td");
    td.colSpan = 11;
    var empty = A.el("div", "empty");
    empty.append(A.icon("info"));
    empty.append(A.el("strong", null, message));
    td.append(empty);
    row.append(td);
    return row;
  }

  function render() {
    var body = logBody();
    if (!body) return;
    body.replaceChildren();
    var entries = visibleEntries();
    if (entries.length === 0) {
      var message = "没有匹配的请求。";
      if (!state.categories.request && !state.categories.enrich) message = "请选择要显示的请求类型。";
      else if (state.entries.length === 0) message = state.loading ? "正在加载请求记录…" :
        (state.loadFailed ? "日志加载失败，请刷新重试。" : "还没有请求记录。");
      body.append(emptyRow(message));
      updateStatus();
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var row = A.el("tr");
      row.append(cell("时间", A.fmtTime(entry.ts), "mono"));

      var category = A.el("td");
      category.setAttribute("data-label", "类型");
      category.append(
        A.badge(categoryLabel(entry.category), entry.category === "enrich" ? "info" : "muted"),
      );
      row.append(category);

      row.append(cell("端点", entry.endpoint, "mono"));
      row.append(cell("API-KEY", entry.apiKeyName || "—", "log-key-name"));
      row.append(cell("模型", entry.model, "mono"));

      var status = A.el("td");
      status.setAttribute("data-label", "状态");
      status.append(A.badge(entry.partial ? entry.status + " 部分" : String(entry.status),
        entry.ok ? (entry.partial ? "warn" : "ok") : "bad"));
      row.append(status);

      var images = entry.requested === null || entry.requested === undefined
        ? String(entry.images)
        : entry.images + "/" + entry.requested;
      if (entry.failed > 0) images += "（失败 " + entry.failed + "）";
      row.append(cell("图片", images, "num"));
      row.append(cell("耗时", A.fmtDuration(entry.durationMs), "num mono"));
      row.append(cell("账号", accountName(entry)));

      var text = errorText(entry);
      var errorCell = cell("错误", text, text === "—" ? "muted" : "row-error");
      if (text !== "—") errorCell.title = text;
      row.append(errorCell);

      var actions = A.el("td", "row-actions");
      actions.setAttribute("data-label", "操作");
      if (entry.hasGalleryImages) {
        var link = A.el("a", "icon-btn");
        link.href = "#gallery?requestId=" + encodeURIComponent(entry.requestId);
        link.setAttribute("data-action", "log-gallery");
        link.setAttribute("aria-label", "查看请求图片");
        link.title = "查看请求图片";
        link.append(A.icon("image"));
        actions.append(link);
        row.classList.add("log-gallery-row");
      }
      var detail = A.el("button", "icon-btn");
      detail.type = "button";
      detail.setAttribute("data-action", "log-detail");
      detail.setAttribute("data-id", String(entry.id));
      detail.setAttribute("aria-label", "查看请求详情");
      detail.title = "查看详情";
      detail.append(A.icon("info"));
      actions.append(detail);
      row.append(actions);

      body.append(row);
    }
    updateStatus();
  }

  function updateStatus() {
    var status = node("logs-status");
    if (!status) return;
    var text = state.loadFailed ? "加载失败" : state.loading ? "加载中…" :
      (state.at ? "更新于 " + A.fmtShortTime(state.at) : "");
    text += (text ? " · " : "") + "已加载 " + state.entries.length + " 条";
    if (state.nextBefore !== null) text += " · 可加载更多";
    status.textContent = text;
    var more = section.querySelector('[data-action="load-more-logs"]');
    if (more) more.disabled = state.nextBefore === null || state.loading;
  }

  async function loadPage(options) {
    if (state.loading) return;
    var requestOn = state.categories.request;
    var enrichOn = state.categories.enrich;
    if (!requestOn && !enrichOn) return;
    state.loading = true;
    state.loadFailed = false;
    var generation = state.generation;
    updateStatus();
    var reset = Boolean(options && options.reset);
    var before = reset ? null : state.nextBefore;
    var url = "/admin/api/logs?limit=" + PAGE_SIZE +
      (requestOn && enrichOn ? "" : "&category=" + (requestOn ? "request" : "enrich")) +
      (before === null ? "" : "&before=" + encodeURIComponent(before));
    try {
      var page = await A.api(url);
      if (generation !== state.generation) return;
      var items = (page && page.items) || [];
      if (reset || !state.loaded) {
        state.entries = mergeById(state.entries, items);
        if (!state.loaded || state.nextBefore === null) {
          state.nextBefore = page ? page.nextBefore : null;
        }
        state.loaded = true;
      } else {
        var known = {};
        for (var i = 0; i < state.entries.length; i++) known[String(state.entries[i].id)] = true;
        for (var j = 0; j < items.length; j++) {
          if (!known[String(items[j].id)]) state.entries.push(items[j]);
        }
        state.nextBefore = page ? page.nextBefore : null;
      }
      state.at = new Date().toISOString();
    } catch (error) {
      if (generation !== state.generation) return;
      state.loadFailed = true;
      if (!options || !options.silent) A.toast(error.message, "error");
    } finally {
      if (generation === state.generation) {
        state.loading = false;
        render();
      }
    }
  }

  async function load(silent) {
    return loadPage({ reset: true, silent: silent });
  }

  function setFilter(filter) {
    state.filter = filter;
    var buttons = section.querySelectorAll("[data-filter]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", buttons[i].getAttribute("data-filter") === filter ? "true" : "false");
    }
    render();
  }

  function resetPages() {
    state.generation++;
    state.loading = false;
    state.loadFailed = false;
    state.entries = [];
    state.nextBefore = null;
    state.loaded = false;
    state.at = null;
  }

  function toggleCategory(button) {
    var category = button.getAttribute("data-category");
    state.categories[category] = !state.categories[category];
    button.setAttribute("aria-pressed", String(state.categories[category]));
    resetPages();
    load(false);
    render();
  }

  function openDetail(entry) {
    var grid = node("log-detail-grid");
    if (!grid) return;
    grid.replaceChildren();
    var sizeText = [entry.sizeRequest, entry.sizeActual].filter(Boolean).join(" → ") || "—";
    var attempt = lastAttempt(entry);
    var rows = [
      ["请求 ID", entry.requestId || "—"],
      ["时间", A.fmtTime(entry.ts)],
      ["类型", categoryLabel(entry.category)],
      ["阶段", entry.stage || "—"],
      ["端点", entry.endpoint],
      ["路径", entry.path || "—"],
      ...(entry.category === "request" ? [["API-KEY", entry.apiKeyName || "—"]] : []),
      ["模型", entry.model || "—"],
      ["状态", String(entry.status) + (entry.partial ? "（部分成功）" : "")],
      ["耗时", A.fmtDuration(entry.durationMs)],
      ["账号", accountName(entry)],
      ["最近错误", attempt && !entry.ok ? (attempt.code || "HTTP " + attempt.status) : "—"],
      ["尺寸", sizeText],
      ["图片", entry.requested === null || entry.requested === undefined
        ? String(entry.images)
        : entry.images + " / " + entry.requested],
      ["失败", String(entry.failed)],
    ];
    for (var i = 0; i < rows.length; i++) {
      grid.append(A.el("dt", null, rows[i][0]));
      grid.append(A.el("dd", null, rows[i][1]));
    }
    var attemptsBlock = node("log-attempts-block");
    var attemptsPre = node("log-attempts");
    if (attemptsBlock && attemptsPre) {
      var attempts = attemptsOf(entry);
      attemptsBlock.hidden = attempts.length === 0;
      if (attempts.length > 0) attemptsPre.textContent = JSON.stringify(attempts, null, 2);
    }
    var deliveryBlock = node("log-delivery-block");
    var deliveryPre = node("log-delivery");
    if (deliveryBlock && deliveryPre) {
      var failures = deliveryFailures(entry);
      deliveryBlock.hidden = failures.length === 0;
      if (failures.length > 0) {
        deliveryPre.textContent = failures.map(function (failure) {
          return "子请求 " + failure.subrequestIndex + " · 图片 " + failure.imageIndex +
            " · " + failure.stage + " · HTTP " + failure.status + " · " + failure.code;
        }).join("\n");
      }
    }
    var dialog = node("log-detail");
    if (dialog) dialog.showModal();
  }

  var search = section.querySelector('[data-role="logs-search"]');
  if (search) {
    search.addEventListener("input", A.debounce(function () {
      state.query = search.value;
      render();
    }, 140));
  }

  section.addEventListener("click", async function (event) {
    var category = event.target.closest("[data-category]");
    if (category) {
      toggleCategory(category);
      return;
    }
    var filter = event.target.closest("[data-filter]");
    if (filter) {
      setFilter(filter.getAttribute("data-filter"));
      return;
    }
    var detail = event.target.closest('[data-action="log-detail"]');
    if (detail) {
      var entry = state.entries.filter(function (item) {
        return String(item.id) === detail.getAttribute("data-id");
      })[0];
      if (entry) openDetail(entry);
      return;
    }
    var row = event.target.closest(".log-gallery-row");
    if (row && event.button === 0 && !event.target.closest("a, button") && !String(window.getSelection() || "")) {
      row.querySelector('[data-action="log-gallery"]').click();
      return;
    }
    var more = event.target.closest('[data-action="load-more-logs"]');
    if (more) {
      A.setBusy(more, true, "加载中…");
      await loadPage({});
      A.setBusy(more, false);
      updateStatus();
      return;
    }
    var refresh = event.target.closest('[data-action="refresh-logs"]');
    if (refresh) {
      A.setBusy(refresh, true, "刷新中…");
      await load(false);
      A.setBusy(refresh, false);
      return;
    }
    var clear = event.target.closest('[data-action="clear-logs"]');
    if (clear) {
      var ok = await A.confirm({
        title: "清空日志",
        message: "将删除全部请求日志，此操作不可撤销。总览用量统计不会被重置。",
        confirmLabel: "清空",
        tone: "danger",
      });
      if (!ok) return;
      try {
        await A.api("/admin/api/logs", { method: "DELETE" });
        resetPages();
        state.at = new Date().toISOString();
        render();
        A.toast("日志已清空");
      } catch (error) { A.toast(error.message, "error"); }
    }
  });

  document.addEventListener("click", function (event) {
    if (event.target.closest('[data-action="close-log-detail"]')) {
      var dialog = node("log-detail");
      if (dialog) dialog.close();
    }
  });

  A.autoRefresh.register("logs", load);
})();
`;
