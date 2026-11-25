import { icon } from "../icons.ts";
import { parseAccountImport } from "../contracts.ts";

/** Accounts section: pool health, per-key cards and import/test actions. */
export const ACCOUNTS_HTML = `
<section class="panel" data-section="accounts" data-title="账号">
  <div class="section-head">
    <div class="section-lead">
      <h2>Key 池</h2>
      <p>池中的每个 Key 应来自独立的 Agnes 账号；同一账号多加 Key 不会叠加限流额度。</p>
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
  <div class="summary-strip" data-role="accounts-summary">
    <span class="summary-pill">总计 <b data-role="summary-total">0</b></span>
    <span class="summary-pill">健康 <b data-role="summary-healthy">0</b></span>
    <span class="summary-pill">冷却 <b data-role="summary-cooling">0</b></span>
    <span class="summary-pill">停用 <b data-role="summary-disabled">0</b></span>
  </div>
  <div class="empty card" data-role="accounts-empty" hidden>
    ${icon("key")}
    <strong>还没有账号</strong>
    <span>添加一个 Agnes Key 后，请求会自动在池中轮询。</span>
    <button class="btn primary" data-action="add-account" type="button">${
  icon("plus")
}添加账号</button>
  </div>
  <div class="account-grid" data-role="accounts-list"></div>
</section>`;

export const ACCOUNTS_DIALOGS = `
<dialog data-role="account-dialog" aria-labelledby="account-dialog-title">
  <div class="dialog-body">
    <div class="dialog-head">
      <h2 id="account-dialog-title">添加账号</h2>
      <button class="icon-btn" type="button" data-action="close-dialog" aria-label="关闭">${
  icon("close")
}</button>
    </div>
    <form data-form="account">
      <div class="field">
        <label for="account-name">名称</label>
        <input class="input" id="account-name" name="name" autocomplete="off" required>
      </div>
      <div class="field" style="margin-top:14px">
        <label for="account-key">API Key</label>
        <input class="input" id="account-key" name="apiKey" autocomplete="off" spellcheck="false" required>
        <span class="hint">Agnes 控制台创建的 Key；保存后只显示首尾四位。</span>
      </div>
      <p class="form-error" data-role="account-error" role="alert"></p>
      <div class="dialog-actions">
        <button class="btn" type="button" data-action="close-dialog">取消</button>
        <button class="btn primary" type="submit">保存</button>
      </div>
    </form>
  </div>
</dialog>
<dialog data-role="import-dialog" aria-labelledby="import-dialog-title">
  <div class="dialog-body">
    <div class="dialog-head">
      <h2 id="import-dialog-title">批量导入</h2>
      <button class="icon-btn" type="button" data-action="close-dialog" aria-label="关闭">${
  icon("close")
}</button>
    </div>
    <form data-form="import">
      <div class="field">
        <label for="import-text">每行一个「名称,Key」</label>
        <textarea class="textarea" id="import-text" name="text" spellcheck="false" placeholder="main,agk_xxx&#10;backup,agk_yyy"></textarea>
        <span class="hint">同账号下多加 Key 不会叠加限流额度，请分账号导入。</span>
      </div>
      <p class="form-error" data-role="import-error" role="alert"></p>
      <div class="dialog-actions">
        <button class="btn" type="button" data-action="close-dialog">取消</button>
        <button class="btn primary" type="submit">导入</button>
      </div>
    </form>
  </div>
</dialog>
<dialog data-role="edit-dialog" aria-labelledby="edit-dialog-title">
  <div class="dialog-body">
    <div class="dialog-head">
      <h2 id="edit-dialog-title">编辑账号</h2>
      <button class="icon-btn" type="button" data-action="close-dialog" aria-label="关闭">${
  icon("close")
}</button>
    </div>
    <form data-form="edit">
      <div class="field">
        <label for="edit-name">名称</label>
        <input class="input" id="edit-name" name="name" autocomplete="off" required>
      </div>
      <div class="field" style="margin-top:14px">
        <label for="edit-key">API Key</label>
        <input class="input" id="edit-key" name="apiKey" autocomplete="off" spellcheck="false" placeholder="留空则保持不变">
        <span class="hint" data-role="edit-key-hint"></span>
      </div>
      <p class="form-error" data-role="edit-error" role="alert"></p>
      <div class="dialog-actions">
        <button class="btn" type="button" data-action="close-dialog">取消</button>
        <button class="btn primary" type="submit">保存</button>
      </div>
    </form>
  </div>
</dialog>`;

