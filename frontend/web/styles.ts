/**
 * Console design tokens and components.
 *
 * No external assets: the CSP only allows inline styles and same-origin images,
 * so the UI relies on system fonts and inline SVG. Dark is the default theme;
 * a saved preference or system setting switches to light.
 */
export const BASE_STYLE = `
:root {
  --font-sans: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace;
  --radius-sm: 8px;
  --radius: 12px;
  --radius-lg: 16px;
  --dur-fast: 120ms;
  --dur: 200ms;
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --sidebar-w: 248px;
  --content-max: 1240px;
  --shadow-sm: 0 1px 2px rgba(2, 6, 23, 0.24);
  --shadow-md: 0 12px 32px rgba(2, 6, 23, 0.32);
  --shadow-lg: 0 28px 80px rgba(2, 6, 23, 0.5);
  --tone-ok: #34d399;
  --tone-warn: #fbbf24;
  --tone-bad: #f87171;
  --tone-info: #60a5fa;
  color-scheme: dark;
  --bg: #070b13;
  --bg-glow: rgba(34, 197, 94, 0.09);
  --bg-glow-alt: rgba(56, 189, 248, 0.06);
  --surface: #0e1524;
  --surface-2: #141e31;
  --surface-3: #1b2740;
  --border: #233150;
  --border-strong: #334566;
  --text: #e8eefb;
  --muted: #94a3bb;
  --faint: #6b7c96;
  --accent: #22c55e;
  --accent-strong: #16a34a;
  --accent-text: #4ade80;
  --accent-soft: rgba(34, 197, 94, 0.12);
  --on-accent: #052e16;
  --danger: #f87171;
  --danger-soft: rgba(248, 113, 113, 0.12);
  --warning: #fbbf24;
  --warning-soft: rgba(251, 191, 36, 0.12);
  --info: #60a5fa;
  --info-soft: rgba(96, 165, 250, 0.12);
  --ring: #4ade80;
  --scrim: rgba(3, 7, 18, 0.68);
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f3f6fa;
  --bg-glow: rgba(21, 128, 61, 0.07);
  --bg-glow-alt: rgba(29, 78, 216, 0.05);
  --surface: #ffffff;
  --surface-2: #eef3f8;
  --surface-3: #e2eaf3;
  --border: #dbe4ee;
  --border-strong: #c2d0e0;
  --text: #0f1b2d;
  --muted: #55677f;
  --faint: #5b6b80;
  --accent: #15803d;
  --accent-strong: #166534;
  --accent-text: #15803d;
  --accent-soft: #dcfce7;
  --on-accent: #ffffff;
  --danger: #b91c1c;
  --danger-soft: #fee2e2;
  --warning: #a34707;
  --warning-soft: #fef3c7;
  --info: #1d4ed8;
  --info-soft: #dbeafe;
  --ring: #16a34a;
  --tone-ok: #15803d;
  --tone-warn: #a34707;
  --tone-bad: #b91c1c;
  --tone-info: #1d4ed8;
  --shadow-sm: 0 1px 2px rgba(15, 27, 45, 0.06);
  --shadow-md: 0 10px 28px rgba(15, 27, 45, 0.1);
  --shadow-lg: 0 24px 64px rgba(15, 27, 45, 0.18);
  --scrim: rgba(15, 27, 45, 0.42);
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html { scroll-padding-top: 80px; scrollbar-gutter: stable; }
@supports not (scrollbar-gutter: stable) { html { overflow-y: scroll; } }
body {
  min-height: 100dvh;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.55 var(--font-sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background:
    radial-gradient(900px 420px at 12% -8%, var(--bg-glow), transparent 70%),
    radial-gradient(760px 360px at 92% 0%, var(--bg-glow-alt), transparent 70%);
}
h1, h2, h3 { margin: 0; font-weight: 650; letter-spacing: -0.015em; }
h1 { font-size: 19px; line-height: 1.3; }
h2 { font-size: 15px; line-height: 1.35; }
h3 { font-size: 14px; line-height: 1.4; }
p { margin: 0; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
a { color: var(--accent-text); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--font-mono); font-size: 0.92em; font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.faint { color: var(--faint); }
[hidden] { display: none !important; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.icon {
  width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor;
  stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round;
}
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 4px; }
.skip-link {
  position: fixed; left: 12px; top: -60px; z-index: 100;
  padding: 10px 16px; border-radius: var(--radius); background: var(--accent); color: var(--on-accent);
  font-weight: 650; transition: top var(--dur) var(--ease);
}
.skip-link:focus { top: 12px; }

/* ---------- Shell ---------- */
.app { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); min-height: 100dvh; }
.sidebar {
  position: sticky; top: 0; z-index: 35;
  height: 100dvh; display: flex; flex-direction: column; gap: 18px;
  padding: 18px 14px 16px;
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  border-right: 1px solid var(--border);
  backdrop-filter: blur(18px);
}
.brand { display: flex; align-items: center; gap: 11px; padding: 2px 8px 16px; border-bottom: 1px solid var(--border); }
.brand-mark { width: 36px; height: 36px; flex: none; filter: drop-shadow(0 6px 14px rgba(34, 197, 94, 0.22)); }
.brand-name { font-size: 15px; font-weight: 750; letter-spacing: -0.01em; line-height: 1.2; }
.brand-sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; }
.nav { display: flex; flex-direction: column; gap: 3px; }
.nav-item {
  display: flex; align-items: center; gap: 11px;
  min-height: 40px; padding: 0 11px; border-radius: 10px;
  color: var(--muted); font-weight: 550; font-size: 13.5px;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.nav-item:hover { background: var(--surface-2); color: var(--text); text-decoration: none; }
.nav-item.is-active { background: var(--accent-soft); color: var(--accent-text); font-weight: 650; }
.nav-item .icon { width: 19px; height: 19px; }
.sidebar-foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid var(--border); }
.session-note { display: flex; align-items: center; gap: 8px; padding: 0 8px; font-size: 12px; color: var(--muted); }
.session-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tone-ok); box-shadow: 0 0 0 4px color-mix(in srgb, var(--tone-ok) 18%, transparent); }
.main { min-width: 0; display: flex; flex-direction: column; }
.topbar {
  position: sticky; top: 0; z-index: 30;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 13px clamp(16px, 3vw, 30px);
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  border-bottom: 1px solid var(--border);
  backdrop-filter: blur(18px);
}
.topbar-heading { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.eyebrow { font-size: 10.5px; font-weight: 650; letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); }
.topbar h1 { font-size: 18px; }
.topbar-actions { display: flex; align-items: center; gap: 8px; }
.health-chip {
  display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 12px;
  border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2);
  font-size: 12px; font-weight: 600; color: var(--muted); white-space: nowrap;
}
.health-chip[data-tone="ok"] { color: var(--tone-ok); border-color: color-mix(in srgb, var(--tone-ok) 30%, var(--border)); }
.health-chip[data-tone="warn"] { color: var(--tone-warn); border-color: color-mix(in srgb, var(--tone-warn) 30%, var(--border)); }
.health-chip[data-tone="bad"] { color: var(--tone-bad); border-color: color-mix(in srgb, var(--tone-bad) 30%, var(--border)); }
.health-chip .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.content {
  width: 100%; max-width: var(--content-max); margin: 0 auto;
  padding: 22px clamp(16px, 3vw, 30px) 72px;
}
.panel { display: none; flex-direction: column; gap: 16px; }
.panel.is-active { display: flex; animation: panel-in var(--dur) var(--ease); }
@keyframes panel-in { from { opacity: 0; transform: translateY(5px); } }
.section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.section-lead { display: flex; flex-direction: column; gap: 3px; max-width: 68ch; }
.section-lead h2 { font-size: 15px; }
.section-lead p { font-size: 13px; color: var(--muted); }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.toolbar .label { font-size: 12px; font-weight: 600; color: var(--muted); }
.bottom-nav { display: none; }

/* ---------- Buttons & controls ---------- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  min-height: 38px; padding: 0 14px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
  font-size: 13px; font-weight: 600; white-space: nowrap; user-select: none;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
}
.btn:hover { background: var(--surface-3); border-color: var(--border-strong); text-decoration: none; }
.btn:active { transform: translateY(1px); }
.btn:disabled, .btn.is-busy { opacity: 0.55; cursor: not-allowed; transform: none; }
.btn.is-busy .icon, .icon-btn.is-busy .icon { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.btn .icon { width: 16px; height: 16px; }
.btn.primary { background: var(--accent); border-color: transparent; color: var(--on-accent); }
.btn.primary:hover { background: var(--accent-strong); }
.btn.primary.is-unavailable,
.btn.primary.is-unavailable:hover {
  background: var(--surface-2);
  border-color: var(--border);
  color: var(--faint);
  opacity: 1;
  cursor: not-allowed;
}
.btn.primary.is-running,
.btn.primary.is-running:hover,
.btn.primary.is-running:disabled {
  background-image: linear-gradient(110deg, #1d4ed8, #7c3aed, #1d4ed8);
  background-size: 220% 100%;
  border-color: transparent;
  color: #fff;
  opacity: 1;
  cursor: progress;
  animation: btn-flow 2.4s linear infinite;
}
.btn.primary.is-error,
.btn.primary.is-error:hover {
  background: var(--danger);
  border-color: transparent;
  color: var(--on-accent);
}
@keyframes btn-flow {
  from { background-position: 0% 50%; }
  to { background-position: -220% 50%; }
}
.btn.danger { background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 30%, transparent); color: var(--danger); }
.btn.danger:hover { background: color-mix(in srgb, var(--danger) 20%, transparent); }
.btn.ghost { background: transparent; border-color: transparent; color: var(--muted); }
.btn.ghost:hover { background: var(--surface-2); color: var(--text); }
.btn.small { min-height: 32px; padding: 0 10px; font-size: 12px; border-radius: 9px; }
.btn.icon-only { width: 38px; min-height: 38px; padding: 0; flex: none; }
.btn.icon-only.small { width: 32px; min-height: 32px; }
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; padding: 0; border-radius: 10px;
  border: 1px solid transparent; background: transparent; color: var(--muted);
  text-decoration: none;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.icon-btn:hover { background: var(--surface-2); color: var(--text); text-decoration: none; }
.icon-btn:disabled, .icon-btn.is-busy { opacity: 0.55; cursor: not-allowed; }
.icon-btn.danger:hover { background: var(--danger-soft); color: var(--danger); }
.theme-icon-dark, .theme-icon-light { display: inline-flex; align-items: center; justify-content: center; }
:root[data-theme="dark"] .theme-icon-light { display: none; }
:root[data-theme="light"] .theme-icon-dark { display: none; }
.status-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--faint); }
.status-dot.ok { background: var(--tone-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone-ok) 18%, transparent); }
.status-dot.warn { background: var(--tone-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone-warn) 18%, transparent); }
.status-dot.bad { background: var(--tone-bad); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone-bad) 18%, transparent); }
.status-dot.muted { background: var(--faint); }

.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.field > label, .field > .field-label { font-size: 12.5px; font-weight: 650; }
.field .hint { font-size: 12px; color: var(--muted); line-height: 1.5; }
.input, .select, .textarea {
  width: 100%; min-height: 40px; padding: 8px 12px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--surface-2); color: var(--text);
  transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}
.input:hover, .select:hover, .textarea:hover { border-color: var(--border-strong); }
.input:focus, .select:focus, .textarea:focus {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.textarea { min-height: 132px; resize: vertical; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.6; }
.input::placeholder, .textarea::placeholder { color: var(--faint); }
.input[type="date"] { padding-right: 8px; }
.input[type="number"] { font-variant-numeric: tabular-nums; }
.input.compact { width: auto; min-height: 38px; }
.btn[aria-pressed="true"] {
  background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent-text) 26%, transparent);
  color: var(--accent-text);
}
.search { position: relative; min-width: min(260px, 100%); flex: 1 1 220px; max-width: 340px; }
.search .icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--faint); width: 16px; height: 16px; pointer-events: none; }
.search .input { padding-left: 34px; min-height: 38px; font-size: 13px; }
.input-wrap { position: relative; }
.input-wrap .input { padding-right: 46px; }
.input-wrap .reveal {
  position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 0; border-radius: 8px; background: transparent; color: var(--muted);
}
.input-wrap .reveal:hover { background: var(--surface-3); color: var(--text); }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
.form-grid.two { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.form-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
.form-status { margin-right: auto; font-size: 12px; color: var(--muted); }
.form-status.is-dirty { color: var(--warning); }
.segmented {
  display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 3px;
  align-self: flex-start; width: max-content; max-width: 100%;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 11px;
}
.segmented label { position: relative; display: inline-flex; }
.segmented input { position: absolute; inset: 0; opacity: 0; cursor: pointer; margin: 0; }
.segmented span {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 32px; padding: 0 12px; border-radius: 8px;
  font-size: 12.5px; font-weight: 600; color: var(--muted); white-space: nowrap;
}
.segmented input:checked + span { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
.segmented input:focus-visible + span { outline: 2px solid var(--ring); outline-offset: 1px; }
.tag-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex; align-items: center; min-height: 28px; padding: 0 11px;
  border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2);
  color: var(--muted); font-size: 12px; font-weight: 600; cursor: pointer;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.chip:hover { background: var(--surface-3); border-color: var(--border-strong); color: var(--text); }
.chip.is-active { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent-text) 30%, transparent); color: var(--accent-text); }
.chip:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.switch { display: inline-flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--muted); cursor: pointer; user-select: none; }
.switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.switch .track {
  position: relative; width: 36px; height: 20px; flex: none; border-radius: 999px;
  background: var(--surface-3); border: 1px solid var(--border-strong);
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.switch .track::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: var(--muted); transition: transform var(--dur) var(--ease), background var(--dur-fast) var(--ease);
}
.switch input:checked + .track { background: var(--accent); border-color: var(--accent); }
.switch input:checked + .track::after { transform: translateX(16px); background: var(--on-accent); }
.switch input:focus-visible + .track { outline: 2px solid var(--ring); outline-offset: 2px; }
.auto-refresh {
  gap: 8px; height: 34px; padding: 0 11px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface-2); white-space: nowrap;
}
.auto-refresh:hover { background: var(--surface-3); border-color: var(--border-strong); }
.auto-refresh-text { font-size: 12px; font-weight: 600; }

/* ---------- Surfaces ---------- */
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 18px; box-shadow: var(--shadow-sm);
}
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.card-head p { font-size: 12.5px; color: var(--muted); margin-top: 2px; }
.card-title { font-size: 14.5px; font-weight: 650; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(172px, 1fr)); gap: 12px; }
.stat { position: relative; overflow: hidden; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; box-shadow: var(--shadow-sm); }
.stat::after { content: ""; position: absolute; inset: auto 0 0 0; height: 2px; background: linear-gradient(90deg, var(--accent), transparent 70%); opacity: 0.55; }
.stat-label { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--muted); }
.stat-value { margin-top: 6px; font-size: 27px; font-weight: 720; letter-spacing: -0.03em; line-height: 1.1; font-variant-numeric: tabular-nums; }
.stat-meta { margin-top: 3px; font-size: 11.5px; color: var(--faint); }
.stat-value .unit { font-size: 14px; font-weight: 600; color: var(--muted); margin-left: 2px; }
.stat.tone-warn::after { background: linear-gradient(90deg, var(--warning), transparent 70%); }
.stat.tone-bad::after { background: linear-gradient(90deg, var(--danger), transparent 70%); }

.badge {
  display: inline-flex; align-items: center; gap: 5px; min-height: 22px; padding: 1px 9px;
  border-radius: 999px; font-size: 11.5px; font-weight: 650; letter-spacing: 0.01em;
  border: 1px solid transparent; white-space: nowrap;
}
.badge .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge.ok { background: var(--accent-soft); color: var(--accent-text); border-color: color-mix(in srgb, var(--accent-text) 22%, transparent); }
.badge.warn { background: var(--warning-soft); color: var(--warning); }
.badge.bad { background: var(--danger-soft); color: var(--danger); }
.badge.info { background: var(--info-soft); color: var(--info); }
.badge.muted { background: var(--surface-2); color: var(--muted); border-color: var(--border); }
.tag { display: inline-flex; align-items: center; padding: 0 7px; min-height: 19px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border); color: var(--muted); font-size: 10.5px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; }
.empty {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 36px 18px; text-align: center; color: var(--muted); font-size: 13px;
}
.empty .icon { width: 26px; height: 26px; color: var(--faint); margin-bottom: 2px; }
.empty strong { color: var(--text); font-size: 14px; }
.empty .btn { margin-top: 8px; }

/* ---------- Overview ---------- */
.trend-readout { min-height: 20px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.chart { display: grid; grid-template-columns: repeat(14, minmax(0, 1fr)); gap: 6px; align-items: end; height: 168px; margin-top: 6px; }
.bar-col { display: flex; flex-direction: column; justify-content: flex-end; gap: 7px; height: 100%; padding: 0 2px; border-radius: 8px; outline-offset: 2px; }
.bar-col:hover { background: color-mix(in srgb, var(--surface-2) 70%, transparent); }
.bar-track { display: flex; flex-direction: column; justify-content: flex-end; gap: 2px; flex: 1 1 auto; min-height: 0; }
.bar-stack { display: flex; flex-direction: column; justify-content: flex-end; gap: 2px; min-height: 3px; border-radius: 5px; overflow: hidden; }
.bar-seg { width: 100%; border-radius: 3px; flex: none; }
.bar-seg.ok { background: linear-gradient(180deg, var(--accent-text), var(--accent-strong)); }
.bar-seg.partial { background: var(--warning); }
.bar-seg.err { background: var(--danger); }
.bar-zero { background: var(--surface-3); height: 3px; width: 100%; border-radius: 3px; }
.bar-day { font-size: 10px; line-height: 1.2; text-align: center; color: var(--faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar-col.is-selected .bar-day { color: var(--accent-text); font-weight: 700; }
.bar-col.is-selected .bar-track { filter: drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 35%, transparent)); }
.chart-legend { display: flex; gap: 16px; margin-top: 12px; font-size: 11.5px; color: var(--muted); }
.chart-legend span { display: inline-flex; align-items: center; gap: 6px; }
.chart-legend i { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }
.chart-legend .ok { background: var(--accent); }
.chart-legend .partial { background: var(--warning); }
.chart-legend .err { background: var(--danger); }
.model-list { display: flex; flex-direction: column; }
.model-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 18px; padding: 13px 0; border-bottom: 1px solid var(--border); }
.model-row:last-child { border-bottom: 0; padding-bottom: 0; }
.model-row:first-child { padding-top: 0; }
.model-name { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.model-name .mono { font-size: 12.5px; font-weight: 600; }
.model-stats { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.model-stats b { color: var(--text); font-weight: 650; font-variant-numeric: tabular-nums; }
.model-meter { grid-column: 1 / -1; height: 5px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
.model-meter span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--accent), var(--accent-strong)); }
.model-meter span.is-empty { background: var(--border-strong); }

/* ---------- Accounts ---------- */
.summary-strip { display: flex; flex-wrap: wrap; gap: 8px; }
.summary-pill { display: inline-flex; align-items: center; gap: 7px; min-height: 30px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); font-size: 12px; color: var(--muted); }
.summary-pill b { color: var(--text); font-variant-numeric: tabular-nums; }
.account-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.account-card {
  position: relative; display: flex; flex-direction: column; gap: 12px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
  padding: 16px; box-shadow: var(--shadow-sm);
  transition: border-color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
}
.account-card:hover { border-color: var(--border-strong); }
.account-card.is-off { background: var(--surface-2); }
.api-key-card .account-name, [data-role="api-key-base-url"] { overflow-wrap: anywhere; }
[data-section="api-keys"] .btn, [data-role="create-api-key-dialog"] .btn,
[data-role="copy-api-key-dialog"] .btn { min-height: 44px; }
.account-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.account-id { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.account-name { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 650; }
.account-name .name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-key { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); }
.account-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.account-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 10px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.account-metric { display: flex; flex-direction: column; gap: 1px; }
.account-metric span { font-size: 10.5px; color: var(--faint); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.account-metric b { font-size: 14px; font-weight: 650; font-variant-numeric: tabular-nums; }
.account-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.account-foot .icon-btn { width: 32px; height: 32px; }
.account-times { font-size: 11.5px; color: var(--faint); }

/* ---------- Tables ---------- */
.filter-bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  padding: 10px 12px; background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--radius);
}
.logs-status { margin-left: auto; font-size: 11.5px; color: var(--faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
.settings-form { display: flex; flex-direction: column; gap: 14px; }
.save-bar {
  position: sticky; bottom: 14px; z-index: 5;
  display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap;
  padding: 11px 14px; border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(14px); box-shadow: var(--shadow-md);
}
.table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: auto; box-shadow: var(--shadow-sm); }
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
thead th {
  position: sticky; top: 0; z-index: 1;
  padding: 9px 12px; text-align: left; white-space: nowrap;
  background: var(--surface-2); border-bottom: 1px solid var(--border);
  color: var(--muted); font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
}
tbody td { padding: 9px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr { transition: background var(--dur-fast) var(--ease); }
tbody tr:hover { background: color-mix(in srgb, var(--surface-2) 60%, transparent); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.row-error { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--danger); }
.row-actions { display: flex; justify-content: flex-end; gap: 4px; }
.log-gallery-row { cursor: pointer; }
.log-gallery-row:hover, .log-gallery-row:focus-within { background: var(--accent-soft); }
.log-key-name { max-width: 16ch; overflow-wrap: anywhere; }
.table-empty td { padding: 0; }
.table-empty .empty { padding: 30px 16px; }

/* ---------- Gallery ---------- */
.gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(208px, 1fr)); gap: 12px; }
.timeline-day {
  grid-column: 1 / -1; display: flex; align-items: center; gap: 12px;
  margin: 10px 0 0; font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--muted);
}
.timeline-day::after { content: ""; height: 1px; flex: 1; background: var(--border); }
.gallery-card {
  position: relative; display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  transition: border-color var(--dur-fast) var(--ease), transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.gallery-card:hover { border-color: var(--border-strong); transform: translateY(-2px); box-shadow: var(--shadow-md); }
.gallery-card.is-request-match {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), 0 0 12px var(--accent-soft);
}
.gallery-request-context { margin: 0; }
.gallery-request-context a { color: var(--accent-text); text-decoration: underline; }
.gallery-media { position: relative; aspect-ratio: 1 / 1; background: var(--surface-2); overflow: hidden; }
.gallery-media img { display: block; width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; transition: transform 400ms var(--ease); }
.gallery-open { display: block; width: 100%; height: 100%; padding: 0; border: 0; background: none; cursor: zoom-in; }
.gallery-open:focus-visible { outline-offset: -3px; }
.gallery-card:hover .gallery-media img { transform: scale(1.025); }
.gallery-overlay {
  position: absolute; top: 8px; right: 8px; display: flex; gap: 6px; z-index: 2;
  opacity: 0; transition: opacity var(--dur-fast) var(--ease);
}
.gallery-card:hover .gallery-overlay, .gallery-card:focus-within .gallery-overlay { opacity: 1; }
.gallery-overlay .icon-btn { width: 34px; height: 34px; border-radius: 9px; background: rgba(3, 10, 20, 0.72); color: #f1f5f9; backdrop-filter: blur(6px); }
.gallery-overlay .icon-btn:hover { background: rgba(3, 10, 20, 0.9); color: #fff; }
.gallery-overlay .icon-btn.danger:hover { background: rgba(127, 29, 29, 0.9); }
.tag-badge {
  position: absolute; top: 8px; left: 8px; z-index: 1;
  display: inline-flex; align-items: center; min-height: 20px; padding: 0 8px;
  border-radius: 6px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em;
  color: #f8fafc; background: rgba(51, 65, 85, 0.82); backdrop-filter: blur(6px);
}
.tag-badge.tag-safe { background: rgba(100, 116, 139, 0.85); }
.tag-badge.tag-drawing { background: rgba(37, 99, 235, 0.85); }
.tag-badge.tag-sexy { background: rgba(217, 119, 6, 0.88); }
.tag-badge.tag-porn { background: rgba(220, 38, 38, 0.88); }
.tag-badge.tag-hentai { background: rgba(127, 29, 29, 0.9); }
.tag-badge.tag-none { background: rgba(51, 65, 85, 0.82); }
.gallery-body { display: flex; flex-direction: column; gap: 5px; padding: 10px 12px 12px; }
.gallery-prompt {
  margin: 0; font-size: 12.5px; font-weight: 600; line-height: 1.45; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.gallery-meta { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
.gallery-placeholder {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  height: 100%; padding: 16px; color: var(--muted); font-size: 12px; text-align: center;
}
.gallery-placeholder .icon { width: 24px; height: 24px; color: var(--faint); }
.gallery-sentinel { padding: 22px 0 8px; text-align: center; font-size: 12px; color: var(--faint); }
.gallery-sentinel.is-error { color: var(--danger); }

/* ---------- Dialogs ---------- */
dialog {
  width: min(480px, 92vw); max-height: 88dvh; padding: 0; overflow: auto;
  border: 1px solid var(--border-strong); border-radius: var(--radius-lg);
  background: var(--surface); color: var(--text); box-shadow: var(--shadow-lg);
}
dialog::backdrop { background: var(--scrim); backdrop-filter: blur(3px); }
dialog[open] { animation: dialog-in 180ms var(--ease); }
@keyframes dialog-in { from { opacity: 0; transform: translateY(8px) scale(0.985); } }
.dialog-body { padding: 20px; }
.dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.dialog-head h2 { font-size: 16px; }
.dialog-desc { font-size: 13px; color: var(--muted); line-height: 1.6; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; flex-wrap: wrap; }
.dialog-note { font-size: 12px; color: var(--muted); }
.form-error { display: none; margin-top: 12px; padding: 9px 12px; border-radius: 9px; background: var(--danger-soft); color: var(--danger); font-size: 12.5px; }
.form-error.is-visible { display: block; }
.detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px 16px; margin: 0; }
.detail-grid dt { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); }
.detail-grid dd { margin: 1px 0 0; font-size: 12.5px; word-break: break-word; }
.detail-block { margin-top: 14px; }
.detail-block h3 { margin-bottom: 6px; font-size: 12.5px; color: var(--muted); }
.detail-pre {
  margin: 0; padding: 11px 12px; border-radius: 9px; background: var(--surface-2);
  border: 1px solid var(--border); font-family: var(--font-mono); font-size: 11.5px;
  line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto;
}
.lightbox { width: min(980px, 94vw); }
.btn.lightbox-close {
  min-height: 36px; padding: 0 15px 0 12px; border-radius: 10px;
  border-color: transparent; background: var(--text); color: var(--surface);
  font-weight: 650; box-shadow: 0 2px 8px rgba(2, 6, 23, 0.24);
}
.btn.lightbox-close .icon { width: 17px; height: 17px; }
.btn.lightbox-close:hover {
  background: var(--danger); border-color: transparent; color: #fff;
}
.lightbox-body { display: flex; flex-direction: column; gap: 12px; padding: 14px; }
.lightbox-stage { position: relative; display: grid; place-items: center; background: var(--surface-2); border-radius: var(--radius); min-height: 240px; }
.lightbox-stage img { display: block; max-width: 100%; max-height: 64dvh; object-fit: contain; border-radius: var(--radius); transition: opacity 120ms var(--ease); }
.lightbox-stage.is-loading img { opacity: 0; }
.lightbox-stage.is-loading::after {
  content: ""; position: absolute; inset: 0; margin: auto; width: 30px; height: 30px;
  border-radius: 50%; border: 3px solid var(--border); border-top-color: var(--accent);
  animation: spin 800ms linear infinite;
}
.lightbox-nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 42px; height: 42px; border-radius: 50%;
  display: grid; place-items: center; border: 1px solid var(--border-strong);
  background: rgba(3, 10, 20, 0.62); color: #f1f5f9; backdrop-filter: blur(8px);
}
.lightbox-nav:hover { background: rgba(3, 10, 20, 0.86); }
.lightbox-nav.prev { left: 10px; }
.lightbox-nav.next { right: 10px; }
.lightbox-nav:disabled { opacity: 0.35; cursor: not-allowed; }
.lightbox-foot { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
.lightbox-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1 1 280px; }
.lightbox-prompt-wrap {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0;
  align-self: stretch; padding: 10px 13px; border-radius: 10px;
  background: var(--surface-2); border: 1px solid var(--border);
}
.lightbox-prompt { font-size: 13px; font-weight: 600; line-height: 1.5; word-break: break-word; max-width: 100%; }
.lightbox-prompt.is-clamped {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 10;
  line-clamp: 10; overflow: hidden;
}
.lightbox-prompt-toggle {
  padding: 0; border: 0; background: none; color: var(--accent-text);
  font-size: 12px; font-weight: 650; line-height: 1.4; cursor: pointer;
}
.lightbox-prompt-toggle:hover { text-decoration: underline; }
.lightbox-meta { font-size: 11.5px; color: var(--faint); }
.lightbox-actions { display: grid; grid-template-columns: repeat(2, max-content); gap: 8px; flex: none; }
.lightbox-actions .btn { justify-content: center; }

/* ---------- Toast ---------- */
.toast-stack { position: fixed; right: 18px; bottom: 18px; z-index: 80; display: flex; flex-direction: column; gap: 8px; width: min(370px, calc(100vw - 36px)); pointer-events: none; }
.toast {
  display: flex; align-items: flex-start; gap: 9px; padding: 11px 14px;
  border-radius: 12px; border: 1px solid var(--border-strong);
  background: var(--surface-3); color: var(--text); font-size: 12.5px; line-height: 1.5;
  box-shadow: var(--shadow-lg); opacity: 0; transform: translateY(8px);
  transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.toast.show { opacity: 1; transform: none; }
.toast .icon { width: 16px; height: 16px; margin-top: 1px; }
.toast.ok .icon { color: var(--accent-text); }
.toast.error .icon { color: var(--danger); }
.toast.info .icon { color: var(--info); }

/* ---------- Responsive ---------- */
@media (max-width: 1000px) {
  .app { grid-template-columns: 1fr; }
  .sidebar { display: none; }
  .content { padding-bottom: 96px; }
  .bottom-nav {
    display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 45;
    padding: 5px 6px calc(5px + env(safe-area-inset-bottom));
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    border-top: 1px solid var(--border); backdrop-filter: blur(18px);
  }
  .bottom-nav a {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    min-height: 52px; padding: 6px 2px; border-radius: 10px;
    font-size: 10.5px; font-weight: 600; color: var(--muted);
  }
  .bottom-nav a:hover { text-decoration: none; background: var(--surface-2); }
  .bottom-nav a.is-active { color: var(--accent-text); background: var(--accent-soft); }
  .bottom-nav .icon { width: 20px; height: 20px; }
  .topbar { padding-top: 10px; padding-bottom: 10px; }
  .health-chip { display: none; }
  .toast-stack { bottom: calc(74px + env(safe-area-inset-bottom)); }
}
@media (max-width: 860px) {
  .table--stack, .table--stack thead, .table--stack tbody, .table--stack th, .table--stack td, .table--stack tr { display: block; }
  .table--stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .table-wrap.is-stacked { background: transparent; border: 0; box-shadow: none; overflow: visible; }
  .table--stack tr { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 10px; padding: 6px 12px; }
  .table--stack td { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; border: 0; padding: 6px 0; text-align: right; }
  .table--stack td::before { content: attr(data-label); color: var(--faint); font-size: 11px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; text-align: left; }
  .table--stack td.row-actions { justify-content: flex-start; }
  .table--stack td.row-actions::before { content: ""; }
  .table--stack .row-error { max-width: 72vw; white-space: normal; }
}
@media (max-width: 640px) {
  body { font-size: 13.5px; }
  .topbar h1 { font-size: 17px; }
  .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat-value { font-size: 23px; }
  .account-grid, .gallery-grid { grid-template-columns: 1fr; }
  .gallery-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .chart { height: 140px; gap: 3px; }
  .bar-day { font-size: 9px; }
  .bar-col:nth-child(odd) .bar-day { visibility: hidden; }
  .bar-col.is-selected .bar-day { visibility: visible; }
  .chart-legend { gap: 12px; }
  .filter-bar .logs-status { margin-left: 0; width: 100%; }
  .save-bar { bottom: calc(76px + env(safe-area-inset-bottom)); }
  .form-grid { grid-template-columns: 1fr; }
  .dialog-body { padding: 16px; }
  .lightbox-nav { width: 38px; height: 38px; }
  .btn { min-height: 42px; }
  .btn.small, .btn.icon-only { min-height: 36px; }
  .icon-btn { width: 40px; height: 40px; }
  .auto-refresh { padding: 0 9px; }
  .auto-refresh-text { display: none; }
}
@media (hover: none) {
  .gallery-overlay { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
body.is-booting .app, body.is-booting .bottom-nav { visibility: hidden; }
.boot-error { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; max-width: 480px; margin: 48px auto; }
.boot-error[hidden] { display: none; }
`;

