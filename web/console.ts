import { icon } from "./icons.ts";
import { GALLERY_SCRIPT, renderGallerySection } from "./gallery.ts";

const NAV = [
  { id: "overview", label: "总览" },
  { id: "gallery", label: "图片" },
  { id: "accounts", label: "账号" },
  { id: "logs", label: "日志" },
  { id: "settings", label: "设置" },
];

function navLinks(attribute: string): string {
  return NAV.map((item) =>
    `<a class="nav-item" ${attribute}="${item.id}" href="#${item.id}">${
      icon(item.id)
    }<span>${item.label}</span></a>`
  ).join("");
}

const ACCOUNT_ACTIONS_TEMPLATE = `
<template data-role="account-actions">
  <button class="btn small" data-action="test-account" type="button">测试</button>
  <button class="btn small" data-action="reset-account" type="button">恢复</button>
  <button class="btn small" data-action="toggle-account" type="button">停用</button>
  <button class="btn small danger" data-action="delete-account" type="button">删除</button>
</template>`;

const OVERVIEW_PANEL = `
<section class="panel is-active" data-section="overview">
  <div class="panel-head">
    <div>
      <h1>总览</h1>
      <p>按模型查看当日请求与图片用量。</p>
    </div>
    <div class="toolbar">
      <label class="muted" for="overview-day">日期</label>
      <input id="overview-day" data-role="overview-day" type="date" />
    </div>
  </div>
  <div class="grid-stats">
    <div class="stat"><div class="stat-label">请求</div><div class="stat-value" data-role="stat-requests">0</div></div>
    <div class="stat"><div class="stat-label">错误</div><div class="stat-value" data-role="stat-errors">0</div></div>
    <div class="stat"><div class="stat-label">图片</div><div class="stat-value" data-role="stat-images">0</div></div>
    <div class="stat"><div class="stat-label">健康 Key</div><div class="stat-value" data-role="stat-accounts">0</div></div>
  </div>
  <div class="table-wrap">
    <table data-role="overview-models">
      <thead><tr><th>模型</th><th>请求</th><th>错误</th><th>图片</th><th>最后使用</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</section>`;

const ACCOUNTS_PANEL = `
<section class="panel" data-section="accounts">
  <div class="panel-head">
    <div>
      <h1>账号</h1>
      <p>池中的每个 Key 应属于独立的 Agnes 账号；同账号多加 Key 不会叠加限流额度。</p>
    </div>
    <div class="toolbar">
      <button class="btn primary" data-action="add-account" type="button">${
  icon("plus")
}添加账号</button>
      <button class="btn" data-action="import-accounts" type="button">${
  icon("upload")
}批量导入</button>
      <button class="btn" data-action="test-all" type="button">${icon("bolt")}全部测试</button>
    </div>
  </div>
  <div class="table-wrap">
    <table data-role="accounts-table">
      <thead>
        <tr><th>名称</th><th>Key</th><th>状态</th><th>用量</th><th>最后使用</th><th>操作</th></tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>
</section>`;

const LOGS_PANEL = `
<section class="panel" data-section="logs">
  <div class="panel-head">
    <div>
      <h1>日志</h1>
      <p>最新 200 条请求；每 5 秒刷新，选中文字时暂停。部分失败显示成功数与失败状态码。</p>
    </div>
    <div class="toolbar">
      <button class="btn" data-action="refresh-logs" type="button">${icon("refresh")}刷新</button>
      <button class="btn danger" data-action="clear-logs" type="button">${
  icon("trash")
}清空</button>
    </div>
  </div>
  <div class="table-wrap">
    <table data-role="logs-table">
      <thead>
        <tr><th>时间</th><th>端点</th><th>模型</th><th>状态</th><th>成功/请求</th><th>耗时</th><th>账号</th><th>错误</th></tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>
</section>`;

