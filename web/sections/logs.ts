import { icon } from "../icons.ts";

/** Logs section: live request table with filtering and a detail dialog. */
export const LOGS_HTML = `
<section class="panel" data-section="logs" data-title="日志">
  <div class="section-head">
    <div class="section-lead">
      <h2>请求日志</h2>
      <p>最新 200 条请求；刷新间隔与开关由顶栏「自动刷新」和「设置」统一控制。</p>
    </div>
    <div class="toolbar">
      <button class="btn" data-action="refresh-logs" type="button">${icon("refresh")}刷新</button>
      <button class="btn danger" data-action="clear-logs" type="button">${
  icon("trash")
}清空</button>
    </div>
  </div>
  <div class="filter-bar">
    <div class="search">
      ${icon("search")}
      <input class="input" data-role="logs-search" type="search" placeholder="搜索模型、账号或错误…" aria-label="搜索日志">
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
          <th scope="col">端点</th>
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
    <div class="detail-block" data-role="log-error-block" hidden>
      <h3>错误</h3>
      <pre class="detail-pre" data-role="log-error"></pre>
    </div>
    <div class="detail-block" data-role="log-attempts-block" hidden>
      <h3>尝试记录</h3>
      <pre class="detail-pre" data-role="log-attempts"></pre>
    </div>
  </div>
</dialog>`;

export const LOGS_SCRIPT = String.raw`
(function () {
  "use strict";
  var A = window.Agnes;
  var section = document.querySelector('[data-section="logs"]');
  if (!section) return;

  var state = { entries: [], filter: "all", query: "", at: null };

  function node(role) { return document.querySelector('[data-role="' + role + '"]'); }

  function logBody() { return section.querySelector('[data-role="logs-table"] tbody'); }
  function cell(label, value, className) {
    var td = A.el("td", className, value);
    td.setAttribute("data-label", label);
    return td;
  }

  function visibleEntries() {
    var query = state.query.trim().toLowerCase();
    return state.entries.filter(function (entry) {
      if (state.filter === "ok" && !entry.ok) return false;
      if (state.filter === "bad" && entry.ok) return false;
      if (!query) return true;
      var haystack = [entry.model, entry.endpoint, entry.accountName, entry.error, entry.path, entry.status]
        .filter(Boolean).join(" ").toLowerCase();
      return haystack.indexOf(query) !== -1;
    });
  }

  function emptyRow(message) {
    var row = A.el("tr", "table-empty");
    var td = A.el("td");
    td.colSpan = 9;
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
      body.append(emptyRow(state.entries.length === 0 ? "还没有请求记录。" : "没有匹配的请求。"));
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var row = A.el("tr");
      row.append(cell("时间", A.fmtTime(entry.ts), "mono"));
      row.append(cell("端点", entry.endpoint, "mono"));
      row.append(cell("模型", entry.model, "mono"));

      var status = A.el("td");
      status.setAttribute("data-label", "状态");
      status.append(A.badge(String(entry.status), entry.ok ? "ok" : "bad"));
      row.append(status);

      var images = entry.images + "/" + entry.requested;
      if (entry.failed > 0) images += "（失败 " + entry.failed + "）";
      row.append(cell("图片", images, "num"));
      row.append(cell("耗时", A.fmtDuration(entry.durationMs), "num mono"));
      row.append(cell("账号", entry.accountName || "—"));

      var errorText = entry.error || (entry.failed ? entry.failed + " 张失败" : "—");
      var errorCell = cell("错误", errorText, entry.error ? "row-error" : "muted");
      if (entry.error) errorCell.title = entry.error;
      row.append(errorCell);

      var actions = A.el("td", "row-actions");
      actions.setAttribute("data-label", "操作");
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
  }

  function updateStatus() {
    var status = node("logs-status");
    if (!status) return;
    status.textContent = state.at
      ? "更新于 " + A.fmtShortTime(state.at)
      : "加载中…";
  }

  var requestId = 0;
  async function load(silent) {
    var id = ++requestId;
    try {
      var entries = await A.api("/admin/api/logs");
      if (id !== requestId) return;
      state.entries = entries || [];
      state.at = new Date().toISOString();
      render();
      updateStatus();
    } catch (error) {
      if (id !== requestId) return;
      var status = node("logs-status");
      if (status) status.textContent = "刷新失败";
      if (!silent) A.toast(error.message, "error");
    }
  }

  function setFilter(filter) {
    state.filter = filter;
    var buttons = section.querySelectorAll("[data-filter]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", buttons[i].getAttribute("data-filter") === filter ? "true" : "false");
    }
    render();
  }

  function openDetail(entry) {
    var grid = node("log-detail-grid");
    if (!grid) return;
    grid.replaceChildren();
    var rows = [
      ["时间", A.fmtTime(entry.ts)],
      ["端点", entry.endpoint],
      ["路径", entry.path || "—"],
      ["模型", entry.model],
      ["状态", String(entry.status)],
      ["耗时", A.fmtDuration(entry.durationMs)],
      ["账号", entry.accountName || "—"],
      ["尺寸", entry.size || "—"],
      ["图片", entry.images + " / " + entry.requested],
      ["失败", String(entry.failed)],
    ];
    for (var i = 0; i < rows.length; i++) {
      grid.append(A.el("dt", null, rows[i][0]));
      grid.append(A.el("dd", null, rows[i][1]));
    }
    var errorBlock = node("log-error-block");
    var errorPre = node("log-error");
    if (errorBlock && errorPre) {
      errorBlock.hidden = !entry.error;
      errorPre.textContent = entry.error || "";
    }
    var attemptsBlock = node("log-attempts-block");
    var attemptsPre = node("log-attempts");
    if (attemptsBlock && attemptsPre) {
      var attempts = entry.attempts;
      attemptsBlock.hidden = attempts === null || attempts === undefined;
      if (attempts !== null && attempts !== undefined) {
        attemptsPre.textContent = typeof attempts === "string"
          ? attempts
          : JSON.stringify(attempts, null, 2);
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
        message: "将删除全部请求日志，此操作不可撤销。",
        confirmLabel: "清空",
        tone: "danger",
      });
      if (!ok) return;
      try {
        await A.api("/admin/api/logs", { method: "DELETE" });
        state.entries = [];
        state.at = new Date().toISOString();
        render();
        updateStatus();
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
