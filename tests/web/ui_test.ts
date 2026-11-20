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
  assert(html.includes('class="panel is-active" data-section="overview"'));
  assert(html.includes('data-role="page-title"'));
  assert(html.includes('data-role="health-chip"'));
  assert(html.includes('data-action="toggle-theme"'));
});

Deno.test("admin page uses no external resources", () => {
  const html = renderAdminPage();
  assert(!html.includes('src="http'), "found external src");
  assert(!html.includes('href="http'), "found external href");
  assert(!html.includes("url(http"), "found external css url");
  assert(!html.includes("@import"), "found css import");
  assert(!html.includes("fonts.googleapis"), "found external font");
  assert(!html.includes('src="//'));
});

Deno.test("admin page wires account interactions", () => {
  const html = renderAdminPage();
  for (
    const action of [
      'data-action="add-account"',
      'data-action="import-accounts"',
      'data-action="test-all"',
      'data-action="close-dialog"',
    ]
  ) {
    assert(html.includes(action), `missing ${action}`);
  }
  for (
    const action of [
      "test-account",
      "reset-account",
      "toggle-account",
      "delete-account",
      "rename-account",
    ]
  ) {
    assert(html.includes(`"${action}"`), `missing handler for ${action}`);
  }
  for (const path of ["/admin/api/accounts", "/admin/api/accounts/import", "/test", "/reset"]) {
    assert(html.includes(path), `missing ${path}`);
  }
});

Deno.test("admin page ships a theme toggle and accessible dialogs", () => {
  const html = renderAdminPage();
  assert(html.includes('localStorage.getItem("agnes-theme")'));
  assert(html.includes("prefers-color-scheme: light"));
  assert(html.includes('role="alert"'));
  assert(html.includes('aria-live="polite"'));
  assert(html.includes('data-role="confirm-dialog"'));
  assert(html.includes('data-role="toast-stack"'));
  assert(html.includes('class="skip-link"'));
});

Deno.test("styles expose the design tokens for both themes", () => {
  assert(BASE_STYLE.includes("--accent: #22c55e"));
  assert(BASE_STYLE.includes(':root[data-theme="light"]'));
  assert(BASE_STYLE.includes("--font-mono"));
  assert(BASE_STYLE.includes("prefers-reduced-motion"));
  assert(BASE_STYLE.includes(":focus-visible"));
  assert(BASE_STYLE.includes("border-radius: var(--radius)"));
});

Deno.test("icon sprite is inline SVG", () => {
  assert(ICON_SPRITE.startsWith("<svg"));
  assert(!ICON_SPRITE.includes("http"));
  assert(ICON_SPRITE.includes('id="i-overview"'));
  assert(ICON_SPRITE.includes('id="i-sun"'));
});

Deno.test("login page asks for PROXY_API_KEY and hides the console", () => {
  const html = renderLoginPage();
  assert(html.includes("PROXY_API_KEY"));
  assert(html.includes('data-role="login-form"'));
  assert(html.includes('type="password"'));
  assert(html.includes('data-action="toggle-password"'));
  assert(html.includes('role="alert"'));
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
