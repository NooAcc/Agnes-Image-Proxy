import { icon } from "./icons.ts";
import { generationPayload, expectedGenerationSize } from "./generation-contracts.ts";
import { createGenerationReferences } from "./generation-references.ts";
import { createGenerationController, generationResultBlob } from "./generation-controller.ts";

export const GENERATION_HTML = `
<section class="panel" data-section="generate" data-title="生图控制台">
  <div class="generation-layout">
    <div class="card generation-config">
      <div class="generation-heading"><div><span class="eyebrow">CREATE</span><h2>创建生图</h2></div>
        <button class="btn primary" type="submit" form="generation-form" data-role="generation-submit">${icon("bolt")}开始生成</button>
      </div>
      <form id="generation-form" class="generation-form" data-role="generation-form">
        <fieldset data-role="generation-fields">
          <div class="generation-field"><label for="generation-prompt">提示词</label><textarea class="input" id="generation-prompt" name="prompt" rows="6" required placeholder="描述主体、场景、风格、光线和构图…"></textarea></div>
          <div class="generation-parameters">
            <div class="generation-field"><label for="generation-model">模型</label><select class="input" id="generation-model" name="model" required><option value="">正在读取模型…</option></select></div>
            <div class="generation-field"><label for="generation-count">数量</label><input class="input" id="generation-count" name="n" type="number" min="1" step="1" value="1" required></div>
            <div class="generation-field"><label for="generation-ratio">宽高比</label><select class="input" id="generation-ratio" name="ratio">${["1:1","3:4","4:3","16:9","9:16","2:3","3:2","21:9"].map((value) => `<option>${value}</option>`).join("")}</select></div>
            <div class="generation-field generation-resolution"><label id="generation-resolution-label" for="generation-tier" data-role="generation-resolution-label">分辨率</label><div class="generation-resolution-controls"><div class="generation-resolution-input"><select class="input" id="generation-tier" name="tier" aria-labelledby="generation-resolution-label">${["1K","2K","3K","4K"].map((value) => `<option>${value}</option>`).join("")}</select><input class="input" id="generation-dimensions" name="dimensions" type="text" value="1536x1024" placeholder="1536x1024" aria-labelledby="generation-resolution-label" aria-describedby="generation-size-hint" hidden disabled></div><label class="generation-size-toggle"><input type="checkbox" name="customSize" aria-controls="generation-dimensions" aria-describedby="generation-size-hint">自定义尺寸</label></div></div>
          </div>
          <p class="generation-hint" id="generation-size-hint" data-role="generation-size-hint"></p>
          <div class="generation-reference-head"><div class="generation-reference-title"><span class="generation-reference-label">参考图 <span class="generation-hint">可选</span></span><label class="generation-follow-size"><input type="checkbox" name="followReferenceSize" aria-describedby="generation-size-hint">跟随第一张参考图</label></div><div class="generation-reference-actions">
            <button class="btn small" type="button" data-action="generation-gallery">${icon("image")}从图库选择</button>
            <button class="btn small" type="button" data-action="generation-url">${icon("plus")}添加图片 URL</button>
          </div></div>
          <button class="generation-drop" data-role="generation-drop" type="button" aria-labelledby="generation-drop-label" aria-describedby="generation-paste-hint generation-reference-hint"><strong id="generation-drop-label">点击或拖拽上传参考图</strong><span class="generation-hint" id="generation-paste-hint">也可在本页按 Ctrl+V 粘贴图片</span></button>
          <input id="generation-files" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>
          <p class="generation-hint" id="generation-reference-hint">PNG / JPEG / WebP · 最多 16 张 · 单张 20 MiB · 完整请求 32 MiB</p>
          <div class="generation-references" data-role="generation-references"></div>
          <p class="generation-hint" data-role="generation-reference-count">未添加参考图</p>
        </fieldset>
        <p class="generation-error" data-role="generation-error" role="alert" tabindex="-1" hidden></p>
        <p class="generation-footnote">生成图片自动归档到“图片”，请求记录在“日志”。再次生成时保留配置。</p>
      </form>
    </div>
    <div class="card generation-result" data-role="generation-result">
      <div class="generation-heading"><h2>生成图片</h2><button class="btn small" type="button" data-action="generation-clear" title="清空提示词、参考图和预览，并恢复默认生图参数">清空预览</button></div>
      <div class="generation-preview-body">
        <div class="generation-empty" data-role="generation-empty">${icon("image")}<strong>生成的图片将在这里显示</strong><span>多张图片可通过下方数字按钮切换。</span></div>
        <div class="generation-preview" data-role="generation-preview" hidden><img data-role="generation-image" alt="生成图片"></div>
        <p class="generation-hint generation-preview-error" data-role="generation-preview-error" hidden>图片无法显示，请到“图片”板块查看归档原图。</p>
        <div class="generation-numbers" data-role="generation-numbers" role="group" aria-label="切换生成图片" hidden></div>
      </div>
    </div>
  </div>
</section>`;

