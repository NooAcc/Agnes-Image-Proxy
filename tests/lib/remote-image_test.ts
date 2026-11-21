import { assertEquals, assertRejects } from "@std/assert";
import { ApiError } from "../../lib/errors.ts";
import {
  fetchImageDimensions,
  isPublicHttpsUrl,
  isPublicHttpUrl,
  tryFetchImageDimensions,
} from "../../lib/remote-image.ts";

Deno.test("https URL safety rejects private and credential-bearing hosts", () => {
  assertEquals(isPublicHttpsUrl("https://example.com/a.png"), true);
  assertEquals(isPublicHttpsUrl("http://example.com/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://127.0.0.1/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://10.0.0.5/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://172.20.0.1/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://192.168.1.1/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://[::1]/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://localhost/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://user:pass@example.com/a.png"), false);
  // A trailing dot is a canonical DNS alias for the same host.
  assertEquals(isPublicHttpsUrl("https://localhost./a.png"), false);
  assertEquals(isPublicHttpsUrl("https://localhost%2e/a.png"), false);
  assertEquals(isPublicHttpsUrl("https://foo.localhost./a.png"), false);
  assertEquals(isPublicHttpsUrl("https://127.0.0.1./a.png"), false);
});

Deno.test("http URL safety allows http and https but still rejects private hosts", () => {
  assertEquals(isPublicHttpUrl("http://example.com/a.png"), true);
  assertEquals(isPublicHttpUrl("https://example.com/a.png"), true);
  assertEquals(isPublicHttpUrl("http://127.0.0.1/a.png"), false);
  assertEquals(isPublicHttpUrl("ftp://example.com/a.png"), false);
});

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

Deno.test("fetchImageDimensions reads a PNG header over https", async () => {
  const fetchImpl = () =>
    Promise.resolve(new Response(pngHeader(900, 1200) as unknown as BodyInit));
  assertEquals(await fetchImageDimensions("https://a.example/x.png", { fetchImpl }), {
    width: 900,
    height: 1200,
  });
});

Deno.test("fetchImageDimensions allows http only when requested", async () => {
  const fetchImpl = () => Promise.resolve(new Response(pngHeader(2, 3) as unknown as BodyInit));
  assertEquals(await fetchImageDimensions("http://a.example/x.png", { fetchImpl }), {
    width: 2,
    height: 3,
  });
  assertEquals(
    await tryFetchImageDimensions("http://a.example/x.png", { fetchImpl, allowHttp: false }),
    null,
  );
});

Deno.test("fetchImageDimensions follows at most two redirects and revalidates targets", async () => {
  let calls = 0;
  const fetchImpl = (input: string | URL | Request) => {
    calls++;
    const url = String(input);
    if (url === "https://a.example/start") {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://b.example/next" } }),
      );
    }
    return Promise.resolve(new Response(pngHeader(2, 3) as unknown as BodyInit));
  };
  assertEquals(await fetchImageDimensions("https://a.example/start", { fetchImpl }), {
    width: 2,
    height: 3,
  });
  assertEquals(calls, 2);
});

Deno.test("redirects to private hosts are rejected without following them", async () => {
  let calls = 0;
  const fetchImpl = () => {
    calls++;
    return Promise.resolve(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/x.png" } }),
    );
  };
  await assertRejects(
    () => fetchImageDimensions("https://a.example/start", { fetchImpl }),
    ApiError,
    "reference image",
  );
  assertEquals(calls, 1);
});

Deno.test("non-image and oversized bodies fail with reference errors", async () => {
  const textFetch = () => Promise.resolve(new Response("not an image"));
  await assertRejects(
    () => fetchImageDimensions("https://a.example/x.txt", { fetchImpl: textFetch }),
    ApiError,
    "reference image",
  );

  const huge = new Uint8Array(1024 * 1024 + 1);
  const hugeFetch = () => Promise.resolve(new Response(huge as unknown as BodyInit));
  await assertRejects(
    () => fetchImageDimensions("https://a.example/huge.png", { fetchImpl: hugeFetch }),
    ApiError,
    "reference image",
  );
});

Deno.test("timeouts and transport errors become reference errors", async () => {
  const timeoutFetch = () => Promise.reject(new DOMException("timeout", "TimeoutError"));
  await assertRejects(
    () => fetchImageDimensions("https://a.example/x.png", { fetchImpl: timeoutFetch }),
    ApiError,
    "reference image",
  );
});
