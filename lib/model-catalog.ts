/** Static Agnes image model catalog. Model names are passed through verbatim. */
export const IMAGE_MODELS = [
  "agnes-image-2.5-flash",
  "agnes-image-2.1-flash",
] as const;

export function imageModelList(): string[] {
  return [...IMAGE_MODELS];
}
