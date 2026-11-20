import { assert } from "@std/assert";
import { renderLoginPage } from "../../web/login.ts";

Deno.test("login page renders a single password form", () => {
  const html = renderLoginPage();
  assert(html.includes("PROXY_API_KEY"));
  assert(html.includes('data-role="login-form"'));
  assert(html.includes('name="key"'));
  assert(html.includes('type="password"'));
  assert(html.includes("/admin/api/session"));
  assert(html.includes('data-action="toggle-password"'));
  assert(html.includes('role="alert"'));
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
  assert(!html.includes("@import"));
});

Deno.test("login page applies the saved theme before painting", () => {
  const html = renderLoginPage();
  assert(html.includes("agnes-theme"));
  assert(html.includes("prefers-color-scheme"));
  assert(html.includes('data-role="login-key"'));
});

Deno.test("login page includes the inline icon sprite and a Chinese 401 error", () => {
  const html = renderLoginPage();
  assert(html.includes('id="i-eye"'));
  assert(html.includes('id="i-eyeOff"'));
  assert(html.includes("密钥无效"));
});
