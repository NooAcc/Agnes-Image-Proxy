export const BASE_STYLE = `
:root {
  --bg: #f4f7f6;
  --surface: #ffffff;
  --surface-alt: #eef4f1;
  --border: #dbe6e1;
  --text: #0f1d18;
  --muted: #5c6f68;
  --primary: #047857;
  --primary-soft: #d9f0e7;
  --danger: #b91c1c;
  --danger-soft: #fde8e8;
  --warning: #b45309;
  --warning-soft: #fef3c7;
  --radius: 10px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color-scheme: light;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.55 var(--font);
}
h1, h2, h3 { margin: 0 0 4px; font-weight: 650; letter-spacing: -0.01em; }
p { margin: 0; }
button, input, select, textarea { font: inherit; color: inherit; }
a { color: var(--primary); text-decoration: none; }
.icon { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.shell { display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; }
.sidebar {
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: 20px 14px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  position: sticky;
  top: 0;
  height: 100vh;
}
.brand { font-weight: 700; font-size: 15px; padding: 0 8px; }
.brand small { display: block; font-weight: 400; color: var(--muted); font-size: 12px; }
.nav { display: flex; flex-direction: column; gap: 4px; }
.nav-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: 8px; color: var(--muted); font-weight: 500;
}
.nav-item:hover { background: var(--surface-alt); color: var(--text); }
.nav-item.is-active { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.sidebar-footer { margin-top: auto; }
.content { padding: 26px 30px 60px; max-width: 1180px; }
.panel { display: none; }
.panel.is-active { display: block; }
.panel-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
.panel-head h1 { font-size: 20px; }
.panel-head p { color: var(--muted); }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 16px 18px; box-shadow: 0 1px 2px rgba(15, 29, 24, 0.04);
}
.grid-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 18px; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
.stat-label { color: var(--muted); font-size: 12px; }
.stat-value { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); cursor: pointer; font-weight: 500;
}
.btn:hover { background: var(--surface-alt); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn.primary:hover { background: #036c4f; }
.btn.danger { color: var(--danger); border-color: #f3c4c4; background: var(--danger-soft); }
.btn.ghost { border-color: transparent; background: transparent; }
.btn.small { padding: 5px 9px; font-size: 12px; }
.table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { color: var(--muted); font-size: 12px; font-weight: 600; background: var(--surface-alt); }
tr:last-child td { border-bottom: 0; }
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.badge.ok { background: var(--primary-soft); color: var(--primary); }
.badge.warn { background: var(--warning-soft); color: var(--warning); }
.badge.bad { background: var(--danger-soft); color: var(--danger); }
.badge.muted { background: var(--surface-alt); color: var(--muted); }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-weight: 600; font-size: 13px; }
.field input, .field select, .field textarea {
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--surface); width: 100%;
}
.field textarea { min-height: 120px; resize: vertical; }
.field .hint { color: var(--muted); font-size: 12px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.empty { padding: 34px 18px; text-align: center; color: var(--muted); }
dialog {
  border: 1px solid var(--border); border-radius: 14px; padding: 0; width: min(460px, 92vw);
  box-shadow: 0 20px 60px rgba(15, 29, 24, 0.18); background: var(--surface); color: var(--text);
}
dialog::backdrop { background: rgba(15, 29, 24, 0.35); }
.dialog-body { padding: 20px; }
.dialog-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.bottom-nav { display: none; }
.toast {
  position: fixed; right: 20px; bottom: 20px; z-index: 20; max-width: 360px;
  background: #0f1d18; color: #fff; padding: 10px 14px; border-radius: 10px; font-size: 13px;
  opacity: 0; transform: translateY(8px); transition: opacity 0.18s ease, transform 0.18s ease; pointer-events: none;
}
.toast.show { opacity: 1; transform: none; }
@media (max-width: 860px) {
  .shell { grid-template-columns: 1fr; padding-bottom: 68px; }
  .sidebar { display: none; }
  .content { padding: 18px 14px 40px; }
  .bottom-nav {
    display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 10;
    background: var(--surface); border-top: 1px solid var(--border);
    padding: 6px 4px calc(6px + env(safe-area-inset-bottom));
  }
  .bottom-nav a { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 11px; color: var(--muted); padding: 4px 0; }
  .bottom-nav a.is-active { color: var(--primary); font-weight: 600; }
  .table-wrap { border: 0; background: transparent; }
  table, thead, tbody, th, td, tr { display: block; }
  thead { display: none; }
  tr { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 10px; padding: 6px 10px; }
  td { border: 0; padding: 6px 2px; display: flex; justify-content: space-between; gap: 12px; }
  td::before { content: attr(data-label); color: var(--muted); font-size: 12px; }
}

.gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 14px; }
.timeline-day {
  grid-column: 1 / -1; margin: 14px 0 2px; font-size: 13px; color: var(--muted);
  font-weight: 600; letter-spacing: 0.02em;
}
.gallery-card {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  overflow: hidden; display: flex; flex-direction: column; min-height: 0;
}
.gallery-media { aspect-ratio: 4 / 3; background: var(--surface-alt); display: grid; place-items: center; cursor: zoom-in; overflow: hidden; }
.gallery-media img { width: 100%; height: 100%; object-fit: cover; display: block; }
.gallery-placeholder { cursor: default; color: var(--muted); font-size: 12px; gap: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.gallery-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
.gallery-prompt {
  margin: 0; font-weight: 600; font-size: 13px; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word;
}
.gallery-meta { margin: 0; color: var(--muted); font-size: 12px; }
.gallery-actions { display: flex; justify-content: flex-end; }
.gallery-sentinel { text-align: center; padding: 18px 0; font-size: 12px; }
.gallery-empty { margin-bottom: 14px; }
.gallery-preview { width: 100%; max-height: 62vh; object-fit: contain; border-radius: 8px; background: var(--surface-alt); margin-bottom: 10px; }
`;

export const LOGIN_STYLE = `
:root {
  --bg: #f4f7f6; --surface: #ffffff; --border: #dbe6e1; --text: #0f1d18;
  --muted: #5c6f68; --primary: #047857; --radius: 10px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color-scheme: light;
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg);
  color: var(--text); font: 14px/1.55 var(--font);
}
.card { width: min(380px, 92vw); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 26px; box-shadow: 0 10px 40px rgba(15, 29, 24, 0.08); }
h1 { margin: 0 0 6px; font-size: 20px; }
.hint { margin: 0 0 18px; color: var(--muted); font-size: 13px; }
label { display: block; font-weight: 600; margin-bottom: 6px; font-size: 13px; }
input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); font: inherit; }
button { width: 100%; margin-top: 16px; padding: 10px 14px; border: 0; border-radius: 8px; background: var(--primary); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.error { margin-top: 12px; color: #b91c1c; font-size: 13px; min-height: 18px; }
`;