export const GENERATION_DIALOGS = `
<dialog data-role="generation-url-dialog" aria-labelledby="generation-url-title"><div class="dialog-body"><div class="dialog-head"><h2 id="generation-url-title">添加图片 URL</h2><button class="btn small" type="button" data-action="generation-dialog-close" aria-label="关闭">${icon("close")}</button></div><form data-role="generation-url-form"><label class="generation-dialog-label" for="generation-url-input">HTTP(S) 图片地址</label><input class="input" id="generation-url-input" type="url" required placeholder="https://example.com/image.png"><p class="generation-hint">远程图片以地址占位，上游会读取参考图；不会从浏览器跨源加载。</p><div class="dialog-actions"><button class="btn primary" type="submit">添加参考图</button></div></form></div></dialog>
<dialog class="generation-picker" data-role="generation-gallery-dialog" aria-labelledby="generation-gallery-title"><div class="dialog-body"><div class="dialog-head"><h2 id="generation-gallery-title">从图库选择参考图</h2><button class="btn small" type="button" data-action="generation-dialog-close" aria-label="关闭">${icon("close")}</button></div><input class="input" data-role="generation-gallery-search" type="search" aria-label="搜索已加载图库图片" placeholder="搜索已加载图片的提示词或模型…"><div class="generation-picker-grid" data-role="generation-gallery-grid"></div><p class="generation-hint" data-role="generation-gallery-status" aria-live="polite"></p><button class="btn" type="button" data-action="generation-gallery-more">加载更多</button></div></dialog>
<dialog class="generation-reference-dialog" data-role="generation-reference-dialog" aria-labelledby="generation-reference-title"><div class="dialog-body"><div class="dialog-head"><h2 id="generation-reference-title">参考图预览</h2><button class="btn small" type="button" data-action="generation-dialog-close" aria-label="关闭">${icon("close")}</button></div><img data-role="generation-reference-image" alt="参考图"></div></dialog>`;

