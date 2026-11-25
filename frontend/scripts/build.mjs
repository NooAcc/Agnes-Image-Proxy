import { createHash } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderLoginPage } from "../web/login.ts";
import * as ui from "../web/ui.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const defaultOutput = path.resolve(repoRoot, "internal/webassets/dist");
const generatedAsset = /-[0-9a-f]{64}\.(?:js|css)$/;

function sha256(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function documentPages() {
  const pages = new Map([
    ["index.html", ui.renderAdminPage()],
    ["login.html", renderLoginPage()],
  ]);
  // The setup document joins the build once its renderer exists.
  if (typeof ui.renderSetupPage === "function") {
    pages.set("setup.html", ui.renderSetupPage());
  }
  return pages;
}

function extractAssets(documentName, html) {
  const assets = [];
  const counters = { js: 0, css: 0 };
  let output = html.replace(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi, (_match, body) => {
    counters.css += 1;
    const name = `${documentName}-style-${counters.css}-${sha256(body)}.css`;
    assets.push({ name, body });
    return `<link rel="stylesheet" href="/admin/assets/${name}">`;
  });
  output = output.replace(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi, (_match, attrs = "", body) => {
    if (/\bsrc\s*=/i.test(attrs)) {
      throw new Error(`build: ${documentName} already references an external script`);
    }
    counters.js += 1;
    const name = `${documentName}-script-${counters.js}-${sha256(body)}.js`;
    assets.push({ name, body });
    return `<script src="/admin/assets/${name}"></script>`;
  });
  return { output, assets };
}

function validateDocument(documentName, html, assets) {
  if (!/^<!doctype html>/i.test(html.trimStart())) {
    throw new Error(`build: ${documentName} is not a complete HTML document`);
  }
  if (/<style\b[^>]*>[\s\S]*?<\/style>/i.test(html)) {
    throw new Error(`build: ${documentName} still contains an inline style block`);
  }
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=/.test(match[1])) {
      throw new Error(`build: ${documentName} still contains an inline executable script`);
    }
    if (match[2].trim() !== "") {
      throw new Error(`build: ${documentName} script tag has both src and content`);
    }
  }
  const known = new Set(assets.map((asset) => `/admin/assets/${asset.name}`));
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)) {
    const ref = match[1];
    if (ref.startsWith("data:") || ref.startsWith("#")) continue;
    if (ref.startsWith("/admin/assets/")) {
      if (!known.has(ref)) throw new Error(`build: ${documentName} references unknown asset ${ref}`);
      continue;
    }
    if (/^(?:[a-z]+:)?\/\//i.test(ref)) {
      throw new Error(`build: ${documentName} references a remote dependency ${ref}`);
    }
    if (ref.startsWith("/admin/")) continue;
    throw new Error(`build: ${documentName} references an unexpected path ${ref}`);
  }
}

function assertSafeOutput(outputDir) {
  const resolved = path.resolve(outputDir);
  const root = path.parse(resolved).root;
  const home = path.resolve(os.homedir());
  const isAncestor = repoRoot === resolved || repoRoot.startsWith(resolved + path.sep);
  if (
    resolved === root ||
    resolved === home ||
    isAncestor ||
    resolved.split(path.sep).includes(".git")
  ) {
    throw new Error(`build: unsafe output directory ${resolved}`);
  }
  return resolved;
}

async function removeStaleAssets(assetsDir, generated) {
  let entries;
  try {
    entries = await readdir(assetsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && generatedAsset.test(entry.name) && !generated.has(entry.name))
      .map((entry) => unlink(path.join(assetsDir, entry.name))),
  );
}

/** Render and write the console documents and their content-hashed assets. */
export async function build(outputDir = defaultOutput) {
  const out = assertSafeOutput(outputDir);
  const assetsDir = path.join(out, "assets");
  const documents = [];
  const assets = [];

  for (const [name, html] of documentPages()) {
    const extracted = extractAssets(name.replace(/\.html$/, ""), html);
    validateDocument(name, extracted.output, extracted.assets);
    documents.push({ name, html: extracted.output });
    assets.push(...extracted.assets);
  }

  const names = assets.map((asset) => asset.name);
  if (new Set(names).size !== names.length) {
    throw new Error("build: generated duplicate asset names");
  }

  await mkdir(assetsDir, { recursive: true });
  await removeStaleAssets(assetsDir, new Set(names));
  await Promise.all(
    assets.map((asset) => writeFile(path.join(assetsDir, asset.name), asset.body, "utf8")),
  );
  await Promise.all(
    documents.map((document) => writeFile(path.join(out, document.name), document.html, "utf8")),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build()
    .then(() => console.log(`built admin assets into ${defaultOutput}`))
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
}
