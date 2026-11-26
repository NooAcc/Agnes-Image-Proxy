/** Own reference image bytes and local previews. Self-contained for embedding. */
export function createGenerationReferences(win, api) {
  let items = [];
  let nextID = 0;
  let disposed = false;
  let pending = Promise.resolve();
  const maxBytes = 20 * 1024 * 1024;

  function alive() {
    if (disposed) throw new Error("参考图管理已关闭");
  }
  function queue(work) {
    const result = pending.then(() => { alive(); return work(); });
    pending = result.catch(() => {});
    return result;
  }
  function release(list) {
    list.forEach((item) => { if (item.previewURL) win.URL.revokeObjectURL(item.previewURL); });
  }
  function validate(list) {
    if (items.length + list.length > 16) throw new Error("最多添加 16 张参考图");
    const values = items.concat(list).map((item) => item.value);
    if (new win.TextEncoder().encode(JSON.stringify(values)).length > 32 * 1024 * 1024) {
      throw new Error("参考图编码后超过 32 MiB，请减少图片");
    }
  }
  function mimeOf(bytes) {
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
    if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 &&
      bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
    throw new Error("参考图仅支持 PNG、JPEG、WebP");
  }
  async function convert(blob, name, kind, galleryId) {
    if (!blob || blob.size === 0 || blob.size > maxBytes) throw new Error("单张参考图必须非空且不超过 20 MiB");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mime = mimeOf(bytes);
    alive();
    const normalized = new win.Blob([bytes], { type: mime });
    const value = await new Promise((resolve, reject) => {
      const reader = new win.FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("无法读取参考图"));
      reader.readAsDataURL(normalized);
    });
    alive();
    return { id: "reference-" + (++nextID), kind, name, value, previewURL: win.URL.createObjectURL(normalized), bytes: blob.size, galleryId };
  }
  async function addFiles(files) {
    const input = Array.from(files || []);
    return queue(async () => {
      validate(input.map(() => ({ value: "" })));
      const added = [];
      try {
        for (const file of input) added.push(await convert(file, file.name || "参考图", "file"));
        alive();
        validate(added);
        items = items.concat(added);
        return added;
      } catch (error) { release(added); throw error; }
    });
  }
  function addURL(raw) {
    return queue(() => {
      const value = String(raw || "").trim();
      let parsed;
      try { parsed = new URL(value); } catch { throw new Error("请填写有效的 HTTP(S) 图片 URL"); }
      if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
        throw new Error("图片 URL 必须使用 HTTP(S)，且不能包含凭据");
      }
      const item = { id: "reference-" + (++nextID), kind: "url", name: value, value, previewURL: "" };
      validate([item]);
      items = items.concat(item);
      return item;
    });
  }
  function addGalleryImage(image) {
    const galleryId = Number(image.id);
    return queue(async () => {
      if (!Number.isSafeInteger(galleryId) || galleryId < 1) throw new Error("图库图片不可用");
      const duplicate = items.find((item) => item.galleryId === galleryId);
      if (duplicate) return duplicate;
      validate([{ value: "" }]);
      const blob = await api("/admin/api/gallery/" + galleryId + "/content", { responseType: "blob" });
      const item = await convert(blob, "图库图片 " + galleryId, "gallery", galleryId);
      try { alive(); validate([item]); items = items.concat(item); return item; }
      catch (error) { release([item]); throw error; }
    });
  }
  return {
    get items() { return items.map((item) => Object.assign({}, item)); },
    addFiles, addURL, addGalleryImage,
    remove(id) {
      alive();
      release(items.filter((item) => item.id === id));
      items = items.filter((item) => item.id !== id);
    },
    move(id, delta) {
      alive();
      const index = items.findIndex((item) => item.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= items.length) return;
      const item = items.splice(index, 1)[0]; items.splice(target, 0, item);
    },
    clear() { alive(); release(items); items = []; },
    dispose() { if (!disposed) { disposed = true; release(items); items = []; } },
  };
}
