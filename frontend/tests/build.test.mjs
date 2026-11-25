import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { build } from "../scripts/build.mjs";
import { renderAdminPage } from "../web/ui.ts";
import { renderLoginPage } from "../web/login.ts";
import { BASE_STYLE } from "../web/styles.ts";

const SECTIONS = ["overview", "gallery", "accounts", "logs", "settings"];

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function assetRefs(html) {
  const refs = [];
  for (const match of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const src = attrs.match(/\bsrc="([^"]*)"/i);
    const href = attrs.match(/\bhref="([^"]*)"/i);
    const value = tag === "script" ? src?.[1] : href?.[1];
    if (value && !value.startsWith("data:")) refs.push(value);
  }
  return refs;
}

async function readOutput(root) {
  const files = new Map();
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else files.set(rel, await readFile(path.join(dir, entry.name)));
    }
  }
  await walk(root, "");
  return files;
}

async function tempDir(name) {
  return mkdtemp(path.join(tmpdir(), `agnes-${name}-`));
}

test("console document restores the five sections and both navigations", () => {
  const html = renderAdminPage();
  for (const id of SECTIONS) {
    assert.match(html, new RegExp(`data-section="${id}"`), `missing data-section ${id}`);
  }
  assert.equal(countMatches(html, /data-nav="/g), 5, "desktop navigation links");
  assert.equal(countMatches(html, /data-bottom-nav="/g), 5, "bottom navigation links");
});

test("console styles keep the original green accent and light theme", () => {
  assert.match(BASE_STYLE, /--accent:\s*#22c55e/);
  assert.match(BASE_STYLE, /\[data-theme="light"\]/);
});

test("login document keeps the password form and no console sections", () => {
  const html = renderLoginPage();
  assert.match(html, /data-role="login-form"/);
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /data-section=/);
  assert.doesNotMatch(html, /data-role="auto-refresh-toggle"/);
});

test("build renders documents with external hashed assets only", async (t) => {
  const out = await tempDir("build");
  t.after(() => rm(out, { recursive: true, force: true }));
  await build(out);

  const files = await readOutput(out);
  const documents = ["index.html", "login.html", "setup.html"];
  for (const doc of documents) {
    assert.ok(files.has(doc), `missing ${doc}`);
  }

  for (const doc of documents) {
    const html = files.get(doc).toString("utf8");
    assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i,
      `${doc} still contains an inline executable script`);
    assert.doesNotMatch(html, /<style\b[^>]*>[\s\S]*?<\/style>/i,
      `${doc} still contains an inline style block`);
    assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//i, `${doc} loads a remote dependency`);
    assert.match(html, /<script[^>]*src="\/admin\/assets\//, `${doc} missing external script`);
    assert.match(html, /<link[^>]*rel="stylesheet"[^>]*href="\/admin\/assets\//, `${doc} missing stylesheet`);
    assert.match(html, /<script[^>]*src="\/admin\/assets\/[^"]+"[^>]*><\/script>\s*<link[^>]*rel="stylesheet"/,
      `${doc} theme script must run before the stylesheet`);

    for (const ref of assetRefs(html)) {
      assert.match(ref, /^\/admin\/assets\//, `${doc} references a non-asset path ${ref}`);
      const name = ref.slice("/admin/assets/".length);
      const match = name.match(/^[a-z0-9._-]+-([0-9a-f]{64})\.(js|css)$/);
      assert.ok(match, `${doc} asset name is not content hashed: ${name}`);
      const data = files.get(`assets/${name}`);
      assert.ok(data, `${doc} references missing asset ${name}`);
      const digest = createHash("sha256").update(data).digest("hex");
      assert.equal(digest, match[1], `hash mismatch for ${name}`);
    }
  }

  for (const [name, data] of files) {
    if (name.endsWith(".js")) {
      assert.doesNotThrow(() => new vm.Script(data.toString("utf8"), { filename: name }),
        `${name} does not parse as JavaScript`);
    }
  }
});

test("build is deterministic across output directories", async (t) => {
  const first = await tempDir("deterministic-a");
  const second = await tempDir("deterministic-b");
  t.after(() => Promise.all([
    rm(first, { recursive: true, force: true }),
    rm(second, { recursive: true, force: true }),
  ]));
  await build(first);
  await build(second);
  const a = await readOutput(first);
  const b = await readOutput(second);
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  for (const [name, data] of a) {
    assert.deepEqual(b.get(name), data, `${name} differs between builds`);
  }
});

test("rebuild removes stale generated assets but keeps unrelated siblings", async (t) => {
  const out = await tempDir("stale");
  t.after(() => rm(out, { recursive: true, force: true }));
  await mkdir(path.join(out, "assets"), { recursive: true });
  const stale = `assets/stale-${"a".repeat(64)}.js`;
  await writeFile(path.join(out, stale), "old");
  await writeFile(path.join(out, "assets", "notes.txt"), "keep me");
  await writeFile(path.join(out, "keep.txt"), "keep me too");

  await build(out);

  const files = await readOutput(out);
  assert.equal(files.has(stale), false, "stale hashed asset should be removed");
  assert.equal(files.get("assets/notes.txt").toString("utf8"), "keep me");
  assert.equal(files.get("keep.txt").toString("utf8"), "keep me too");
  assert.ok(files.has("index.html"));
  assert.ok(files.has("login.html"));
  assert.ok(files.has("setup.html"));
});

test("build refuses unsafe output roots", async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  await assert.rejects(() => build(repoRoot), /unsafe output directory/i);
  await assert.rejects(() => build(path.parse(repoRoot).root), /unsafe output directory/i);
});
