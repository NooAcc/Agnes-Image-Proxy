import { assert } from "@std/assert";
import { renderLoginPage } from "../../web/login.ts";

Deno.test("login page renders a single password form", () => {
  const html = renderLoginPage();
  assert(html.includes("PROXY_API_KEY"));
  assert(html.includes('data-role="login-form"'));
  assert(html.includes('name="key"'));
  assert(html.includes('type="password"'));
  assert(html.includes("/admin/api/session"));
});

Deno.test("login page never leaks the console markup", () => {
  const html = renderLoginPage();
  assert(!html.includes('data-section="gallery"'));
  assert(!html.includes("data-nav="));
  assert(!html.includes("/admin/api/accounts"));
});

Deno.test("login page loads no external assets", () => {
  const html = renderLoginPage();
  assert(!html.includes("http://"));
  assert(!html.includes("https://"));
});