export const ACCOUNTS_SCRIPT = String.raw`
(function () {
  "use strict";
  var A = window.Agnes;
  var section = document.querySelector('[data-section="accounts"]');
  if (!section) return;
  var parseAccountImport = ${parseAccountImport.toString()};

  var state = { accounts: [], editingId: null };

  function node(role) { return document.querySelector('[data-role="' + role + '"]'); }
  function findAccount(id) {
    return state.accounts.filter(function (item) { return String(item.id) === String(id); })[0];
  }

  function showFormError(role, message) {
    var box = node(role);
    if (!box) return;
    box.textContent = message || "";
    box.classList.toggle("is-visible", Boolean(message));
  }

  function statusOf(account) {
    if (!account.enabled || account.status === "disabled") return { text: "已停用", tone: "muted" };
    if (account.status === "cooling") return { text: "冷却中", tone: "warn" };
    return { text: "健康", tone: "ok" };
  }

  function cooldownOf(account) {
    if (!account.enabled || !account.cooldownUntil) return null;
    var until = new Date(account.cooldownUntil);
    if (isNaN(until.getTime())) return null;
    if (until.getTime() <= Date.now()) return "可重试";
    return "冷却至 " + A.fmtShortTime(account.cooldownUntil);
  }

  function iconButton(name, label, action, id, tone) {
    var button = A.el("button", "icon-btn" + (tone ? " " + tone : ""));
    button.type = "button";
    button.setAttribute("data-action", action);
    button.setAttribute("data-id", String(id));
    button.setAttribute("aria-label", label);
    button.title = label;
    button.append(A.icon(name));
    return button;
  }

  function metric(label, value) {
    var box = A.el("div", "account-metric");
    box.append(A.el("span", null, label));
    box.append(A.el("b", null, A.fmtNumber(value)));
    return box;
  }

  function accountCard(account) {
    var status = statusOf(account);
    var card = A.el("article", "account-card" + (account.enabled ? "" : " is-off"));
    card.setAttribute("data-id", String(account.id));

    var top = A.el("div", "account-top");
    var identity = A.el("div", "account-id");
    var name = A.el("div", "account-name");
    name.append(A.el("span", "status-dot " + status.tone));
    name.append(A.el("span", "name-text", account.name));
    name.append(A.el("span", "tag", "#" + account.id));
    identity.append(name);
    var key = A.el("div", "account-key mono");
    key.append(A.icon("key"));
    key.append(document.createTextNode(account.apiKeyMasked));
    identity.append(key);
    var tools = A.el("div", "row-actions");
    tools.append(iconButton("pencil", "编辑 " + account.name, "edit-account", account.id));
    tools.append(iconButton("trash", "删除 " + account.name, "delete-account", account.id, "danger"));
    top.append(identity);
    top.append(tools);

    var pills = A.el("div", "account-pills");
    pills.append(A.badge(status.text, status.tone));
    var cooldown = cooldownOf(account);
    if (cooldown) pills.append(A.badge(cooldown, cooldown === "可重试" ? "info" : "warn"));
    if (account.failCount > 0) pills.append(A.badge("连续失败 " + account.failCount, "muted"));

    var metrics = A.el("div", "account-metrics");
    metrics.append(metric("上游调用", account.upstreamRequests));
    metrics.append(metric("图片", account.upstreamImages));
    metrics.append(metric("失败", account.failCount));

    var foot = A.el("div", "account-foot");
    var times = A.el("div", "account-times",
      "最后使用 " + A.fmtRelative(account.lastUsedAt) + " · 添加于 " +
      A.fmtRelative(account.createdAt));
    var actions = A.el("div", "row-actions");
    actions.append(iconButton("bolt", "测试 " + account.name, "test-account", account.id));
    actions.append(iconButton("refresh", "恢复 " + account.name, "reset-account", account.id));
    actions.append(
      iconButton("power", (account.enabled ? "停用 " : "启用 ") + account.name, "toggle-account",
        account.id, account.enabled ? "" : "danger"),
    );
    foot.append(times);
    foot.append(actions);

    card.append(top);
    card.append(pills);
    card.append(metrics);
    card.append(foot);
    return card;
  }

  function summarize() {
    var total = state.accounts.length;
    var healthy = state.accounts.filter(function (item) {
      return item.enabled && item.status === "healthy";
    }).length;
    var cooling = state.accounts.filter(function (item) {
      return item.enabled && item.status === "cooling";
    }).length;
    var disabled = state.accounts.filter(function (item) {
      return !item.enabled || item.status === "disabled";
    }).length;
    var values = {
      "summary-total": total,
      "summary-healthy": healthy,
      "summary-cooling": cooling,
      "summary-disabled": disabled,
    };
    for (var role in values) {
      var target = node(role);
      if (target) target.textContent = A.fmtNumber(values[role]);
    }
    A.setHealth(healthy, total);
  }

  function render() {
    var list = node("accounts-list");
    var empty = node("accounts-empty");
    if (!list) return;
    list.replaceChildren();
    summarize();
    if (state.accounts.length === 0) {
      if (empty) empty.hidden = false;
      list.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    list.hidden = false;
    for (var i = 0; i < state.accounts.length; i++) list.append(accountCard(state.accounts[i]));
  }

  var requestId = 0;
  async function load(silent) {
    var id = ++requestId;
    try {
      var payload = await A.api("/admin/api/accounts");
      if (id !== requestId) return;
      state.accounts = (payload && payload.items) || [];
      render();
    } catch (error) {
      if (id !== requestId) return;
      if (!silent) A.toast(error.message, "error");
    }
  }

  function closeDialog(button) {
    var dialog = button.closest("dialog");
    if (dialog) dialog.close();
  }

  async function testAccount(button, account) {
    A.setBusy(button, true, "测试中…");
    try {
      var result = await A.api("/admin/api/accounts/" + account.id + "/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      A.toast(
        result.ok
          ? "「" + account.name + "」可用"
          : "「" + account.name + "」不可用：" + (result.message || "HTTP " + result.status),
        result.ok ? "ok" : "error",
      );
      await load();
    } catch (error) {
      A.toast(error.message, "error");
    }
    A.setBusy(button, false);
  }

  async function testAll(button) {
    A.setBusy(button, true, "测试中…");
    try {
      var all = await A.api("/admin/api/accounts/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      var results = (all && all.items) || [];
      var okCount = results.filter(function (item) { return item.ok; }).length;
      A.toast("测试完成：" + okCount + "/" + results.length + " 通过",
        okCount === results.length ? "ok" : "error");
      await load();
    } catch (error) {
      A.toast(error.message, "error");
    }
    A.setBusy(button, false);
  }

  async function toggleAccount(account, button) {
    if (button) A.setBusy(button, true, "切换中…");
    try {
      await A.api("/admin/api/accounts/" + account.id, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !account.enabled }),
      });
      A.toast(account.enabled ? "已停用「" + account.name + "」" : "已启用「" + account.name + "」");
      await load();
    } catch (error) { A.toast(error.message, "error"); }
    if (button) A.setBusy(button, false);
  }

  async function resetAccount(button, account) {
    A.setBusy(button, true, "恢复中…");
    try {
      await A.api("/admin/api/accounts/" + account.id + "/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      A.toast("已恢复「" + account.name + "」的冷却状态");
      await load();
    } catch (error) {
      A.toast(error.message, "error");
    }
    A.setBusy(button, false);
  }

  async function deleteAccount(account) {
    var ok = await A.confirm({
      title: "删除账号",
      message: "将从池中移除「" + account.name + "」，此操作不可撤销。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await A.api("/admin/api/accounts/" + account.id, { method: "DELETE" });
      A.toast("已删除「" + account.name + "」");
      await load();
    } catch (error) { A.toast(error.message, "error"); }
  }

  document.addEventListener("click", function (event) {
    var target = event.target.closest("[data-action]");
    if (!target) return;
    var action = target.getAttribute("data-action");
    var id = target.getAttribute("data-id");
    var account = id === null ? null : findAccount(id);

    if (action === "add-account") {
      showFormError("account-error", "");
      var addDialog = node("account-dialog");
      if (addDialog) addDialog.showModal();
      return;
    }
    if (action === "import-accounts") {
      showFormError("import-error", "");
      var importDialog = node("import-dialog");
      if (importDialog) importDialog.showModal();
      return;
    }
    if (action === "close-dialog") {
      closeDialog(target);
      return;
    }
    if (action === "test-all") {
      testAll(target);
      return;
    }
    if (!account) return;
    if (action === "test-account") testAccount(target, account);
    else if (action === "reset-account") resetAccount(target, account);
    else if (action === "toggle-account") toggleAccount(account, target);
    else if (action === "delete-account") deleteAccount(account);
    else if (action === "edit-account") {
      state.editingId = account.id;
      showFormError("edit-error", "");
      var form = document.querySelector('[data-form="edit"]');
      if (form) {
        form.elements.namedItem("name").value = account.name;
        form.elements.namedItem("apiKey").value = "";
      }
      var hint = node("edit-key-hint");
      if (hint) hint.textContent = "当前 Key：" + account.apiKeyMasked + "；留空则保持不变。";
      var editDialog = node("edit-dialog");
      if (editDialog) editDialog.showModal();
    }
  });

  document.addEventListener("submit", async function (event) {
    var form = event.target;
    if (form.matches('[data-form="account"]')) {
      event.preventDefault();
      showFormError("account-error", "");
      var submit = form.querySelector('button[type="submit"]');
      A.setBusy(submit, true, "保存中…");
      try {
        await A.api("/admin/api/accounts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: form.elements.namedItem("name").value,
            apiKey: form.elements.namedItem("apiKey").value,
          }),
        });
        form.reset();
        node("account-dialog").close();
        A.toast("账号已添加");
        await load();
      } catch (error) {
        showFormError("account-error", error.message);
      }
      A.setBusy(submit, false);
    } else if (form.matches('[data-form="import"]')) {
      event.preventDefault();
      showFormError("import-error", "");
      var importSubmit = form.querySelector('button[type="submit"]');
      A.setBusy(importSubmit, true, "导入中…");
      try {
        var text = form.elements.namedItem("text").value;
        var parsed = parseAccountImport(text);
        if (parsed.errors.length > 0) {
          var first = parsed.errors[0];
          showFormError(
            "import-error",
            first.line > 0
              ? first.message + "；本次未提交任何账号"
              : first.message + "；本次未提交任何账号",
          );
          if (parsed.errors.length > 1) {
            showFormError("import-error", first.message + "（另有 " + (parsed.errors.length - 1) +
              " 处错误）；本次未提交任何账号");
          }
          A.setBusy(importSubmit, false);
          return;
        }
        var imported = await A.api("/admin/api/accounts/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accounts: parsed.accounts }),
        });
        var failures = (imported && imported.errors) || [];
        var successes = (imported && imported.imported) || 0;
        if (successes > 0) A.toast("已导入 " + successes + " 个账号");
        if (failures.length > 0) {
          var lines = failures.map(function (item) {
            return parsed.lineNumbers[item.index] || "?";
          });
          showFormError("import-error", failures.length + " 个账号导入失败，行号：" + lines.join("、") +
            "；首个错误：" + failures[0].message);
        } else {
          form.reset();
          node("import-dialog").close();
        }
        await load();
      } catch (error) {
        showFormError("import-error", error.message);
      }
      A.setBusy(importSubmit, false);
    } else if (form.matches('[data-form="edit"]')) {
      event.preventDefault();
      showFormError("edit-error", "");
      var editSubmit = form.querySelector('button[type="submit"]');
      A.setBusy(editSubmit, true, "保存中…");
      try {
        var patch = { name: form.elements.namedItem("name").value };
        var apiKey = form.elements.namedItem("apiKey").value.trim();
        if (apiKey !== "") patch.apiKey = apiKey;
        await A.api("/admin/api/accounts/" + state.editingId, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        node("edit-dialog").close();
        A.toast("账号已更新");
        await load();
      } catch (error) {
        showFormError("edit-error", error.message);
      }
      A.setBusy(editSubmit, false);
    }
  });

  A.autoRefresh.register("accounts", load);
})();
`;
