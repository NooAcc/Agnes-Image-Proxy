import { createAgnesClient } from "./lib/agnes.ts";
import { loadConfig } from "./lib/config.ts";
import { buildHarness, openDatabase } from "./scripts/harness.ts";

const config = loadConfig((key) => Deno.env.get(key));
const sql = openDatabase({
  url: config.tursoDatabaseUrl,
  authToken: config.tursoAuthToken,
});

const harness = await buildHarness({
  apiKey: config.apiKey,
  sql,
  createClient: createAgnesClient,
  corsAllowedOrigins: config.corsAllowedOrigins,
});

console.log(`Agnes image proxy listening on http://localhost:${config.port}`);
Deno.serve({ port: config.port }, harness.handler);
