import assert from "node:assert/strict";
import test from "node:test";

import {
  renderSetupPage,
  storageInitPayload,
  storageUpdatePayload,
} from "../web/setup.ts";
import { STORAGE_HTML } from "../web/storage.ts";

test("local initialization sends only the mode", () => {
  assert.deepEqual(storageInitPayload("local", "https://ignored.example", "secret"), {
    mode: "local",
  });
});

test("imgbed initialization sends exactly the three fields", () => {
  assert.deepEqual(storageInitPayload("imgbed", " https://img.example.com/ ", " token "), {
    mode: "imgbed",
    imgbedBaseUrl: "https://img.example.com/",
    imgbedToken: "token",
  });
});

test("an empty or missing selection cannot build a payload", () => {
  assert.throws(() => storageInitPayload("", "", ""), /选择/);
});

test("storage updates omit a blank token and never send null", () => {
  assert.deepEqual(storageUpdatePayload("https://img.example.com", ""), {
    imgbedBaseUrl: "https://img.example.com",
  });
  assert.deepEqual(storageUpdatePayload("https://img.example.com", "   "), {
    imgbedBaseUrl: "https://img.example.com",
  });
  assert.deepEqual(storageUpdatePayload("https://img.example.com", "new-token"), {
    imgbedBaseUrl: "https://img.example.com",
    imgbedToken: "new-token",
  });
  const payload = storageUpdatePayload("https://img.example.com", null);
  assert.equal("imgbedToken" in payload, false);
  assert.equal(JSON.stringify(payload).includes("null"), false);
});

test("setup document requires an explicit choice and hides the console", () => {
  const html = renderSetupPage();
  assert.match(html, /data-role="setup-form"/);
  assert.match(html, /name="mode" value="local"/);
  assert.match(html, /name="mode" value="imgbed"/);
  assert.doesNotMatch(html, /<input[^>]*name="mode"[^>]*\bchecked\b/);
  assert.match(html, /data-role="setup-submit"[^>]*disabled/);
  assert.match(html, /data-role="imgbed-fields"[^>]*hidden/);
  assert.match(html, /不能切换|不可更改|固定/);
  assert.doesNotMatch(html, /data-section=/);
  assert.doesNotMatch(html, /PROXY_API_KEY/);
});

test("storage settings markup covers both fixed modes without echoing tokens", () => {
  assert.match(STORAGE_HTML, /data-role="storage-mode"/);
  assert.match(STORAGE_HTML, /data-role="storage-local"/);
  assert.match(STORAGE_HTML, /data-role="storage-imgbed"[^>]*hidden/);
  assert.match(STORAGE_HTML, /data-role="imgbed-base-url"/);
  assert.match(STORAGE_HTML, /data-role="imgbed-token"/);
  assert.match(STORAGE_HTML, /data-role="storage-token-state"/);
  assert.match(STORAGE_HTML, /data-action="save-storage"/);
  assert.doesNotMatch(STORAGE_HTML, /type="password"[^>]*value=/);
  assert.match(STORAGE_HTML, /不会迁移|不迁移/);
});
