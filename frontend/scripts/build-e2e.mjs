import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const outputDir = path.join(root, ".build");
mkdirSync(outputDir, { recursive: true });

const binary = path.join(
  outputDir,
  process.platform === "win32" ? "agnes-proxy-e2e.exe" : "agnes-proxy-e2e",
);

// The frontend must be built first so internal/webassets embeds fresh assets.
const result = spawnSync("go", ["build", "-o", binary, "./cmd/agnes-proxy"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, CGO_ENABLED: "0" },
});
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
