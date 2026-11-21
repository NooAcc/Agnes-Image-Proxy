import { ApiError } from "./errors.ts";

export const SIZE_TIERS = ["1K", "2K", "3K", "4K"] as const;
export type SizeTier = (typeof SIZE_TIERS)[number];

export const RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"] as const;
export type Ratio = (typeof RATIOS)[number];

export interface PixelSize {
  width: number;
  height: number;
}

export type SizeMode = "tier" | "exact";

export interface ResolvedSize {
  mode: SizeMode;
  tier: SizeTier;
  ratio: Ratio | null;
  derivedRatio: Ratio;
  pixel: PixelSize;
  requestedPixel: PixelSize | null;
}

/**
 * Native Agnes size table. 1K is the base; 2K/3K/4K are the documented
 * scale factors (2×/3×/4×) over the same aspect ratios.
 */
const BASE_SIZES: Record<Ratio, PixelSize> = {
  "1:1": { width: 1024, height: 1024 },
  "3:4": { width: 864, height: 1152 },
  "4:3": { width: 1152, height: 864 },
  "16:9": { width: 1312, height: 736 },
  "9:16": { width: 736, height: 1312 },
  "2:3": { width: 832, height: 1248 },
  "3:2": { width: 1248, height: 832 },
  "21:9": { width: 1568, height: 672 },
};

const TIER_SCALE: Record<SizeTier, number> = { "1K": 1, "2K": 2, "3K": 3, "4K": 4 };
const TIER_AREA: Record<SizeTier, number> = {
  "1K": 1024 * 1024,
  "2K": 2048 * 2048,
  "3K": 3072 * 3072,
  "4K": 4096 * 4096,
};

export function isSizeTier(value: unknown): value is SizeTier {
  return typeof value === "string" &&
    (SIZE_TIERS as readonly string[]).includes(value.trim().toUpperCase());
}

export function isRatio(value: unknown): value is Ratio {
  return typeof value === "string" && (RATIOS as readonly string[]).includes(value.trim());
}

function ratioValue(ratio: Ratio): number {
  const [w, h] = ratio.split(":").map(Number);
  return w / h;
}

function nearestRatio(aspect: number): Ratio {
  let best: Ratio = "1:1";
  let bestDistance = Infinity;
  for (const ratio of RATIOS) {
    const distance = Math.abs(Math.log(aspect / ratioValue(ratio)));
    if (distance < bestDistance) {
      best = ratio;
      bestDistance = distance;
    }
  }
  return best;
}

function nearestTier(area: number): SizeTier {
  let best: SizeTier = "1K";
  let bestDistance = Infinity;
  for (const tier of SIZE_TIERS) {
    const distance = Math.abs(Math.log(area / TIER_AREA[tier]));
    if (distance < bestDistance) {
      best = tier;
      bestDistance = distance;
    }
  }
  return best;
}

function parsePixelSize(value: string): PixelSize | null {
  const match = /^(\d{1,6})\s*[x×]\s*(\d{1,6})$/i.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1) return null;
  return { width, height };
}

export interface ResolveSizeInput {
  size?: string | null;
  ratio?: string | null;
  reference?: PixelSize | null;
}

function scaledPixel(ratio: Ratio, tier: SizeTier): PixelSize {
  const base = BASE_SIZES[ratio];
  const scale = TIER_SCALE[tier];
  return { width: base.width * scale, height: base.height * scale };
}

/**
 * Translates any client size (tier, WxH or auto) into the Agnes tier/ratio
 * pair plus the native pixel dimensions for that pair. When `auto` is paired
 * with a reference image, `exact` mode keeps the reference pixel size for the
 * upstream request while still deriving a tier and ratio for metadata.
 */
export function resolveSize(input: ResolveSizeInput): ResolvedSize {
  const rawSize = input.size?.trim();
  const reference = input.reference ?? null;

  let explicitRatio: Ratio | null = null;
  const rawRatio = input.ratio?.trim();
  if (rawRatio) {
    if (!isRatio(rawRatio)) {
      throw new ApiError(
        400,
        `unsupported ratio: ${rawRatio}`,
        "invalid_request_error",
        "ratio",
        "invalid_ratio",
      );
    }
    explicitRatio = rawRatio;
  }

  const isAuto = !rawSize || rawSize.toLowerCase() === "auto";

  if (isAuto && reference) {
    const tier = nearestTier(reference.width * reference.height);
    const derivedRatio = nearestRatio(reference.width / reference.height);
    return {
      mode: "exact",
      tier,
      ratio: explicitRatio,
      derivedRatio,
      pixel: scaledPixel(derivedRatio, tier),
      requestedPixel: { width: reference.width, height: reference.height },
    };
  }

  let tier: SizeTier;
  let inferredRatio: Ratio = "1:1";
  let ratio: Ratio | null = explicitRatio;

  if (isAuto) {
    tier = "1K";
    if (reference) inferredRatio = nearestRatio(reference.width / reference.height);
  } else if (isSizeTier(rawSize)) {
    tier = rawSize.toUpperCase() as SizeTier;
    if (reference) inferredRatio = nearestRatio(reference.width / reference.height);
  } else {
    const pixel = parsePixelSize(rawSize);
    if (!pixel) {
      throw new ApiError(
        400,
        `unsupported size: ${rawSize}`,
        "invalid_request_error",
        "size",
        "invalid_size",
      );
    }
    tier = nearestTier(pixel.width * pixel.height);
    inferredRatio = nearestRatio(pixel.width / pixel.height);
    ratio = explicitRatio ?? inferredRatio;
  }

  return {
    mode: "tier",
    tier,
    ratio,
    derivedRatio: explicitRatio ?? inferredRatio,
    pixel: scaledPixel(ratio ?? "1:1", tier),
    requestedPixel: null,
  };
}

export function formatPixel(size: PixelSize): string {
  return `${size.width}x${size.height}`;
}

/** Renders how the upstream size was requested, for headers and logs. */
export function formatRequestSize(size: ResolvedSize): string {
  if (size.mode === "exact" && size.requestedPixel) return formatPixel(size.requestedPixel);
  return size.ratio ? `${size.tier} ${size.ratio}` : size.tier;
}
