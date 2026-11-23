/** Shared client for Edge-Images' `/api/batch` endpoint (metadata and enrichment). */

export interface ImageServiceItem {
  uuid: string;
  url?: string;
  base64?: string;
  contentType?: string;
  params: Record<string, unknown>;
}

export interface ImageServiceBatchResult {
  ok: boolean;
  results: Record<string, unknown>;
  error: string | null;
}

export interface ImageServiceOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Posts a top-level JSON array; never throws and reports failures in the result. */
export async function postImageServiceBatch(
  items: ImageServiceItem[],
  options: ImageServiceOptions,
): Promise<ImageServiceBatchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${options.baseUrl}/api/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(items),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, results: {}, error: `image service responded ${response.status}` };
    }
    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, results: {}, error: "image service returned an invalid response" };
    }
    return { ok: true, results: parsed as Record<string, unknown>, error: null };
  } catch (error) {
    return { ok: false, results: {}, error: errorMessage(error) };
  }
}
