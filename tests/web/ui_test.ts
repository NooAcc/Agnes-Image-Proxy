import { assert, assertEquals } from "@std/assert";
import { htmlResponse } from "../../lib/http.ts";
import { renderAdminPage } from "../../web/ui.ts";
import { BASE_STYLE } from "../../web/styles.ts";
import { ICON_SPRITE } from "../../web/icons.ts";
import { renderLoginPage } from "../../web/login.ts";

Deno.test("admin page contains five sections and five nav items", () => {
  const html = renderAdminPage();
  for (const section of ["overview", "gallery", "accounts", "logs", "settings"]) {
    assert(html.includes(`data-section="${section}"`), `missing section ${section}`);
  }
  const navItems = html.match(/data-nav="/g) ?? [];
  assertEquals(navItems.length, 5);
  const bottomItems = html.match(/data-bottom-nav="/g) ?? [];
  assertEquals(bottomItems.length, 5);
  assert(html.includes('data-default-section="overview"'));
  assert(html.includes('class="panel is-active" data-section="overview"'));
});

Deno.test("admin page uses no external resources", () => {
  const html = renderAdminPage();
  assert(!html.includes("http://"), "found http:// resource");
  assert(!html.includes("https://"), "found https:// resource");
  assert(!html.includes('src="//'));
});

Deno.test("admin page wires account interactions", () => {
  const html = renderAdminPage();
  for (
    const action of [
      'data-action="add-account"',
      'data-action="import-accounts"',
      'data-action="test-all"',
      'data-action="reset-account"',
    ]
  ) {
    assert(html.includes(action), `missing ${action}`);
  }
  for (const path of ["/admin/api/accounts", "/admin/api/accounts/import", "/test", "/reset"]) {
    assert(html.includes(path), `missing ${path}`);
  }
});

Deno.test("styles expose the design tokens", () => {
  assert(BASE_STYLE.includes("#f4f7f6"));
  assert(BASE_STYLE.includes("#047857"));
  assert(BASE_STYLE.includes("system-ui") || BASE_STYLE.includes("-apple-system"));
  assert(BASE_STYLE.includes("border-radius: var(--radius)"));
});

Deno.test("icon sprite is inline SVG", () => {
  assert(ICON_SPRITE.startsWith("<svg"));
  assert(!ICON_SPRITE.includes("http"));
});

Deno.test("login page asks for PROXY_API_KEY and hides the console", () => {
  const html = renderLoginPage();
  assert(html.includes("PROXY_API_KEY"));
  assert(html.includes('data-role="login-form"'));
  assert(html.includes('type="password"'));
  assert(!html.includes('data-section="overview"'));
  assert(!html.includes("data-nav="));
  assert(!html.includes("http://"));
  assert(!html.includes("https://"));
});

Deno.test("htmlResponse applies the CSP headers to the console page", () => {
  const response = htmlResponse(renderAdminPage());
  const csp = response.headers.get("content-security-policy") ?? "";
  assert(csp.includes("default-src 'none'"));
  assert(csp.includes("img-src 'self' data:"));
  assertEquals(response.headers.get("x-frame-options"), "DENY");
});
