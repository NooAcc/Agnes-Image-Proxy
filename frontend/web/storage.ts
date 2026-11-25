import { storageUpdatePayload } from "./setup.ts";

/** Read-only storage mode plus ImgBed connection updates inside settings. */
export const STORAGE_HTML = `
  <div class="card" data-role="storage-card">
    <div class="card-head">
      <div>
        <div class="card-title">原图存储</div>
        <p>存储方式在首次初始化后固定，不能切换；修改图床地址不会迁移已有原图。</p>
      </div>
    </div>
    <div class="form-grid two">
      <div class="field">
        <span class="field-label">存储方式</span>
        <strong data-role="storage-mode">读取中…</strong>
      </div>
      <div class="field">
        <span class="field-label">ImgBed Token</span>
        <span data-role="storage-token-state">—</span>
      </div>
    </div>
    <p class="hint" data-role="storage-local" hidden>原图保存在本服务的持久化数据目录，无需额外配置。</p>
    <div data-role="storage-imgbed" hidden>
      <div class="form-grid two">
        <div class="field">
          <label for="storage-imgbed-base">ImgBed 地址</label>
          <input class="input" id="storage-imgbed-base" data-role="imgbed-base-url" type="url"
            inputmode="url" spellcheck="false" autocomplete="off" placeholder="https://img.example.com">
          <span class="hint">必须是 HTTPS origin；新地址须已经包含同一套文件，本服务不会迁移原图。</span>
        </div>
        <div class="field">
          <label for="storage-imgbed-token">新 Token</label>
          <input class="input" id="storage-imgbed-token" data-role="imgbed-token" type="password"
            autocomplete="new-password" spellcheck="false" placeholder="留空则保持不变">
          <span class="hint">只在轮换 Token 时填写；留空不会清除已保存的 Token，也不会回显旧值。</span>
        </div>
      </div>
    </div>
    <div class="save-bar">
      <span class="form-status" data-role="storage-status">加载中…</span>
      <button class="btn primary" type="button" data-action="save-storage">保存存储配置</button>
    </div>
  </div>`;

export const STORAGE_SCRIPT = String.raw`
(function () {
  "use strict";
  var A = window.Agnes;
  var section = document.querySelector('[data-section="settings"]');
  if (!section) return;
  var storageUpdatePayload = ${storageUpdatePayload.toString()};

  function node(role) { return document.querySelector('[data-role="' + role + '"]'); }

  var baseInput = node("imgbed-base-url");
  var tokenInput = node("imgbed-token");
  var modeNode = node("storage-mode");
  var tokenState = node("storage-token-state");
  var localBox = node("storage-local");
  var imgbedBox = node("storage-imgbed");
  var statusNode = node("storage-status");
  var saveButton = section.querySelector('[data-action="save-storage"]');
  var state = { dirty: false };

  if (baseInput) baseInput.addEventListener("input", function () { state.dirty = true; });
  if (tokenInput) tokenInput.addEventListener("input", function () { state.dirty = true; });

  function setStatus(text) {
    if (statusNode) statusNode.textContent = text;
  }

  function apply(status) {
    if (!status || status.initialized !== true) {
      location.replace("/admin/setup");
      return;
    }
    var isImgbed = status.mode === "imgbed";
    if (modeNode) modeNode.textContent = isImgbed ? "ImgBed 图床" : "本地文件";
    if (localBox) localBox.hidden = isImgbed;
    if (imgbedBox) imgbedBox.hidden = !isImgbed;
    if (isImgbed) {
      if (baseInput && !state.dirty) baseInput.value = status.imgbedBaseUrl || "";
      if (tokenState) tokenState.textContent = status.hasImgbedToken ? "已配置" : "未配置";
    } else if (tokenState) {
      tokenState.textContent = "—";
    }
    setStatus("存储配置已读取");
  }

  async function load(silent) {
    try {
      var status = await A.api("/admin/api/storage");
      apply(status);
      state.dirty = false;
    } catch (error) {
      if (error && error.status === 401) return;
      setStatus("读取存储配置失败");
      if (!silent) A.toast(error.message, "error");
    }
  }

  if (saveButton) {
    saveButton.addEventListener("click", async function () {
      var payload = storageUpdatePayload(baseInput ? baseInput.value : "", tokenInput ? tokenInput.value : "");
      A.setBusy(saveButton, true, "保存中…");
      try {
        var status = await A.api("/admin/api/storage", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        state.dirty = false;
        if (tokenInput) tokenInput.value = "";
        apply(status);
        document.dispatchEvent(new CustomEvent("agnes:storage", { detail: status }));
        A.toast("存储配置已保存");
      } catch (error) {
        var code = error && error.body && error.body.error && error.body.error.code;
        if (code === "not_initialized") {
          A.toast("存储尚未初始化，正在转到初始化页面", "error");
          location.replace("/admin/setup");
        } else if (code === "storage_mode_fixed") {
          A.toast("存储方式已固定，正在重新读取实际配置", "error");
          await load(true);
        } else {
          A.toast(error.message, "error");
        }
      }
      A.setBusy(saveButton, false);
    });
  }

  load(true);
})();
`;
