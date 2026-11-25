/** Decode existing b64_json originals into local preview Blobs under the unchanged CSP. */
export function generationResultBlob(encoded, win) {
  if (typeof encoded !== "string" || !encoded || encoded.length > Math.ceil(64 * 1024 * 1024 / 3) * 4) {
    throw new Error("生成图片内容无效或超过 64 MiB");
  }
  let raw;
  try { raw = win.atob(encoded); } catch { throw new Error("生成图片编码无效"); }
  if (!raw.length || raw.length > 64 * 1024 * 1024) throw new Error("生成图片内容无效");
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  let mime = "";
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n)) mime = "image/png";
  else if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = "image/jpeg";
  else if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) mime = "image/webp";
  if (!mime) throw new Error("生成图片不是支持的 PNG、JPEG 或 WebP");
  return new win.Blob([bytes], { type: mime });
}

/** Page state lives across section switches, but never in persistent browser storage. */
export function createGenerationController(win, helpers, onChange) {
  const A = win.Agnes;
  const references = helpers.createGenerationReferences(win, (path, options) => A.api(path, options));
  const form = { prompt: "", model: "", n: 1, sizeMode: "tier", tier: "1K", ratio: "1:1", width: 1536, height: 1024 };
  let models = [], results = [], selected = 0, busy = false, error = "", disposed = false, initialized = false, initialization = null;
  function snapshot() {
    return { form: Object.assign({}, form), models: models.slice(), references: references.items, results: results.slice(), selected, busy, error, initialized };
  }
  function notify() { if (!disposed) onChange(snapshot()); }
  function idle() { if (disposed || busy) throw new Error("正在处理，请稍后再试"); }
  function release(list) { list.forEach((item) => win.URL.revokeObjectURL(item.url)); }
  async function initialize() {
    if (initialized || disposed) return;
    if (initialization) return initialization;
    initialization = (async () => {
      try {
        const ready = await A.ready;
        if ((!ready && A.readyState !== "ready") || disposed) return;
        const response = await A.api("/v1/models");
        const settings = await A.api("/admin/api/settings");
        if (disposed) return;
        models = (response.data || []).map((item) => item.id).filter((id) => typeof id === "string" && id.trim());
        if (!form.model) form.model = models[0] || "";
        if (["1K", "2K", "3K", "4K"].includes(settings.defaultSize)) form.tier = settings.defaultSize;
        initialized = true;
        error = "";
      } catch (failure) { error = failure.message || "无法读取模型和默认设置"; }
      finally { initialization = null; notify(); }
    })();
    return initialization;
  }
  async function submit() {
    idle();
    if (!initialized) { await initialize(); if (!initialized) throw new Error("生图配置尚未就绪"); }
    idle();
    let payload;
    try { payload = helpers.generationPayload(form, references.items); }
    catch (failure) { error = failure.message; notify(); throw failure; }
    busy = true; error = ""; notify();
    const incoming = [];
    try {
      const response = await A.api("/admin/api/images/generations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (disposed) return;
      if (!response || !Array.isArray(response.data) || !response.data.length) throw new Error("生图响应未包含图片");
      for (const item of response.data) {
        const blob = helpers.generationResultBlob(item && item.b64_json, win);
        incoming.push({ url: win.URL.createObjectURL(blob), mime: blob.type });
      }
      release(results); results = incoming; selected = 0;
    } catch (failure) {
      release(incoming); error = failure.message || "生图失败"; throw failure;
    } finally { busy = false; notify(); }
  }
  async function add(action) {
    idle(); busy = true; error = ""; notify();
    try { await action(); }
    catch (failure) { error = failure.message; throw failure; }
    finally { busy = false; notify(); }
  }
  return {
    initialize, snapshot, submit,
    setForm(patch) { if (busy || disposed) return; Object.keys(form).forEach((key) => { if (Object.prototype.hasOwnProperty.call(patch, key)) form[key] = patch[key]; }); notify(); },
    addFiles(files) { return add(() => references.addFiles(files)); },
    addURL(url) { return add(() => references.addURL(url)); },
    addGalleryImage(item) { return add(() => references.addGalleryImage(item)); },
    removeReference(id) { idle(); references.remove(id); notify(); },
    moveReference(id, delta) { idle(); references.move(id, delta); notify(); },
    selectResult(index) { if (!disposed && Number.isInteger(index) && index >= 0 && index < results.length) { selected = index; notify(); } },
    clearPreview() { if (disposed) return; release(results); results = []; selected = 0; notify(); },
    isBusy() { return busy; },
    dispose() { if (!disposed) { disposed = true; references.dispose(); release(results); results = []; } },
  };
}