const SETTINGS_PANEL = `
<section class="panel" data-section="settings">
  <div class="panel-head">
    <div>
      <h1>设置</h1>
      <p>改动立即生效，设置读取有 10 秒缓存。</p>
    </div>
  </div>
  <form class="card" data-role="settings-form">
    <div class="form-grid">
      <div class="field">
        <label for="agnesBaseUrl">Agnes 基础地址</label>
        <input id="agnesBaseUrl" name="agnesBaseUrl" required />
        <span class="hint">默认 apihub.agnes-ai.com/v1</span>
      </div>
      <div class="field">
        <label for="defaultResponseFormat">默认响应格式</label>
        <select id="defaultResponseFormat" name="defaultResponseFormat">
          <option value="b64_json">b64_json</option>
          <option value="url">url</option>
        </select>
      </div>
      <div class="field">
        <label for="defaultSize">默认档位</label>
        <select id="defaultSize" name="defaultSize">
          <option value="1K">1K</option><option value="2K">2K</option>
          <option value="3K">3K</option><option value="4K">4K</option>
        </select>
      </div>
      <div class="field">
        <label for="defaultRatio">默认比例</label>
        <select id="defaultRatio" name="defaultRatio">
          <option value="1:1">1:1</option><option value="3:4">3:4</option>
          <option value="4:3">4:3</option><option value="16:9">16:9</option>
          <option value="9:16">9:16</option><option value="2:3">2:3</option>
          <option value="3:2">3:2</option><option value="21:9">21:9</option>
        </select>
      </div>
      <div class="field">
        <label for="imageParamMode">图片参数位置</label>
        <select id="imageParamMode" name="imageParamMode">
          <option value="auto">auto</option><option value="nested">nested</option>
          <option value="top_level">top_level</option>
        </select>
      </div>
      <div class="field">
        <label for="probeModel">测试模型</label>
        <input id="probeModel" name="probeModel" required />
      </div>
      <div class="field">
        <label for="probeConcurrency">测试并发</label>
        <input id="probeConcurrency" name="probeConcurrency" type="number" min="1" max="10" required />
      </div>
      <div class="field">
        <label for="requestTimeoutMs">请求超时（毫秒）</label>
        <input id="requestTimeoutMs" name="requestTimeoutMs" type="number" min="60000" max="360000" required />
      </div>
      <div class="field">
        <label for="maxAttempts">最大尝试次数</label>
        <input id="maxAttempts" name="maxAttempts" type="number" min="1" max="10" required />
      </div>
    </div>
    <div class="actions">
      <button class="btn" type="reset">重置</button>
      <button class="btn primary" type="submit">保存设置</button>
    </div>
  </form>
</section>`;

const DIALOGS = `
<dialog data-role="account-dialog">
  <div class="dialog-body">
    <div class="dialog-head">
      <h1>添加账号</h1>
      <button class="btn ghost" type="button" data-action="close-dialog">${icon("close")}</button>
    </div>
    <form data-form="account">
      <div class="field"><label for="account-name">名称</label><input id="account-name" name="name" required /></div>
      <div class="field">
        <label for="account-key">API Key</label>
        <input id="account-key" name="apiKey" autocomplete="off" required />
        <span class="hint">Agnes 控制台创建的 Key，保存后只显示掩码。</span>
      </div>
      <div class="actions">
        <button class="btn" type="button" data-action="close-dialog">取消</button>
        <button class="btn primary" type="submit">保存</button>
      </div>
    </form>
  </div>
</dialog>
<dialog data-role="import-dialog">
  <div class="dialog-body">
    <div class="dialog-head">
      <h1>批量导入</h1>
      <button class="btn ghost" type="button" data-action="close-dialog">${icon("close")}</button>
    </div>
    <form data-form="import">
      <div class="field">
        <label for="import-text">每行一个 account：名称,Key</label>
        <textarea id="import-text" name="text" placeholder="main,agk_xxx&#10;backup,agk_yyy"></textarea>
      </div>
      <div class="actions">
        <button class="btn" type="button" data-action="close-dialog">取消</button>
        <button class="btn primary" type="submit">导入</button>
      </div>
    </form>
  </div>
</dialog>
<div class="toast" data-role="toast"></div>`;

