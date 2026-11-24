import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = 8123;
const binary = path.join(
  here,
  "..",
  ".build",
  process.platform === "win32" ? "agnes-proxy-e2e.exe" : "agnes-proxy-e2e",
);

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      // Use the locally installed Chrome so no browser download is required.
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: `"${binary}" preview --port ${port}`,
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
