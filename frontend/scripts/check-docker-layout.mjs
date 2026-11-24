import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// Reproduce the frontend Docker stage's COPY layout without needing Docker.
// Typechecking this layout catches imports from uncopied backend fixtures.
const repo = path.resolve(import.meta.dirname, "../..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agnes-docker-layout-"));
try {
  const source = path.join(repo, "frontend");
  const target = path.join(root, "frontend");
  fs.cpSync(source, target, { recursive: true, filter: (p) => !["node_modules", "test-results", "playwright-report"].includes(path.basename(p)) });
  fs.symlinkSync(path.join(source, "node_modules"), path.join(target, "node_modules"), "junction");
  const dockerfile = fs.readFileSync(path.join(repo, "Dockerfile"), "utf8");
  for (const line of dockerfile.split(/\r?\n/)) {
    if (line.startsWith("FROM golang:")) break;
    const match = /^COPY (internal\/\S+) (\.\.\/\S+)$/.exec(line);
    if (match) fs.cpSync(path.join(repo, match[1]), path.resolve(target, match[2]), { recursive: true });
  }
  const result = spawnSync(process.execPath, [path.join(source, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", path.join(target, "tsconfig.json")], { encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { fs.rmSync(root, { recursive: true, force: true }); }
