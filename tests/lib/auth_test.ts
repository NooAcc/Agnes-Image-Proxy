import { assert, assertFalse } from "@std/assert";
import { createSessionSigner, readCookie, timingSafeEqual } from "../../lib/auth.ts";

Deno.test("session signer accepts its own token and rejects tampering", async () => {
  const signer = createSessionSigner("secret");
  const token = await signer.issue(new Date("2026-01-01T00:00:00Z"));
  assert(await signer.verify(token, new Date("2026-01-02T00:00:00Z")));
  assertFalse(await signer.verify(token + "x", new Date("2026-01-02T00:00:00Z")));
});

Deno.test("session signer rejects an expired token", async () => {
  const signer = createSessionSigner("secret", 60_000);
  const token = await signer.issue(new Date("2026-01-01T00:00:00Z"));
  assertFalse(await signer.verify(token, new Date("2026-01-01T00:02:00Z")));
});

Deno.test("timingSafeEqual does not leak length", () => {
  assertFalse(timingSafeEqual("short", "a-much-longer-secret"));
  assert(timingSafeEqual("same", "same"));
});

Deno.test("readCookie finds a named cookie", () => {
  const request = new Request("https://x/", {
    headers: { cookie: "a=1; agnes_session=abc.def; b=2" },
  });
  assert(readCookie(request, "agnes_session") === "abc.def");
  assert(readCookie(request, "missing") === null);
});