export const LOGIN_STYLE = `
:root {
  --font-sans: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace;
  --radius: 12px;
  --radius-lg: 18px;
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  color-scheme: dark;
  --bg: #070b13;
  --surface: #0e1524;
  --surface-2: #141e31;
  --border: #233150;
  --border-strong: #334566;
  --text: #e8eefb;
  --muted: #94a3bb;
  --faint: #6b7c96;
  --accent: #22c55e;
  --accent-strong: #16a34a;
  --accent-text: #4ade80;
  --accent-soft: rgba(34, 197, 94, 0.14);
  --on-accent: #052e16;
  --danger: #f87171;
  --danger-soft: rgba(248, 113, 113, 0.12);
  --ring: #4ade80;
  --glow: rgba(34, 197, 94, 0.12);
  --glow-alt: rgba(56, 189, 248, 0.08);
  --shadow: 0 30px 90px rgba(2, 6, 23, 0.6);
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f3f6fa;
  --surface: #ffffff;
  --surface-2: #eef3f8;
  --border: #dbe4ee;
  --border-strong: #c2d0e0;
  --text: #0f1b2d;
  --muted: #55677f;
  --faint: #5b6b80;
  --accent: #15803d;
  --accent-strong: #166534;
  --accent-text: #15803d;
  --accent-soft: #dcfce7;
  --on-accent: #ffffff;
  --danger: #b91c1c;
  --danger-soft: #fee2e2;
  --ring: #16a34a;
  --glow: rgba(21, 128, 61, 0.09);
  --glow-alt: rgba(29, 78, 216, 0.06);
  --shadow: 0 24px 70px rgba(15, 27, 45, 0.16);
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  min-height: 100dvh; display: grid; place-items: center; padding: 28px 18px;
  background: var(--bg); color: var(--text);
  font: 14px/1.55 var(--font-sans); -webkit-font-smoothing: antialiased;
}
body::before {
  content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background:
    radial-gradient(760px 420px at 18% 0%, var(--glow), transparent 70%),
    radial-gradient(620px 380px at 88% 12%, var(--glow-alt), transparent 70%);
}
.card {
  width: min(400px, 100%); padding: 30px;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  border: 1px solid var(--border-strong); border-radius: var(--radius-lg);
  box-shadow: var(--shadow); backdrop-filter: blur(18px);
}
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
.brand svg { width: 42px; height: 42px; flex: none; filter: drop-shadow(0 8px 18px rgba(34, 197, 94, 0.28)); }
.brand-name { font-size: 16px; font-weight: 750; letter-spacing: -0.01em; }
.brand-sub { font-size: 11.5px; color: var(--muted); margin-top: 1px; }
h1 { margin: 0 0 6px; font-size: 21px; letter-spacing: -0.02em; }
.hint { margin: 0 0 22px; color: var(--muted); font-size: 13px; line-height: 1.6; }
.hint code { font-family: var(--font-mono); font-size: 11.5px; padding: 1px 5px; border-radius: 5px; background: var(--surface-2); border: 1px solid var(--border); }
label { display: block; font-weight: 650; margin-bottom: 7px; font-size: 12.5px; }
.input-wrap { position: relative; }
input {
  width: 100%; min-height: 44px; padding: 10px 48px 10px 13px;
  border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2);
  color: var(--text); font: inherit;
  transition: border-color 140ms var(--ease), box-shadow 140ms var(--ease);
}
input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.reveal {
  position: absolute; right: 5px; top: 50%; transform: translateY(-50%);
  width: 36px; height: 36px; display: grid; place-items: center;
  border: 0; border-radius: 8px; background: transparent; color: var(--muted);
}
.reveal:hover { background: var(--border); color: var(--text); }
.reveal { cursor: pointer; }
.icon { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.pw-show, .pw-hide { display: inline-flex; }
.pw-hide { display: none; }
.reveal[aria-pressed="true"] .pw-show { display: none; }
.reveal[aria-pressed="true"] .pw-hide { display: inline-flex; }
button[type="submit"] {
  width: 100%; min-height: 44px; margin-top: 18px; padding: 0 16px;
  border: 0; border-radius: 10px; background: var(--accent); color: var(--on-accent);
  font: inherit; font-weight: 700; cursor: pointer;
  transition: background 140ms var(--ease), transform 140ms var(--ease);
}
button[type="submit"]:hover { background: var(--accent-strong); }
button[type="submit"]:active { transform: translateY(1px); }
button[type="submit"]:disabled { opacity: 0.6; cursor: progress; }
.error {
  min-height: 18px; margin: 12px 0 0; padding: 0; color: var(--danger);
  font-size: 12.5px; line-height: 1.5;
}
.error:not(:empty) { padding: 9px 12px; border-radius: 9px; background: var(--danger-soft); }
.foot { margin: 18px 0 0; padding-top: 16px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--faint); }
.card[data-page="setup"] { width: min(520px, 100%); }
.storage-choice {
  display: grid; gap: 10px; margin: 0 0 16px; padding: 12px;
  border: 1px solid var(--border); border-radius: 12px;
}
.storage-choice legend { padding: 0 6px; font-size: 12.5px; font-weight: 650; color: var(--muted); }
.choice {
  display: flex; align-items: flex-start; gap: 10px; margin: 0;
  font-weight: 500; font-size: 13px; cursor: pointer;
}
.choice input { flex: none; width: 18px; min-height: 18px; margin-top: 2px; padding: 0; }
.choice span { display: grid; gap: 2px; }
.choice small { color: var(--muted); font-size: 11.5px; font-weight: 400; }
[data-role="imgbed-fields"] { margin-bottom: 4px; }
[data-role="imgbed-fields"] input { padding-right: 13px; margin-bottom: 6px; }
[data-role="imgbed-fields"] .hint { display: block; margin: 0 0 14px; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
`;
