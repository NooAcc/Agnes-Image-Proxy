import { settingsPayload, SETTINGS_FIELDS } from "../contracts.ts";
import { STORAGE_HTML } from "../storage.ts";

/** Settings section: connection, generation defaults, retry/timeout policy. */
export const SETTINGS_HTML = `
<section class="panel" data-section="settings" data-title="设置">
  <div class="section-head">
    <div class="section-lead">
      <h2>运行设置</h2>
      <p>保存后立即生效；设置读取有 10 秒缓存。默认值只在请求未指定尺寸时使用。</p>
    </div>
  </div>
  <form class="settings-form" data-role="settings-form">
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">Agnes 连接</div>
          <p>上游基础地址与连通性测试使用的模型。</p>
        </div>
      </div>
      <div class="form-grid two">
        <div class="field">
          <label for="agnesBaseUrl">Agnes 基础地址</label>
          <input class="input" id="agnesBaseUrl" name="agnesBaseUrl" spellcheck="false" required>
          <span class="hint">默认 https://apihub.agnes-ai.com/v1；只允许 https，localhost 可用 http。</span>
        </div>
        <div class="field">
          <label for="probeModel">测试模型</label>
          <input class="input" id="probeModel" name="probeModel" spellcheck="false" required>
          <span class="hint">「测试账号」用一个最小请求验证 Key 是否可用。</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">生成默认值</div>
          <p>客户端没有传对应字段时，代理按这里的值补齐。</p>
        </div>
      </div>
      <div class="form-grid">
        <div class="field">
          <span class="field-label" id="defaultSize-label">默认档位</span>
          <div class="segmented" role="radiogroup" aria-labelledby="defaultSize-label">
            <label><input type="radio" name="defaultSize" value="1K"><span>1K</span></label>
            <label><input type="radio" name="defaultSize" value="2K"><span>2K</span></label>
            <label><input type="radio" name="defaultSize" value="3K"><span>3K</span></label>
            <label><input type="radio" name="defaultSize" value="4K"><span>4K</span></label>
          </div>
        </div>
        <div class="field">
          <span class="field-label" id="imageParamMode-label">参考图参数位置</span>
          <div class="segmented" role="radiogroup" aria-labelledby="imageParamMode-label">
            <label><input type="radio" name="imageParamMode" value="nested"><span>nested</span></label>
            <label><input type="radio" name="imageParamMode" value="top_level"><span>top_level</span></label>
          </div>
          <span class="hint">上游两种位置都接受；只有特殊上游才需要 top_level。</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">请求与重试</div>
          <p>超时映射为 504；每次请求最多尝试设置的 Key 数量。</p>
        </div>
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="requestTimeoutMs">上游超时（毫秒）</label>
          <input class="input" id="requestTimeoutMs" name="requestTimeoutMs" type="number" min="60000" max="360000" step="10000" required>
          <span class="hint" data-role="timeout-hint">范围 60–360 秒。</span>
        </div>
        <div class="field">
          <label for="maxAttempts">最大尝试次数</label>
          <input class="input" id="maxAttempts" name="maxAttempts" type="number" min="1" max="10" required>
          <span class="hint">失败后切换到下一个 Key 的上限。</span>
        </div>
        <div class="field">
          <label for="probeConcurrency">测试并发</label>
          <input class="input" id="probeConcurrency" name="probeConcurrency" type="number" min="1" max="10" required>
          <span class="hint">「全部测试」同时探测的账号数量。</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">图片服务</div>
          <p>归档后调用 Edge-Images 生成缩略图与 NSFW 分类；基址留空即关闭。</p>
        </div>
      </div>
      <div class="form-grid two">
        <div class="field">
          <label for="imageServiceBaseUrl">Edge-Images 基础地址</label>
          <input class="input" id="imageServiceBaseUrl" name="imageServiceBaseUrl" spellcheck="false">
          <span class="hint">留空则关闭缩略图与 NSFW；只允许 https，localhost 可用 http。</span>
        </div>
        <div class="field">
          <label for="thumbnailWidth">缩略图宽度（像素）</label>
          <input class="input" id="thumbnailWidth" name="thumbnailWidth" type="number" min="128" max="2048" step="1" required>
          <span class="hint">等比缩放到最长边不超过该值，不放大。</span>
        </div>
        <div class="field">
          <label for="thumbnailQuality">缩略图质量</label>
          <input class="input" id="thumbnailQuality" name="thumbnailQuality" type="number" min="40" max="100" step="1" required>
          <span class="hint">WebP 质量，范围 40–100。</span>
        </div>
        <div class="field">
          <label for="enrichTimeoutMs">图片服务超时（毫秒）</label>
          <input class="input" id="enrichTimeoutMs" name="enrichTimeoutMs" type="number" min="5000" max="60000" step="1000" required>
          <span class="hint">上限 60 秒，与 Edge-Images 服务端超时一致。</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">图片链接</div>
          <p>签名交付链接的有效期与可选公开地址；图片原图始终由本服务提供。</p>
        </div>
      </div>
      <div class="form-grid two">
        <div class="field">
          <label for="imageUrlTtlHours">签名链接有效期（小时）</label>
          <input class="input" id="imageUrlTtlHours" name="imageUrlTtlHours" type="number" min="1" max="720" step="1" required>
          <span class="hint">1–720 小时的整数，默认 24。</span>
        </div>
        <div class="field">
          <label for="imagePublicBaseUrl">图片公开地址</label>
          <input class="input" id="imagePublicBaseUrl" name="imagePublicBaseUrl" spellcheck="false" placeholder="https://images.example.com">
          <span class="hint">可选；留空时使用当前请求的域名。只能填写 origin，不含路径或查询。</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">控制台</div>
          <p>仅当前打开的板块会自动刷新；页面隐藏或选中文字时暂停。</p>
        </div>
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="autoRefreshIntervalMs">自动刷新间隔（毫秒）</label>
          <input class="input" id="autoRefreshIntervalMs" name="autoRefreshIntervalMs" type="number" min="2000" max="60000" step="1000" required>
          <span class="hint" data-role="auto-interval-hint">范围 2–60 秒。</span>
        </div>
      </div>
    </div>

    <div class="save-bar">
      <span class="form-status" data-role="settings-status">加载中…</span>
      <button class="btn" type="reset">放弃修改</button>
      <button class="btn primary" type="submit">保存设置</button>
    </div>
  </form>
${STORAGE_HTML}
</section>`;

