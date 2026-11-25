import { BRAND_MARK, FAVICON_URI, icon, ICON_SPRITE } from "./icons.ts";
import { LOGIN_STYLE } from "./styles.ts";
import { THEME_INIT_SCRIPT } from "./theme.ts";

/**
 * Build the first-run storage payload. Local storage must not carry ImgBed
 * fields at all; ImgBed requires a base URL and token.
 */
export function storageInitPayload(mode, baseUrl, token) {
  if (mode === "local") return { mode: "local" };
  if (mode !== "imgbed") throw new Error("请选择存储方式");
  return {
    mode: "imgbed",
    imgbedBaseUrl: String(baseUrl === undefined || baseUrl === null ? "" : baseUrl).trim(),
    imgbedToken: String(token === undefined || token === null ? "" : token).trim(),
  };
}

/** Build a storage update; a blank token is omitted, never sent as null. */
export function storageUpdatePayload(baseUrl, token) {
  const payload = {
    imgbedBaseUrl: String(baseUrl === undefined || baseUrl === null ? "" : baseUrl).trim(),
  };
  const trimmed = String(token === undefined || token === null ? "" : token).trim();
  if (trimmed) payload.imgbedToken = trimmed;
  return payload;
}

const SETUP_SCRIPT = String.raw`
(function () {
  "use strict";
  var storageInitPayload = ${storageInitPayload.toString()};
  var form = document.querySelector('[data-role="setup-form"]');
  var local = form.querySelector('input[name="mode"][value="local"]');
  var imgbed = form.querySelector('input[name="mode"][value="imgbed"]');
  var fields = document.querySelector('[data-role="imgbed-fields"]');
  var baseInput = document.querySelector('[data-role="imgbed-base-url"]');
  var tokenInput = document.querySelector('[data-role="imgbed-token"]');
  var submit = document.querySelector('[data-role="setup-submit"]');
  var errorBox = document.querySelector('[data-role="setup-error"]');

  function chosen() {
    if (local && local.checked) return "local";
    if (imgbed && imgbed.checked) return "imgbed";
    return "";
  }

  function sync() {
    var mode = chosen();
    if (fields) fields.hidden = mode !== "imgbed";
    if (submit) submit.disabled = !mode;
  }

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.classList.toggle("is-visible", Boolean(message));
  }

  function imgbedError() {
    var value = String(baseInput ? baseInput.value : "").trim();
    if (!value) return "请填写 ImgBed 地址";
    var parsed;
    try {
      parsed = new URL(value);
    } catch (parseError) {
      return "ImgBed 地址必须是有效的 HTTPS origin";
    }
    if (parsed.protocol !== "https:") return "ImgBed 地址必须使用 HTTPS";
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return "ImgBed 地址不能包含凭据、查询或片段";
    }
    if (parsed.pathname !== "" && parsed.pathname !== "/") {
      return "ImgBed 地址只能是 origin，不能包含路径";
    }
    if (!String(tokenInput ? tokenInput.value : "").trim()) return "请填写 ImgBed Token";
    return "";
  }

  function readStorage() {
    return fetch("/admin/api/storage", { credentials: "same-origin" }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (body) {
        if (!response.ok) {
          var failure = new Error(
            body && body.error && body.error.message ? body.error.message : "HTTP " + response.status,
          );
          failure.status = response.status;
          throw failure;
        }
        return body;
      });
    });
  }

  function followStorage() {
    return readStorage().then(function (status) {
      if (!status || status.initialized !== true) {
        location.replace("/admin/setup");
        return;
      }
      location.replace("/admin#overview");
    });
  }

  [local, imgbed].forEach(function (input) {
    if (input) input.addEventListener("change", sync);
  });
  sync();

  readStorage().then(function (status) {
    if (status && status.initialized === true) location.replace("/admin");
  }).catch(function (error) {
    if (error.status === 401) location.replace("/admin/login");
    else showError("无法读取存储状态：" + error.message);
  });

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    showError("");
    var mode = chosen();
    if (!mode) {
      showError("请先选择存储方式");
      return;
    }
    if (mode === "imgbed") {
      var problem = imgbedError();
      if (problem) {
        showError(problem);
        return;
      }
    }
    var payload;
    try {
      payload = storageInitPayload(mode, baseInput ? baseInput.value : "", tokenInput ? tokenInput.value : "");
    } catch (payloadError) {
      showError(payloadError.message);
      return;
    }
    var original = submit.textContent;
    submit.disabled = true;
    submit.textContent = "初始化中…";
    try {
      var response = await fetch("/admin/api/storage", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      var body = null;
      try { body = await response.json(); } catch (parseError) { body = null; }
      if (response.status === 201) {
        if (tokenInput) tokenInput.value = "";
        await followStorage();
        return;
      }
      var code = body && body.error && body.error.code;
      if (code === "already_initialized") {
        await followStorage();
        return;
      }
      if (response.status === 401) {
        location.replace("/admin/login");
        return;
      }
      throw new Error(body && body.error && body.error.message ? body.error.message : "HTTP " + response.status);
    } catch (failure) {
      showError("初始化失败：" + failure.message);
      submit.disabled = false;
      submit.textContent = original;
    }
  });
})();
`;

/** First-run page shown when /admin/api/storage reports uninitialized. */
export function renderSetupPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="${FAVICON_URI}">
<title>初始化存储 · Agnes 图像控制台</title>
<script>${THEME_INIT_SCRIPT}</script>
<style>${LOGIN_STYLE}</style>
</head>
<body>
${ICON_SPRITE}
<main class="card" data-page="setup">
  <div class="brand">
    ${BRAND_MARK}
    <div>
      <div class="brand-name">Agnes 图像代理</div>
      <div class="brand-sub">OpenAI 兼容 · 多账号池</div>
    </div>
  </div>
  <h1>选择原图存储方式</h1>
  <p class="hint">这是首次运行设置。存储方式写入后<strong>不能切换</strong>，也不会迁移历史图片，请确认后再提交。</p>
  <form data-role="setup-form" data-form="setup">
    <fieldset class="storage-choice">
      <legend>存储方式</legend>
      <label class="choice">
        <input type="radio" name="mode" value="local">
        <span><strong>本地存储</strong><small>原图保存在本服务的持久化数据目录。</small></span>
      </label>
      <label class="choice">
        <input type="radio" name="mode" value="imgbed">
        <span><strong>ImgBed 图床</strong><small>原图上传到你自己的 ImgBed 服务，Token 需要 upload 与 delete 权限。</small></span>
      </label>
    </fieldset>
    <div data-role="imgbed-fields" hidden>
      <label for="imgbed-base-url">ImgBed 地址</label>
      <input id="imgbed-base-url" data-role="imgbed-base-url" name="imgbedBaseUrl" type="url"
        inputmode="url" spellcheck="false" placeholder="https://img.example.com" autocomplete="off">
      <span class="hint">必须是 HTTPS origin，不能包含路径、查询或凭据。</span>
      <label for="imgbed-token">ImgBed Token</label>
      <input id="imgbed-token" data-role="imgbed-token" name="imgbedToken" type="password"
        autocomplete="new-password" spellcheck="false">
      <span class="hint">Token 仅随本次初始化请求发送；前端不会验证图床连通性或权限。</span>
    </div>
    <p class="error" data-role="setup-error" role="alert"></p>
    <button type="submit" data-role="setup-submit" disabled>初始化存储</button>
  </form>
  <p class="foot">初始化完成后进入控制台；如其他管理员已选择模式，将以服务器状态为准。</p>
</main>
<script>${SETUP_SCRIPT}</script>
</body>
</html>`;
}
