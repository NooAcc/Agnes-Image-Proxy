import { BRAND_MARK, FAVICON_URI, icon, ICON_SPRITE } from "./icons.ts";
import { LOGIN_STYLE } from "./styles.ts";
import { THEME_INIT_SCRIPT } from "./theme.ts";
import { safeAdminDestination } from "./contracts.ts";

const LOGIN_SCRIPT = String.raw`
(function () {
  "use strict";
  var safeAdminDestination = ${safeAdminDestination.toString()};
  var form = document.querySelector('[data-role="login-form"]');
  var errorBox = document.querySelector('[data-role="login-error"]');
  var keyInput = document.querySelector('[data-role="login-key"]');
  var submit = form.querySelector('button[type="submit"]');
  var reveal = document.querySelector('[data-action="toggle-password"]');

  function nextTarget() {
    try {
      var params = new URLSearchParams(location.search);
      return safeAdminDestination(params.get("next") || "");
    } catch (error) {
      return safeAdminDestination("");
    }
  }

  function readStorageTarget() {
    return fetch("/admin/api/storage", { credentials: "same-origin" }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (body) {
        if (!response.ok) {
          var message = body && body.error && body.error.message
            ? body.error.message
            : "HTTP " + response.status;
          throw new Error("无法读取存储状态：" + message);
        }
        return body && body.initialized === true ? nextTarget() : "/admin/setup";
      });
    });
  }

  if (reveal) {
    reveal.addEventListener("click", function () {
      var show = keyInput.type === "password";
      keyInput.type = show ? "text" : "password";
      reveal.setAttribute("aria-pressed", show ? "true" : "false");
      reveal.setAttribute("aria-label", show ? "隐藏密钥" : "显示密钥");
      keyInput.focus();
    });
  }

  // Already authenticated: follow the storage state instead of showing the form.
  fetch("/admin/api/session", { credentials: "same-origin" }).then(function (response) {
    if (!response.ok) return null;
    return readStorageTarget().then(function (target) {
      location.replace(target);
    });
  }).catch(function () { /* stay on the login form */ });

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    errorBox.textContent = "";
    submit.disabled = true;
    var original = submit.textContent;
    submit.textContent = "登录中…";
    try {
      var response = await fetch("/admin/api/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: keyInput.value }),
      });
      if (!response.ok) {
        var body = null;
        try { body = await response.json(); } catch (error) { body = null; }
        var message = response.status === 429
          ? "尝试次数过多，请 60 秒后重试"
          : response.status === 401
          ? "密钥无效"
          : (body && body.error && body.error.message
            ? body.error.message
            : "HTTP " + response.status);
        throw new Error(message);
      }
      var target = await readStorageTarget();
      keyInput.value = "";
      location.replace(target);
    } catch (error) {
      errorBox.textContent = "登录失败：" + error.message;
      submit.disabled = false;
      submit.textContent = original;
      keyInput.focus();
      keyInput.select();
    }
  });
})();
`;

/** Login page shown when /admin has no valid session. */
export function renderLoginPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="${FAVICON_URI}">
<title>登录 · Agnes 图像控制台</title>
<script>${THEME_INIT_SCRIPT}</script>
<style>${LOGIN_STYLE}</style>
</head>
<body>
${ICON_SPRITE}
<main class="card">
  <div class="brand">
    ${BRAND_MARK}
    <div>
      <div class="brand-name">Agnes 图像代理</div>
      <div class="brand-sub">OpenAI 兼容 · 多账号池</div>
    </div>
  </div>
  <h1>控制台登录</h1>
  <p class="hint">使用环境变量 <code>PROXY_API_KEY</code> 的值登录。会话 Cookie 仅限 <code>/admin</code>，30 天有效。</p>
  <form data-role="login-form">
    <label for="login-key">访问密钥</label>
    <div class="input-wrap">
      <input id="login-key" data-role="login-key" name="key" type="password" autocomplete="current-password" spellcheck="false" autofocus required>
      <button class="reveal" type="button" data-action="toggle-password" aria-label="显示密钥" aria-pressed="false">
        <span class="pw-show">${icon("eye")}</span>
        <span class="pw-hide">${icon("eyeOff")}</span>
      </button>
    </div>
    <button type="submit">登录</button>
    <p class="error" data-role="login-error" role="alert"></p>
  </form>
  <p class="foot">密钥同时是数据面的 Bearer 令牌；轮换 PROXY_API_KEY 会作废全部会话。</p>
</main>
<script>${LOGIN_SCRIPT}</script>
</body>
</html>`;
}