export const SETTINGS_SCRIPT = String.raw`
(function () {
  "use strict";
  var A = window.Agnes;
  var section = document.querySelector('[data-section="settings"]');
  if (!section) return;

  var form = section.querySelector('[data-role="settings-form"]');
  if (!form) return;
  var state = { dirty: false, loaded: false };
  var status = section.querySelector('[data-role="settings-status"]');
  var timeoutInput = form.elements.namedItem("requestTimeoutMs");
  var timeoutHint = section.querySelector('[data-role="timeout-hint"]');
  var intervalInput = form.elements.namedItem("autoRefreshIntervalMs");
  var intervalHint = section.querySelector('[data-role="auto-interval-hint"]');
  var settingsPayload = ${settingsPayload.toString()};
  var FIELDS = ${JSON.stringify(SETTINGS_FIELDS)};

  function setStatus(text, dirty) {
    if (!status) return;
    status.textContent = text;
    status.classList.toggle("is-dirty", Boolean(dirty));
  }

  function markDirty() {
    if (state.dirty) return;
    state.dirty = true;
    setStatus("有未保存的修改", true);
  }

  function updateTimeoutHint() {
    if (!timeoutHint || !timeoutInput) return;
    var ms = Number(timeoutInput.value);
    if (!isFinite(ms) || ms <= 0) {
      timeoutHint.textContent = "范围 60–360 秒。";
      return;
    }
    timeoutHint.textContent = "当前约 " + (ms / 60000).toFixed(ms % 60000 === 0 ? 0 : 1) + " 分钟。";
  }

  function updateIntervalHint() {
    if (!intervalHint || !intervalInput) return;
    var ms = Number(intervalInput.value);
    if (!isFinite(ms) || ms <= 0) {
      intervalHint.textContent = "范围 2–60 秒。";
      return;
    }
    intervalHint.textContent = "当前约 " + (ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1) + " 秒。";
  }

  function setField(name, value) {
    var fields = form.querySelectorAll('[name="' + name + '"]');
    if (!fields.length) return;
    if (fields[0].type === "radio") {
      for (var i = 0; i < fields.length; i++) {
        fields[i].checked = String(fields[i].value) === String(value);
      }
      return;
    }
    fields[0].value = value === undefined || value === null ? "" : value;
  }

  var requestId = 0;
  async function load(silent) {
    if (state.dirty) {
      setStatus("有未保存的修改", true);
      return;
    }
    var id = ++requestId;
    try {
      var settings = await A.api("/admin/api/settings");
      if (id !== requestId) return;
      for (var i = 0; i < FIELDS.length; i++) {
        setField(FIELDS[i], settings ? settings[FIELDS[i]] : "");
      }
      updateTimeoutHint();
      updateIntervalHint();
      state.dirty = false;
      state.loaded = true;
      setStatus("已与服务器同步", false);
      document.dispatchEvent(new CustomEvent("agnes:settings", { detail: settings }));
    } catch (error) {
      if (id !== requestId) return;
      setStatus("读取设置失败", false);
      if (!silent) A.toast(error.message, "error");
    }
  }

  function collect() {
    var values = {};
    for (var i = 0; i < FIELDS.length; i++) {
      var name = FIELDS[i];
      var field = form.elements.namedItem(name);
      values[name] = field ? field.value : "";
    }
    return settingsPayload(values);
  }

  form.addEventListener("input", function () {
    markDirty();
    updateTimeoutHint();
    updateIntervalHint();
  });
  form.addEventListener("change", markDirty);

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    var submit = form.querySelector('button[type="submit"]');
    var payload;
    try {
      payload = collect();
    } catch (error) {
      setStatus(error.message, true);
      A.toast(error.message, "error");
      return;
    }
    A.setBusy(submit, true, "保存中…");
    try {
      await A.api("/admin/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      A.toast("设置已保存");
      state.dirty = false;
      await load();
    } catch (error) {
      setStatus("保存失败", false);
      A.toast(error.message, "error");
    }
    A.setBusy(submit, false);
  });

  form.addEventListener("reset", function (event) {
    event.preventDefault();
    state.dirty = false;
    load();
  });

  function refresh(silent) {
    if (state.dirty) {
      setStatus("有未保存的修改", true);
      return;
    }
    return load(silent);
  }

  A.autoRefresh.register("settings", refresh);

  updateTimeoutHint();
  updateIntervalHint();
})();
`;
