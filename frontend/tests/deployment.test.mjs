import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

async function read(relative) {
  return readFile(path.join(root, relative), "utf8");
}

async function missing(relative) {
  await assert.rejects(() => access(path.join(root, relative)));
}

test("frontend package has no React or Vite runtime", async () => {
  const pkg = JSON.parse(await read("frontend/package.json"));
  assert.equal(pkg.scripts.build, "node scripts/build.mjs");
  assert.equal(pkg.scripts.test, "node --test tests/*.test.mjs");
  assert.equal(pkg.dependencies, undefined);
  for (const name of Object.keys(pkg.devDependencies || {})) {
    assert.doesNotMatch(name, /^(react|react-dom|vite|vitest|tailwindcss|@tanstack\/)/, name);
  }
  assert.ok(pkg.devDependencies["@playwright/test"]);
  await missing("frontend/src");
  await missing("frontend/index.html");
  await missing("frontend/vite.config.ts");
  await missing("frontend/tsconfig.json");
});

test("Docker builds the native console without npm installation and keeps runtime directives", async () => {
  const dockerfile = await read("Dockerfile");
  assert.match(dockerfile, /FROM node:24/);
  assert.match(dockerfile, /node frontend\/scripts\/build\.mjs/);
  assert.doesNotMatch(dockerfile, /RUN npm (ci|install)|vite/i);
  assert.match(dockerfile, /COPY --from=frontend \/src\/internal\/webassets\/dist \.\/internal\/webassets\/dist/);
  assert.match(dockerfile, /USER nonroot:nonroot/);
  assert.match(dockerfile, /ENV DATA_DIR=\/data/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /ENTRYPOINT \["\/agnes-proxy"\]/);
  assert.match(dockerfile, /CMD \["serve"\]/);
  assert.match(dockerfile, /COPY --from=build --chown=65532:65532 \/out\/data \/data/);

  const dockerignore = await read(".dockerignore");
  assert.match(dockerignore, /^internal\/webassets\/dist$/m);
});

test("generated assets stay ignored and docs describe the native build", async () => {
  const gitignore = await read(".gitignore");
  assert.match(gitignore, /^internal\/webassets\/dist\/$/m);

  const readme = await read("README.md");
  assert.doesNotMatch(readme, /\bReact\b|\bVite\b|\bTailwind\b/i);
  assert.match(readme, /node frontend\/scripts\/build\.mjs/);
  assert.match(readme, /npm --prefix frontend test/);
  assert.match(readme, /go run \.\/cmd\/agnes-proxy preview/);
});
