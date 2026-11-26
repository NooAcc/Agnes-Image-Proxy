export const GENERATION_STYLE = `
.content:has(> [data-section="generate"].is-active) { max-width: none; }
.generation-layout { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 16px; align-items: stretch; }
.generation-config, .generation-result { min-width: 0; overflow: hidden; }
.generation-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 20px; border-bottom: 1px solid var(--border); }
.generation-heading h2 { margin: 0; font-size: 16px; font-weight: 650; }
.generation-heading .eyebrow { font-size: 10px; }
.generation-form { padding: 22px 20px 18px; }
.generation-form fieldset { display: flex; flex-direction: column; gap: 18px; padding: 0; margin: 0; border: 0; min-width: 0; }
.generation-field { min-width: 0; }
.generation-field label, .generation-dialog-label { display: block; margin-bottom: 7px; font-size: 13px; font-weight: 600; }
.generation-field .input { width: 100%; min-height: 44px; font-size: 14px; }
.generation-field textarea { min-height: 185px; resize: vertical; line-height: 1.65; }
.generation-parameters { display: grid; grid-template-columns: minmax(0, 2.5fr) repeat(2, minmax(0, 1fr)) minmax(0, 2.5fr); gap: 10px; }
.generation-resolution-controls { display: flex; align-items: center; gap: 8px; }
.generation-resolution-input { flex: 1; min-width: 0; }
.generation-resolution-input .input { width: 100%; min-width: 0; }
.generation-resolution-input [hidden] { display: none; }
.generation-resolution-controls .generation-size-toggle { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; margin: 0; flex: none; white-space: nowrap; font-weight: 400; cursor: pointer; }
.generation-size-toggle input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
.generation-hint { color: var(--muted); font-size: 12px; line-height: 1.55; margin: 0; }
.generation-reference-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.generation-reference-label { font-weight: 600; font-size: 13px; }
.generation-reference-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.generation-reference-head .generation-follow-size { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; font-size: 13px; cursor: pointer; }
.generation-follow-size input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
.generation-reference-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.generation-reference-actions .btn, .generation-reference-controls .btn { min-height: 36px; }
.generation-drop { display: grid; place-content: center; gap: 4px; width: 100%; min-height: 72px; padding: 12px; border: 1px dashed var(--border-strong); border-radius: 10px; background: var(--surface-2); text-align: center; }
.generation-drop:not(:disabled):hover { border-color: var(--accent); background: var(--accent-soft); }
.generation-drop:disabled { cursor: not-allowed; opacity: .6; }
.generation-references { display: grid; grid-template-columns: repeat(auto-fill, minmax(125px, 1fr)); gap: 12px; }
.generation-reference { min-width: 0; }
.generation-reference-thumb { display: grid; place-items: center; width: 100%; aspect-ratio: 1; padding: 0; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); overflow: hidden; cursor: pointer; }
.generation-reference-thumb img { width: 100%; height: 100%; object-fit: cover; }
.generation-reference-name { font-size: 12px; margin: 5px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.generation-reference-controls { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 5px; }
.generation-reference-controls .btn { padding: 4px 7px; font-size: 11px; }
.generation-error { padding: 10px 12px; background: var(--danger-soft); color: var(--danger); border-radius: 8px; font-size: 13px; overflow-wrap: anywhere; }
.generation-error[hidden] { display: none; }
.generation-footnote { margin: 16px 0 0; padding-top: 14px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
.generation-preview-body { padding: 18px; }
.generation-empty { min-height: 380px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; color: var(--muted); padding: 20px; font-size: 12px; }
.generation-empty > .icon { width: 42px; height: 42px; color: var(--accent-text); }
.generation-empty strong { color: var(--text); font-size: 14px; font-weight: 600; }
.generation-preview { display: grid; place-items: center; min-height: 380px; background: var(--surface-2); border-radius: 10px; overflow: hidden; }
.generation-preview img { display: block; width: 100%; height: min(65vh, 620px); min-height: 300px; object-fit: contain; }
.generation-empty[hidden], .generation-preview[hidden], .generation-numbers[hidden] { display: none; }
.generation-preview-error { padding-top: 12px; text-align: center; }
.generation-numbers { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; margin-top: 15px; }
.generation-number { min-width: 44px; min-height: 44px; }
.generation-number[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-text); font-weight: 700; }
.generation-picker { width: min(760px, calc(100vw - 32px)); }
.generation-picker-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
.generation-picker-item { min-width: 0; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); color: var(--text); overflow: hidden; cursor: pointer; text-align: left; }
.generation-picker-item img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; }
.generation-picker-item span { display: block; padding: 8px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.generation-reference-dialog { width: min(800px, calc(100vw - 32px)); }
.generation-reference-dialog img { display: block; width: 100%; max-height: 70vh; object-fit: contain; }
@media (max-width: 1300px) { .generation-parameters { grid-template-columns: repeat(2, minmax(0, 1fr)) minmax(0, 2fr); } .generation-parameters > :first-child { grid-column: 1 / -1; } }
@media (max-width: 1000px) { .generation-layout { grid-template-columns: minmax(0, 1fr); } .generation-empty { min-height: 260px; } }
@media (max-width: 640px) {
  .generation-heading, .generation-form { padding: 16px; }
  .generation-preview-body { padding: 12px; }
  .generation-parameters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .generation-resolution { grid-column: 1 / -1; }
  .generation-picker-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .generation-reference-actions .btn, .generation-reference-controls .btn { min-height: 44px; }
}
`;
