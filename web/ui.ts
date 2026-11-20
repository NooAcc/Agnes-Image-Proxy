import { ICON_SPRITE } from "./icons.ts";
import { renderConsole } from "./console.ts";
import { BASE_STYLE } from "./styles.ts";

/** Full console document. CSP is attached by htmlResponse. */
export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Agnes 图像控制台</title>
<style>${BASE_STYLE}</style>
</head>
<body>
${ICON_SPRITE}
${renderConsole()}
</body>
</html>`;
}