/** DOM adapter kept separate from testable request/reference state. */
export function mountGeneration(win, helpers) {
  const doc = win.document, A = win.Agnes;
  const section = doc.querySelector('[data-section="generate"]');
  if (!section) return null;
  const find = (role) => section.querySelector('[data-role="' + role + '"]');
  const formNode = find("generation-form"), fields = find("generation-fields"), submit = find("generation-submit");
  const errorBox = find("generation-error"), refsNode = find("generation-references"), image = find("generation-image"), numbers = find("generation-numbers");
  let previousModels = "", referenceKey = "", resultKey = "", wasBusy = false;
  const controller = helpers.createGenerationController(win, helpers, render);
  function render(state) {
    for (const key of Object.keys(state.form)) {
      const input = formNode.elements.namedItem(key);
      if (input && input.type === "checkbox") input.checked = Boolean(state.form[key]);
      else if (input && input.value !== String(state.form[key])) input.value = state.form[key];
    }
    const modelsKey = JSON.stringify(state.models);
    if (modelsKey !== previousModels) {
      previousModels = modelsKey;
      const select = formNode.elements.namedItem("model"); select.replaceChildren();
      if (!state.models.length) select.append(A.el("option", "", "没有可用模型"));
      state.models.forEach((id) => { const option = A.el("option", "", id); option.value = id; select.append(option); });
      select.value = state.form.model;
    }
    fields.disabled = state.busy;
    if (state.busy !== wasBusy) { A.setBusy(submit, state.busy, "生成中…"); wasBusy = state.busy; }
    submit.disabled = state.busy || !state.initialized || !state.form.model;
    errorBox.textContent = state.error; errorBox.hidden = !state.error;
    const mode = state.form.followReferenceSize ? "auto" : state.form.customSize ? "custom" : "tier";
    formNode.elements.namedItem("customSize").disabled = state.form.followReferenceSize;
    section.querySelector('[data-action="generation-clear"]').disabled = state.busy;
    const tier = formNode.elements.namedItem("tier"), dimensions = formNode.elements.namedItem("dimensions");
    tier.disabled = mode !== "tier"; tier.hidden = state.form.customSize;
    dimensions.disabled = mode !== "custom"; dimensions.hidden = !state.form.customSize;
    find("generation-resolution-label").htmlFor = state.form.customSize ? dimensions.id : tier.id;
    formNode.elements.namedItem("ratio").disabled = mode !== "tier";
    const pixels = helpers.expectedGenerationSize(state.form.tier, state.form.ratio);
    find("generation-size-hint").textContent = mode === "auto" ? "使用第一张参考图尺寸，需要至少一张参考图。" : mode === "custom" ? "输入宽×高，例如 1536x1024；尺寸归一化到最近支持的档位与比例，实际尺寸以上游为准。" : (pixels ? "预计尺寸 " + pixels.width + " × " + pixels.height + " px，实际输出以上游为准。" : "");
    const key = state.references.map((item) => item.id).join(",") + state.busy;
    if (referenceKey !== key) {
      referenceKey = key; refsNode.replaceChildren();
      state.references.forEach((item, index) => {
        const card = A.el("div", "generation-reference");
        const thumb = A.el("button", "generation-reference-thumb"); thumb.type = "button"; thumb.disabled = state.busy || !item.previewURL; thumb.setAttribute("aria-label", "预览参考图 " + (index + 1));
        if (item.previewURL) { const img = A.el("img"); img.src = item.previewURL; img.alt = item.name; thumb.append(img); thumb.addEventListener("click", () => referencePreview(item)); }
        else thumb.append(A.icon("image"));
        card.append(thumb, A.el("div", "generation-reference-name", item.name));
        if (item.bytes) card.append(A.el("span", "generation-hint", (item.bytes / 1048576).toFixed(2) + " MiB"));
        const actions = A.el("div", "generation-reference-controls");
        for (const [label, action, disabled] of [["向前", () => controller.moveReference(item.id, -1), index === 0], ["向后", () => controller.moveReference(item.id, 1), index === state.references.length - 1], ["移除", () => controller.removeReference(item.id), false]]) {
          const button = A.el("button", "btn small", label); button.type = "button"; button.disabled = state.busy || disabled; button.setAttribute("aria-label", label + "参考图 " + (index + 1)); button.addEventListener("click", action); actions.append(button);
        }
        card.append(actions); refsNode.append(card);
      });
    }
    find("generation-reference-count").textContent = state.references.length ? "已添加 " + state.references.length + " 张参考图" : "未添加参考图";
    find("generation-empty").hidden = state.results.length > 0; find("generation-preview").hidden = !state.results.length;
    numbers.hidden = state.results.length < 2;
    const current = state.results[state.selected];
    if (current && image.getAttribute("src") !== current.url) { image.src = current.url; image.alt = "第 " + (state.selected + 1) + " 张生成图片"; find("generation-preview-error").hidden = true; }
    else if (!current) { image.removeAttribute("src"); find("generation-preview-error").hidden = true; }
    const nextKey = state.results.map((item) => item.url).join(",") + ":" + state.selected;
    if (resultKey !== nextKey) {
      resultKey = nextKey; numbers.replaceChildren();
      state.results.forEach((_item, index) => { const button = A.el("button", "btn generation-number", String(index + 1)); button.type = "button"; button.setAttribute("aria-label", "显示第 " + (index + 1) + " 张图片"); button.setAttribute("aria-pressed", String(index === state.selected)); button.addEventListener("click", () => controller.selectResult(index)); numbers.append(button); });
    }
    doc.dispatchEvent(new win.CustomEvent("agnes:generation-busy", { detail: { busy: state.busy } }));
  }
  function failure(error) { if (errorBox.hidden) A.toast(error.message || "操作失败", "error"); else errorBox.focus(); }
  function run(work) { return work().catch(failure); }
  function updateForm(event) {
    const input = event.target;
    if (input.name) controller.setForm({ [input.name]: input.type === "checkbox" ? input.checked : input.value });
  }
  formNode.addEventListener("input", updateForm);
  formNode.addEventListener("change", updateForm);
  formNode.addEventListener("submit", (event) => { event.preventDefault(); run(() => controller.submit()); });
  const drop = find("generation-drop"), fileInput = doc.getElementById("generation-files");
  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("dragover", (event) => { event.preventDefault(); });
  drop.addEventListener("drop", (event) => { event.preventDefault(); if (event.dataTransfer.files.length) run(() => controller.addFiles(event.dataTransfer.files)); });
  fileInput.addEventListener("change", () => { const files = Array.from(fileInput.files); fileInput.value = ""; if (files.length) run(() => controller.addFiles(files)); });
  // With no focused control, the paste event targets the document body, not the panel.
  doc.addEventListener("paste", (event) => {
    const clipboard = event.clipboardData;
    if (!clipboard || event.defaultPrevented || !section.classList.contains("is-active") || doc.querySelector("dialog[open]")) return;
    let files = Array.from(clipboard.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile()).filter(Boolean);
    if (!files.length) files = Array.from(clipboard.files || []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    run(() => controller.addFiles(files));
  });
  image.addEventListener("error", () => { find("generation-preview-error").hidden = !controller.snapshot().results.length; });
  section.querySelector('[data-action="generation-clear"]').addEventListener("click", () => {
    if (controller.isBusy()) return;
    controller.clearPreview();
    fileInput.value = "";
    doc.getElementById("generation-url-input").value = "";
    picker.querySelector("input").value = "";
  });
  const urlDialog = doc.querySelector('[data-role="generation-url-dialog"]');
  section.querySelector('[data-action="generation-url"]').addEventListener("click", () => { if (!controller.isBusy()) urlDialog.showModal(); });
  urlDialog.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); const input = doc.getElementById("generation-url-input"); controller.addURL(input.value).then(() => { input.value = ""; urlDialog.close(); }).catch((error) => A.toast(error.message, "error")); });
  doc.querySelectorAll('[data-action="generation-dialog-close"]').forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  function referencePreview(item) { const dialog = doc.querySelector('[data-role="generation-reference-dialog"]'); dialog.querySelector("img").src = item.previewURL; dialog.showModal(); }
  const referenceDialog = doc.querySelector('[data-role="generation-reference-dialog"]'); referenceDialog.addEventListener("close", () => referenceDialog.querySelector("img").removeAttribute("src"));
  const picker = doc.querySelector('[data-role="generation-gallery-dialog"]'), pickerGrid = picker.querySelector('[data-role="generation-gallery-grid"]'), pickerStatus = picker.querySelector('[data-role="generation-gallery-status"]'), more = picker.querySelector('[data-action="generation-gallery-more"]');
  let galleryItems = [], cursor = null, galleryLoading = false;
  function renderPicker() {
    const query = picker.querySelector("input").value.trim().toLowerCase(); pickerGrid.replaceChildren();
    galleryItems.filter((item) => (item.prompt + " " + item.model).toLowerCase().includes(query)).forEach((item) => {
      const button = A.el("button", "generation-picker-item"); button.type = "button"; button.disabled = controller.isBusy(); button.setAttribute("aria-label", "选择图库图片 " + item.id);
      const img = A.el("img"); img.src = "/admin/api/gallery/" + item.id + "/thumbnail"; img.alt = ""; img.loading = "lazy"; img.addEventListener("error", () => { img.removeAttribute("src"); img.hidden = true; }, { once: true });
      button.append(img, A.el("span", "", item.prompt || "图库图片 " + item.id));
      button.addEventListener("click", () => { const snapshot = Object.assign({}, item); controller.addGalleryImage(snapshot).then(() => picker.close()).catch((error) => A.toast(error.message, "error")); renderPicker(); }); pickerGrid.append(button);
    });
  }
  async function loadGallery(reset) {
    if (galleryLoading) return; galleryLoading = true; more.disabled = true; pickerStatus.textContent = "正在读取图库…";
    if (reset) { galleryItems = []; cursor = null; }
    try { const page = await A.api("/admin/api/gallery?limit=24" + (cursor ? "&before=" + cursor : "")); galleryItems = galleryItems.concat(page.items || []); cursor = page.nextBefore; more.hidden = cursor == null; renderPicker(); pickerStatus.textContent = galleryItems.length ? "点击图片添加原图，不会覆盖已填写的提示词。" : "图库中还没有图片"; }
    catch (error) { pickerStatus.textContent = error.message; }
    finally { galleryLoading = false; more.disabled = false; }
  }
  section.querySelector('[data-action="generation-gallery"]').addEventListener("click", () => { if (controller.isBusy()) return; picker.showModal(); loadGallery(true); });
  more.addEventListener("click", () => loadGallery(false)); picker.querySelector("input").addEventListener("input", renderPicker);
  doc.addEventListener("agnes:generation-busy", () => { if (picker.open) renderPicker(); });
  A.generation = { addGalleryImage: (item) => controller.addGalleryImage(item), isBusy: () => controller.isBusy() };
  win.addEventListener("pagehide", () => controller.dispose(), { once: true });
  // A cached page has already released its previews and pending controller.
  // Reboot on restoration rather than exposing a permanently disposed form.
  win.addEventListener("pageshow", (event) => { if (event.persisted) win.location.reload(); });
  doc.addEventListener("agnes:ready", () => controller.initialize());
  doc.addEventListener("agnes:section", (event) => { if (event.detail.name === "generate") controller.initialize(); });
  render(controller.snapshot()); controller.initialize();
  return controller;
}

export const GENERATION_SCRIPT = `
(function () {
  var generationPayload = ${generationPayload.toString()};
  var expectedGenerationSize = ${expectedGenerationSize.toString()};
  var createGenerationReferences = ${createGenerationReferences.toString()};
  var generationResultBlob = ${generationResultBlob.toString()};
  var createGenerationController = ${createGenerationController.toString()};
  var mountGeneration = ${mountGeneration.toString()};
  mountGeneration(window, { generationPayload: generationPayload, expectedGenerationSize: expectedGenerationSize, createGenerationReferences: createGenerationReferences, generationResultBlob: generationResultBlob, createGenerationController: createGenerationController });
})();`;
