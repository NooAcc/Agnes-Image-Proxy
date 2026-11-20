import { LOGIN_STYLE } from "./styles.ts";

const LOGIN_SCRIPT = String.raw`
(function () {
  "use strict";
  var form = document.querySelector('[data-role="login-form"]');
  var errorBox = document.querySelector('[data-role="login-error"]');
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    errorBox.textContent = "";
    var key = form.elements.namedItem("key").value;
    try {
      var response = await fetch("/admin/api/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: key }),
      });
      if (!response.ok) throw new Error("密钥无效");
      location.replace("/admin");
    } catch (error) {
      errorBox.textContent = "登录失败：" + error.message;
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
<meta name="color-scheme" content="light">
<title>登录 · Agnes 图像控制台</title>
<style>${LOGIN_STYLE}</style>
</head>
<body>
<main class="card">
  <h1>Agnes 图像控制台</h1>
  <p class="hint">使用环境变量 PROXY_API_KEY 的值登录。</p>
  <form data-role="login-form">
    <label for="login-key">访问密钥</label>
    <input id="login-key" name="key" type="password" autocomplete="current-password" required>
    <button type="submit">登录</button>
  </form>
  <p class="error" data-role="login-error"></p>
</main>
<script>${LOGIN_SCRIPT}</script>
</body>
</html>`;
}
