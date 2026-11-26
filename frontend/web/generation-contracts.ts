/** Build the complete, budgeted image request. Self-contained for browser embedding. */
export function generationPayload(form, references) {
  const prompt = String(form.prompt || "").trim();
  const model = String(form.model || "").trim();
  if (!prompt) throw new Error("请填写提示词");
  if (!model) throw new Error("请选择模型");
  const n = Number(form.n);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("数量必须是正整数");
  if (references.length > 16) throw new Error("最多添加 16 张参考图");
  const payload = { prompt, model, n, size: "", response_format: "b64_json" };
  const tiers = ["1K", "2K", "3K", "4K"];
  const ratios = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"];
  if (form.followReferenceSize) {
    if (!references.length) throw new Error("跟随尺寸需要至少一张参考图");
    payload.size = "auto";
  } else if (form.customSize) {
    const match = String(form.dimensions || "").trim().match(/^(\d{1,6})\s*[xX×]\s*(\d{1,6})$/);
    if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) {
      throw new Error("请按宽x高填写分辨率，例如 1536x1024；宽高必须是 1 至 999999 的整数");
    }
    payload.size = Number(match[1]) + "x" + Number(match[2]);
  } else {
    if (!tiers.includes(form.tier) || !ratios.includes(form.ratio)) throw new Error("请选择支持的分辨率和宽高比");
    payload.size = form.tier;
    payload.ratio = form.ratio;
  }
  if (references.length) payload.images = references.map((item) => item.value);
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 32 * 1024 * 1024) {
    throw new Error("完整请求超过 32 MiB，请减少参考图或提示词");
  }
  return payload;
}

/** Native Agnes expected pixels; final output is still determined upstream. */
export function expectedGenerationSize(tier, ratio) {
  const sizes = {
    "1:1": [1024, 1024], "3:4": [864, 1152], "4:3": [1152, 864],
    "16:9": [1312, 736], "9:16": [736, 1312], "2:3": [832, 1248],
    "3:2": [1248, 832], "21:9": [1568, 672],
  };
  if (!["1K", "2K", "3K", "4K"].includes(tier) || !sizes[ratio]) return null;
  const scale = Number(tier[0]);
  return { width: sizes[ratio][0] * scale, height: sizes[ratio][1] * scale };
}
