export type SizeMode = "tier" | "exact";

export interface ImageModel {
  id: string;
  sizeMode: SizeMode;
  label: string;
}

/** Static Agnes image model catalog. Model names are passed through verbatim. */
export const IMAGE_MODELS: readonly ImageModel[] = [
  { id: "agnes-image-2.5-flash", sizeMode: "tier", label: "Agnes Image 2.5 Flash" },
  { id: "agnes-image-2.1-flash", sizeMode: "tier", label: "Agnes Image 2.1 Flash" },
  { id: "agnes-image-2.0-flash", sizeMode: "exact", label: "Agnes Image 2.0 Flash" },
];

export function imageModelList(): ImageModel[] {
  return IMAGE_MODELS.map((model) => ({ ...model }));
}

/** Unknown models are forwarded verbatim and treated as tier models. */
export function sizeModeFor(model: string): SizeMode {
  return IMAGE_MODELS.find((entry) => entry.id === model)?.sizeMode ?? "tier";
}

export function isKnownModel(model: string): boolean {
  return IMAGE_MODELS.some((entry) => entry.id === model);
}
