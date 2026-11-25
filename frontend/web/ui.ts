import { FAVICON_URI, ICON_SPRITE } from "./icons.ts";
import { renderConsole } from "./console.ts";
import { BASE_STYLE } from "./styles.ts";
import { THEME_INIT_SCRIPT } from "./theme.ts";

export { renderSetupPage } from "./setup.ts";

/** Full console document. CSP is attached by htmlResponse. */
export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="${FAVICON_URI}">
<title>总览 · Agnes 图像控制台</title>
<script>${THEME_INIT_SCRIPT}</script>
<style>${BASE_STYLE}</style>
</head>
<body class="is-booting">
${ICON_SPRITE}
${renderConsole()}
</body>
</html>`;
}
