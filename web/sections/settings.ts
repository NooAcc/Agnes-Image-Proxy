/** Settings section: connection, generation defaults, retry/timeout policy. */
export const SETTINGS_HTML = `
<section class="panel" data-section="settings" data-title="设置">
  <div class="section-head">
    <div class="section-lead">
      <h2>运行设置</h2>
      <p>保存后立即生效；设置读取有 10 秒缓存。默认值只在请求未指定尺寸或格式时使用。</p>
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
          <span class="field-label" id="defaultResponseFormat-label">默认响应格式</span>
          <div class="segmented" role="radiogroup" aria-labelledby="defaultResponseFormat-label">
            <label><input type="radio" name="defaultResponseFormat" value="b64_json"><span>b64_json</span></label>
            <label><input type="radio" name="defaultResponseFormat" value="url"><span>url</span></label>
          </div>
        </div>
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
          <label for="defaultRatio">默认比例</label>
          <select class="select" id="defaultRatio" name="defaultRatio">
            <option value="1:1">1:1</option><option value="3:4">3:4</option>
            <option value="4:3">4:3</option><option value="16:9">16:9</option>
            <option value="9:16">9:16</option><option value="2:3">2:3</option>
            <option value="3:2">3:2</option><option value="21:9">21:9</option>
          </select>
        </div>
        <div class="field">
          <span class="field-label" id="imageParamMode-label">参考图参数位置</span>
          <div class="segmented" role="radiogroup" aria-labelledby="imageParamMode-label">
            <label><input type="radio" name="imageParamMode" value="auto"><span>auto</span></label>
            <label><input type="radio" name="imageParamMode" value="nested"><span>nested</span></label>
            <label><input type="radio" name="imageParamMode" value="top_level"><span>top_level</span></label>
          </div>
          <span class="hint">auto 先发嵌套；遇到 400 自动改用顶层，并在 10 分钟内记住可用位置。</span>
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

    <div class="save-bar">
      <span class="form-status" data-role="settings-status">加载中…</span>
      <button class="btn" type="reset">放弃修改</button>
      <button class="btn primary" type="submit">保存设置</button>
    </div>
  </form>
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

  function active() { return section.classList.contains("is-active"); }

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

  function setField(name, value) {
    var fields = form.querySelectorAll('[name="' + name + '"]');
    if (!fields.length) return;
    if (fields[0].type === "radio") {
      for (var i = 0; i < fields.length; i++) {
        fields[i].checked = String(fields[i].value) === String(value);
      }
      return;
    }
    fields[0].value = value;
  }

  var requestId = 0;
  async function load() {
    var id = ++requestId;
    try {
      var settings = await A.api("/admin/api/settings");
      if (id !== requestId) return;
      for (var key in settings) setField(key, settings[key]);
      updateTimeoutHint();
      state.dirty = false;
      state.loaded = true;
      setStatus("已与服务器同步", false);
    } catch (error) {
      if (id !== requestId) return;
      setStatus("读取设置失败", false);
      A.toast(error.message, "error");
    }
  }

  function collect() {
    var names = [
      "agnesBaseUrl", "defaultResponseFormat", "defaultSize", "defaultRatio",
      "imageParamMode", "probeModel",
    ];
    var payload = {};
    for (var i = 0; i < names.length; i++) payload[names[i]] = form.elements.namedItem(names[i]).value;
    payload.probeConcurrency = Number(form.elements.namedItem("probeConcurrency").value);
    payload.requestTimeoutMs = Number(form.elements.namedItem("requestTimeoutMs").value);
    payload.maxAttempts = Number(form.elements.namedItem("maxAttempts").value);
    return payload;
  }

  form.addEventListener("input", function () {
    markDirty();
    updateTimeoutHint();
  });
  form.addEventListener("change", markDirty);

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    var submit = form.querySelector('button[type="submit"]');
    A.setBusy(submit, true, "保存中…");
    try {
      await A.api("/admin/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(collect()),
      });
      A.toast("设置已保存");
      await load();
    } catch (error) {
      setStatus("保存失败", false);
      A.toast(error.message, "error");
    }
    A.setBusy(submit, false);
  });

  form.addEventListener("reset", function (event) {
    event.preventDefault();
    load();
  });

  document.addEventListener("agnes:section", function (event) {
    if (!event.detail || event.detail.name !== "settings" || !active()) return;
    if (!state.loaded || !state.dirty) load();
    else setStatus("有未保存的修改", true);
  });

  updateTimeoutHint();
})();
`;
