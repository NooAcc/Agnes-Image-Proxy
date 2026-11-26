import assert from "node:assert/strict";
import test from "node:test";

import {
  enrichSummaryText,
  mergeById,
  overviewRanges,
  parseAccountImport,
  safeAdminDestination,
  settingsPayload,
  SETTINGS_FIELDS,
} from "../web/contracts.ts";

test("parseAccountImport trims fields, splits on the first comma and keeps line numbers", () => {
  const parsed = parseAccountImport("a,k1\n\n b,k,2\n");
  assert.deepEqual(parsed.accounts, [
    { name: "a", apiKey: "k1" },
    { name: "b", apiKey: "k,2" },
  ]);
  assert.deepEqual(parsed.lineNumbers, [1, 3]);
  assert.deepEqual(parsed.errors, []);
});

test("parseAccountImport reports original rows without leaking keys", () => {
  const parsed = parseAccountImport("ok,secret-a\nno-comma-secret\n,x-secret\nname,");
  assert.deepEqual(parsed.accounts, [{ name: "ok", apiKey: "secret-a" }]);
  assert.deepEqual(parsed.lineNumbers, [1]);
  assert.deepEqual(parsed.errors.map((error) => error.line), [2, 3, 4]);
  for (const error of parsed.errors) {
    assert.doesNotMatch(error.message, /no-comma-secret|x-secret/);
  }
});

test("parseAccountImport blocks batches over 1000 accounts", () => {
  const lines = Array.from({ length: 1001 }, (_, index) => `n${index},k${index}`).join("\n");
  const parsed = parseAccountImport(lines);
  assert.ok(parsed.errors.length > 0);
  assert.match(parsed.errors.map((error) => error.message).join(" "), /1000/);
});

test("parseAccountImport blocks payloads over 1 MiB", () => {
  const parsed = parseAccountImport(`big,${"k".repeat(1024 * 1024 + 1)}`);
  assert.ok(parsed.errors.length > 0);
  assert.match(parsed.errors.map((error) => error.message).join(" "), /1 MiB/i);
});

test("overviewRanges derives selected and 14-day console date ranges", () => {
  assert.deepEqual(overviewRanges("2026-11-25"), {
    selected: { start: "2026-11-25", end: "2026-11-25" },
    trend: { start: "2026-11-12", end: "2026-11-25" },
  });
  assert.deepEqual(overviewRanges("2024-03-01").trend, { start: "2024-02-17", end: "2024-03-01" });
  assert.deepEqual(overviewRanges("2026-12-31").trend, { start: "2026-12-18", end: "2026-12-31" });
  assert.deepEqual(overviewRanges("2026-01-05").trend, { start: "2025-12-23", end: "2026-01-05" });
  assert.equal(overviewRanges("2026-02-30"), null);
  assert.equal(overviewRanges("not-a-day"), null);
});

test("safeAdminDestination only returns allowlisted console destinations", () => {
  assert.equal(safeAdminDestination("/admin"), "/admin#overview");
  assert.equal(safeAdminDestination("/admin/gallery"), "/admin#gallery");
  assert.equal(safeAdminDestination("/admin#gallery?requestId=preview-seed-1"), "/admin#gallery?requestId=preview-seed-1");
  assert.equal(safeAdminDestination("#gallery?requestId=preview-seed-1"), "/admin#gallery?requestId=preview-seed-1");
  assert.equal(safeAdminDestination("/admin#gallery?requestId=//external.example"), "/admin#overview");
  assert.equal(safeAdminDestination("/admin/api-keys"), "/admin#api-keys");
  assert.equal(safeAdminDestination("#api-keys"), "/admin#api-keys");
  assert.equal(safeAdminDestination("/admin#constructor"), "/admin#overview");
  assert.equal(safeAdminDestination("/admin/accounts#logs"), "/admin#logs");
  assert.equal(safeAdminDestination("/admin/accounts#unknown"), "/admin#accounts");
  assert.equal(safeAdminDestination("#settings"), "/admin#settings");
  assert.equal(safeAdminDestination("/admin#unknown"), "/admin#overview");
  for (const raw of [
    "",
    "https://example.com/admin",
    "//example.com/admin",
    "javascript:alert(1)",
    "/admin/login",
    "/admin/setup",
    "/admin/unknown",
    "/admin/gallery/extra",
    "/admin?x=1",
    "/admin/gallery?next=https://example.com",
    "\\admin\\gallery",
  ]) {
    assert.equal(safeAdminDestination(raw), "/admin#overview", raw);
  }
});

test("settingsPayload always sends all 14 fields and validates the TTL", () => {
  const values = Object.fromEntries(SETTINGS_FIELDS.map((field) => [field, "1"]));
  Object.assign(values, {
    agnesBaseUrl: "https://apihub.agnes-ai.com/v1",
    defaultSize: "2K",
    imageParamMode: "top_level",
    probeModel: "probe",
    imageServiceBaseUrl: "https://images.example.com",
    imagePublicBaseUrl: "https://cdn.example.com",
    imageUrlTtlHours: "24",
    requestTimeoutMs: "300000",
  });
  const payload = settingsPayload(values);
  assert.deepEqual(Object.keys(payload).sort(), [...SETTINGS_FIELDS].sort());
  assert.equal(payload.requestTimeoutMs, 300000);
  assert.equal(payload.imageUrlTtlHours, 24);
  assert.equal(payload.defaultSize, "2K");
  assert.equal(payload.agnesBaseUrl, "https://apihub.agnes-ai.com/v1");

  for (const hours of ["1", "720"]) {
    assert.equal(settingsPayload({ ...values, imageUrlTtlHours: hours }).imageUrlTtlHours, Number(hours));
  }
  for (const hours of ["0", "721", "1.5", "", "abc"]) {
    assert.throws(() => settingsPayload({ ...values, imageUrlTtlHours: hours }), RangeError, hours);
  }
});

test("mergeById prepends new items without duplicates", () => {
  const existing = [{ id: 3 }, { id: 2 }, { id: 1 }];
  const incoming = [{ id: 5 }, { id: 3 }];
  assert.deepEqual(mergeById(existing, incoming).map((item) => item.id), [5, 3, 2, 1]);
  assert.deepEqual(mergeById(existing, []).map((item) => item.id), [3, 2, 1]);
});

test("enrichSummaryText uses the latest cumulative snapshot", () => {
  const first = enrichSummaryText({ processed: 3, succeeded: 2, failed: 1, running: true, error: null });
  const second = enrichSummaryText({ processed: 5, succeeded: 4, failed: 1, running: false, error: null });
  assert.match(first, /3/);
  assert.match(second, /5/);
  assert.doesNotMatch(second, /8/);
});
