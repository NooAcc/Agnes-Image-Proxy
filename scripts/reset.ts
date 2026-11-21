import { resetSchema } from "../lib/accounts.ts";
import { SCHEMA_VERSION } from "../lib/limits.ts";
import { createSqlExecutor } from "../lib/sql.ts";

if (Deno.env.get("RESET_SCHEMA") !== "1") {
  console.error(
    "refusing to reset: set RESET_SCHEMA=1 to drop accounts, request logs, usage, gallery and settings",
  );
  Deno.exit(1);
}

const url = Deno.env.get("TURSO_DATABASE_URL")?.trim() ?? "";
if (url === "") {
  console.error("TURSO_DATABASE_URL is required");
  Deno.exit(1);
}

const sql = createSqlExecutor({ url, authToken: Deno.env.get("TURSO_AUTH_TOKEN") });
await resetSchema(sql);
console.log(`schema reset to version ${SCHEMA_VERSION}`);
