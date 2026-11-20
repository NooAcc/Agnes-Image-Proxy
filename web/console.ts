import { BRAND_MARK, icon } from "./icons.ts";
import { RUNTIME_SCRIPT } from "./runtime.ts";
import { ACCOUNTS_DIALOGS, ACCOUNTS_HTML, ACCOUNTS_SCRIPT } from "./sections/accounts.ts";
import { LOGS_DIALOGS, LOGS_HTML, LOGS_SCRIPT } from "./sections/logs.ts";
import { OVERVIEW_HTML, OVERVIEW_SCRIPT } from "./sections/overview.ts";
import { SETTINGS_HTML, SETTINGS_SCRIPT } from "./sections/settings.ts";
import { GALLERY_DIALOGS, GALLERY_HTML, GALLERY_SCRIPT } from "./gallery.ts";

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

const CONFIRM_DIALOG = `
<dialog data-role="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-desc">
  <div class="dialog-body">
    <div class="dialog-head">
      <h2 id="confirm-title" data-role="confirm-title">确认操作</h2>
    </div>
    <p class="dialog-desc" id="confirm-desc" data-role="confirm-desc"></p>
    <form method="dialog" class="dialog-actions">
      <button class="btn" value="cancel" type="submit" data-role="confirm-cancel">取消</button>
      <button class="btn danger" value="confirm" type="submit" data-role="confirm-accept">确认</button>
    </form>
  </div>
</dialog>`;

const SHELL_SCRIPT = String.raw`
(function () {
  "use strict";
  var A = window.Agnes;
  var sectionNodes = Array.prototype.slice.call(document.querySelectorAll("[data-section]"));
  var navNodes = Array.prototype.slice.call(
    document.querySelectorAll("[data-nav], [data-bottom-nav]"),
  );
  var titleNode = document.querySelector('[data-role="page-title"]');
  var titles = {};

  for (var i = 0; i < sectionNodes.length; i++) {
    var node = sectionNodes[i];
    var id = node.getAttribute("data-section");
    titles[id] = node.getAttribute("data-title") || id;
  }

  function setSection(name) {
    if (!titles[name]) name = "overview";
    for (var a = 0; a < sectionNodes.length; a++) {
      sectionNodes[a].classList.toggle(
        "is-active",
        sectionNodes[a].getAttribute("data-section") === name,
      );
    }
    for (var b = 0; b < navNodes.length; b++) {
      var link = navNodes[b];
      var target = link.getAttribute("data-nav") || link.getAttribute("data-bottom-nav");
      var on = target === name;
      link.classList.toggle("is-active", on);
      if (on) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    if (titleNode) titleNode.textContent = titles[name];
    document.title = titles[name] + " · Agnes 图像控制台";
    document.dispatchEvent(new CustomEvent("agnes:section", { detail: { name: name } }));
  }

  function navigate(name) {
    if (location.hash !== "#" + name) {
      location.hash = name;
    } else {
      setSection(name);
    }
    window.scrollTo(0, 0);
  }

  async function logout() {
    try {
      await A.api("/admin/api/session", { method: "DELETE" });
      location.replace("/admin");
    } catch (error) {
      A.toast(error.message, "error");
    }
  }

  document.addEventListener("click", function (event) {
    var link = event.target.closest("[data-nav], [data-bottom-nav]");
    if (link) {
      event.preventDefault();
      navigate(link.getAttribute("data-nav") || link.getAttribute("data-bottom-nav"));
      return;
    }
    if (event.target.closest('[data-action="toggle-theme"]')) {
      A.toggleTheme();
      return;
    }
    if (event.target.closest('[data-action="logout"]')) {
      logout();
    }
  });

  window.addEventListener("hashchange", function () {
    setSection((location.hash || "#overview").slice(1));
  });

  A.syncThemeUi();
  setSection((location.hash || "#overview").slice(1));
})();
`;

const CONSOLE_SCRIPTS = [
  RUNTIME_SCRIPT,
  OVERVIEW_SCRIPT,
  GALLERY_SCRIPT,
  ACCOUNTS_SCRIPT,
  LOGS_SCRIPT,
  SETTINGS_SCRIPT,
  SHELL_SCRIPT,
];

export function renderConsole(): string {
  return `
<a class="skip-link" href="#main">跳到主要内容</a>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      ${BRAND_MARK}
      <div>
        <div class="brand-name">Agnes 图像代理</div>
        <div class="brand-sub">OpenAI 兼容 · 多账号池</div>
      </div>
    </div>
    <nav class="nav" aria-label="主导航">${navLinks("data-nav")}</nav>
    <div class="sidebar-foot">
      <div class="session-note"><span class="session-dot" aria-hidden="true"></span>管理员会话 · 30 天有效</div>
      <button class="btn" type="button" data-action="logout">${icon("logout")}退出登录</button>
    </div>
  </aside>
  <div class="main">
    <header class="topbar">
      <div class="topbar-heading">
        <span class="eyebrow">Agnes Console</span>
        <h1 data-role="page-title">总览</h1>
      </div>
      <div class="topbar-actions">
        <span class="health-chip" data-role="health-chip" data-tone="muted">
          <span class="dot" aria-hidden="true"></span>
          <span data-role="health-text">Key 池 —</span>
        </span>
        <button class="icon-btn" type="button" data-action="toggle-theme" aria-label="切换主题" title="切换主题">
          <span class="theme-icon-dark">${icon("sun")}</span>
          <span class="theme-icon-light">${icon("moon")}</span>
        </button>
        <button class="icon-btn" type="button" data-action="logout" aria-label="退出登录" title="退出登录">
          ${icon("logout")}
        </button>
      </div>
    </header>
    <main class="content" id="main">
      ${OVERVIEW_HTML}
      ${GALLERY_HTML}
      ${ACCOUNTS_HTML}
      ${LOGS_HTML}
      ${SETTINGS_HTML}
    </main>
  </div>
</div>
<nav class="bottom-nav" aria-label="主导航">${navLinks("data-bottom-nav")}</nav>
${CONFIRM_DIALOG}
${ACCOUNTS_DIALOGS}
${GALLERY_DIALOGS}
${LOGS_DIALOGS}
<div class="toast-stack" data-role="toast-stack" role="status" aria-live="polite" aria-atomic="false"></div>
${CONSOLE_SCRIPTS.map((script) => `<script>${script}</script>`).join("\n")}`;
}