const CONSOLE_SCRIPT = String.raw`
(function () {
  "use strict";
  var state = { accounts: [], logsPaused: false };
  var toastTimer = null;

  async function api(path, options) {
    var init = Object.assign({ credentials: "same-origin" }, options || {});
    var response = await fetch(path, init);
    if (response.status === 204) return null;
    var body = null;
    try { body = await response.json(); } catch (error) { body = null; }
    if (!response.ok) {
      var message = body && body.error && body.error.message ? body.error.message : ("HTTP " + response.status);
      throw new Error(message);
    }
    return body;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function cell(label, value, className) {
    var td = el("td", className, value);
    td.setAttribute("data-label", label);
    return td;
  }

  function badge(text, tone) {
    return el("span", "badge " + tone, text);
  }

  function toast(message, bad) {
    var node = document.querySelector('[data-role="toast"]');
    if (!node) return;
    node.textContent = message;
    node.classList.add("show");
    node.style.background = bad ? "#7f1d1d" : "#0f1d18";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove("show"); }, 3200);
  }

  function fmtTime(value) {
    if (!value) return "—";
    try { return new Date(value).toLocaleString(); } catch (error) { return value; }
  }

  function setSection(name) {
    var known = false;
    var sections = document.querySelectorAll("[data-section]");
    for (var i = 0; i < sections.length; i++) {
      var id = sections[i].getAttribute("data-section");
      if (id === name) known = true;
      sections[i].classList.toggle("is-active", id === name);
    }
    var links = document.querySelectorAll("[data-nav], [data-bottom-nav]");
    for (var j = 0; j < links.length; j++) {
      var attr = links[j].getAttribute("data-nav") || links[j].getAttribute("data-bottom-nav");
      links[j].classList.toggle("is-active", attr === name);
    }
    return known;
  }

  function navigate(name) {
    if (location.hash !== "#" + name) location.hash = name;
    setSection(name);
  }

  async function loadOverview() {
    var dayInput = document.querySelector('[data-role="overview-day"]');
    var day = dayInput && dayInput.value ? dayInput.value : "";
    try {
      var data = await api("/admin/api/overview" + (day ? "?day=" + encodeURIComponent(day) : ""));
      document.querySelector('[data-role="stat-requests"]').textContent = data.totals.requests;
      document.querySelector('[data-role="stat-errors"]').textContent = data.totals.errors;
      document.querySelector('[data-role="stat-images"]').textContent = data.totals.images;
      document.querySelector('[data-role="stat-accounts"]').textContent = data.accounts.healthy + "/" + data.accounts.total;
      var tbody = document.querySelector('[data-role="overview-models"] tbody');
      tbody.replaceChildren();
      for (var i = 0; i < data.models.length; i++) {
        var model = data.models[i];
        var row = el("tr");
        row.append(cell("模型", model.id, "mono"));
        row.append(cell("请求", model.requests));
        row.append(cell("错误", model.errors));
        row.append(cell("图片", model.images));
        row.append(cell("最后使用", fmtTime(model.lastUsedAt)));
        tbody.append(row);
      }
    } catch (error) { toast(error.message, true); }
  }

  function actionButtons(account) {
    var template = document.querySelector('template[data-role="account-actions"]');
    var fragment = template.content.cloneNode(true);
    var buttons = fragment.querySelectorAll("button[data-action]");
    for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute("data-id", String(account.id));
    var toggle = fragment.querySelector('[data-action="toggle-account"]');
    if (toggle) toggle.textContent = account.enabled ? "停用" : "启用";
    return fragment;
  }

  function accountRow(account) {
    var row = el("tr");
    row.append(cell("名称", account.name));
    row.append(cell("Key", account.apiKeyMasked, "mono"));
    var status = el("td");
    status.setAttribute("data-label", "状态");
    var tone = !account.enabled ? "muted" : (account.status === "healthy" ? "ok" : "bad");
    status.append(badge(account.enabled ? account.status : "disabled", tone));
    row.append(status);
    row.append(cell("用量", account.requestCount + " 次 / " + account.imageCount + " 张"));
    row.append(cell("最后使用", fmtTime(account.lastUsedAt)));
    var actions = el("td");
    actions.setAttribute("data-label", "操作");
    actions.append(actionButtons(account));
    row.append(actions);
    return row;
  }

  async function loadAccounts() {
    try {
      state.accounts = await api("/admin/api/accounts");
      var tbody = document.querySelector('[data-role="accounts-table"] tbody');
      tbody.replaceChildren();
      if (state.accounts.length === 0) {
        var emptyRow = el("tr");
        var emptyCell = el("td", "empty", "还没有账号，先添加一个 Agnes Key。");
        emptyCell.colSpan = 6;
        emptyRow.append(emptyCell);
        tbody.append(emptyRow);
        return;
      }
      for (var i = 0; i < state.accounts.length; i++) tbody.append(accountRow(state.accounts[i]));
    } catch (error) { toast(error.message, true); }
  }

  function logRow(entry) {
    var row = el("tr");
    row.append(cell("时间", fmtTime(entry.ts)));
    row.append(cell("端点", entry.endpoint, "mono"));
    row.append(cell("模型", entry.model, "mono"));
    var statusCell = el("td");
    statusCell.setAttribute("data-label", "状态");
    statusCell.append(badge(String(entry.status), entry.ok ? "ok" : "bad"));
    row.append(statusCell);
    row.append(cell("成功/请求", entry.images + "/" + entry.requested));
    row.append(cell("耗时", entry.durationMs + " ms"));
    row.append(cell("账号", entry.accountName || "—"));
    row.append(cell("错误", entry.error || (entry.failed ? entry.failed + " 张失败" : "—"), "muted"));
    return row;
  }

  async function loadLogs() {
    try {
      var entries = await api("/admin/api/logs");
      var tbody = document.querySelector('[data-role="logs-table"] tbody');
      tbody.replaceChildren();
      for (var i = 0; i < entries.length; i++) tbody.append(logRow(entries[i]));
    } catch (error) { toast(error.message, true); }
  }

  async function loadSettings() {
    try {
      var settings = await api("/admin/api/settings");
      var form = document.querySelector('[data-role="settings-form"]');
      for (var key in settings) {
        var field = form.elements.namedItem(key);
        if (field) field.value = settings[key];
      }
    } catch (error) { toast(error.message, true); }
  }

  async function saveSettings(form) {
    var payload = {};
    var names = ["agnesBaseUrl", "defaultResponseFormat", "defaultSize", "defaultRatio", "imageParamMode", "probeModel"];
    for (var i = 0; i < names.length; i++) payload[names[i]] = form.elements.namedItem(names[i]).value;
    payload.probeConcurrency = Number(form.elements.namedItem("probeConcurrency").value);
    payload.requestTimeoutMs = Number(form.elements.namedItem("requestTimeoutMs").value);
    payload.maxAttempts = Number(form.elements.namedItem("maxAttempts").value);
    try {
      await api("/admin/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      toast("设置已保存");
      await loadSettings();
    } catch (error) { toast(error.message, true); }
  }

  document.addEventListener("click", async function (event) {
    var target = event.target.closest("[data-action]");
    if (!target) return;
    var action = target.getAttribute("data-action");
    var id = target.getAttribute("data-id");
    try {
      if (action === "add-account") {
        document.querySelector('[data-role="account-dialog"]').showModal();
      } else if (action === "import-accounts") {
        document.querySelector('[data-role="import-dialog"]').showModal();
      } else if (action === "close-dialog") {
        var dialog = target.closest("dialog");
        if (dialog) dialog.close();
      } else if (action === "logout") {
        await api("/admin/api/session", { method: "DELETE" });
        location.replace("/admin");
      } else if (action === "test-all") {
        target.disabled = true;
        var all = await api("/admin/api/accounts/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        var okCount = all.results.filter(function (item) { return item.ok; }).length;
        toast("测试完成：" + okCount + "/" + all.results.length + " 通过", okCount !== all.results.length);
        await loadAccounts();
      } else if (action === "test-account") {
        target.disabled = true;
        var result = await api("/admin/api/accounts/" + id + "/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        toast(result.ok ? "账号可用" : ("账号不可用：" + result.error), !result.ok);
        await loadAccounts();
      } else if (action === "reset-account") {
        await api("/admin/api/accounts/" + id + "/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        toast("已恢复冷却");
        await loadAccounts();
      } else if (action === "toggle-account") {
        var account = state.accounts.filter(function (item) { return String(item.id) === id; })[0];
        await api("/admin/api/accounts/" + id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !account.enabled }) });
        await loadAccounts();
      } else if (action === "delete-account") {
        if (!confirm("确定删除这个账号？")) return;
        await api("/admin/api/accounts/" + id, { method: "DELETE" });
        await loadAccounts();
      } else if (action === "refresh-logs") {
        await loadLogs();
      } else if (action === "clear-logs") {
        if (!confirm("确定清空全部日志？")) return;
        await api("/admin/api/logs", { method: "DELETE" });
        await loadLogs();
      }
    } catch (error) {
      toast(error.message, true);
      target.disabled = false;
    }
  });

  document.addEventListener("submit", async function (event) {
    var form = event.target;
    if (form.matches('[data-form="account"]')) {
      event.preventDefault();
      try {
        await api("/admin/api/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: form.elements.namedItem("name").value, apiKey: form.elements.namedItem("apiKey").value }) });
        form.reset();
        document.querySelector('[data-role="account-dialog"]').close();
        toast("账号已添加");
        await loadAccounts();
      } catch (error) { toast(error.message, true); }
    } else if (form.matches('[data-form="import"]')) {
      event.preventDefault();
      try {
        var imported = await api("/admin/api/accounts/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: form.elements.namedItem("text").value }) });
        var failures = imported.results.filter(function (item) { return !item.ok; }).length;
        toast("导入完成：" + (imported.results.length - failures) + " 成功，" + failures + " 失败", failures > 0);
        document.querySelector('[data-role="import-dialog"]').close();
        await loadAccounts();
      } catch (error) { toast(error.message, true); }
    } else if (form.matches('[data-role="settings-form"]')) {
      event.preventDefault();
      await saveSettings(form);
    }
  });

  document.addEventListener("change", function (event) {
    if (event.target.matches('[data-role="overview-day"]')) loadOverview();
  });

  document.addEventListener("selectionchange", function () {
    state.logsPaused = String(window.getSelection() || "").trim().length > 0;
  });

  window.addEventListener("hashchange", function () {
    setSection((location.hash || "#overview").slice(1));
  });

  var initial = (location.hash || "#overview").slice(1);
  if (!setSection(initial)) setSection("overview");
  loadOverview();
  loadAccounts();
  loadLogs();
  loadSettings();
  setInterval(function () { if (!state.logsPaused) loadLogs(); }, 5000);
})();
`;

export function renderConsole(): string {
  return `
<div class="shell" data-default-section="overview">
  <aside class="sidebar">
    <div class="brand">Agnes 图像控制台<small>OpenAI 兼容 · 多账号池</small></div>
    <nav class="nav">${navLinks("data-nav")}</nav>
    <div class="sidebar-footer">
      <button class="btn" type="button" data-action="logout">${icon("logout")}退出登录</button>
    </div>
  </aside>
  <main class="content">
    ${OVERVIEW_PANEL}
    ${renderGallerySection()}
    ${ACCOUNTS_PANEL}
    ${LOGS_PANEL}
    ${SETTINGS_PANEL}
  </main>
</div>
<nav class="bottom-nav">${navLinks("data-bottom-nav")}</nav>
${ACCOUNT_ACTIONS_TEMPLATE}
${DIALOGS}
<script>${CONSOLE_SCRIPT}</script>
<script>${GALLERY_SCRIPT}</script>`;
}
