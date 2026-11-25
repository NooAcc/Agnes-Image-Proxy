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
.generation-parameters { display: grid; grid-template-columns: minmax(0, 3fr) repeat(3, minmax(0, 1fr)); gap: 10px; }
.generation-hint { color: var(--muted); font-size: 12px; line-height: 1.55; margin: 0; }
.generation-more { border-top: 1px solid var(--border); padding-top: 12px; }
.generation-more summary { color: var(--muted); cursor: pointer; font-size: 13px; }
.generation-custom-row { display: grid; grid-template-columns: minmax(0, 2fr) repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.generation-reference-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.generation-reference-head label { font-weight: 600; font-size: 13px; }
.generation-reference-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.generation-reference-actions .btn, .generation-reference-controls .btn { min-height: 36px; }
.generation-drop { display: grid; gap: 8px; padding: 12px; border: 1px dashed var(--border-strong); border-radius: 10px; background: var(--surface-2); }
.generation-drop input { width: 100%; max-width: 100%; min-width: 0; min-height: 44px; padding: 5px; }
.generation-drop input::file-selector-button { padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; margin-right: 10px; cursor: pointer; }
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
@media (max-width: 1300px) { .generation-parameters { grid-template-columns: repeat(3, minmax(0, 1fr)); } .generation-parameters > :first-child { grid-column: 1 / -1; } }
@media (max-width: 1000px) { .generation-layout { grid-template-columns: minmax(0, 1fr); } .generation-empty { min-height: 260px; } }
@media (max-width: 640px) {
  .generation-heading, .generation-form { padding: 16px; }
  .generation-preview-body { padding: 12px; }
  .generation-parameters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .generation-custom-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .generation-custom-row > :first-child { grid-column: 1 / -1; }
  .generation-picker-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .generation-reference-actions .btn, .generation-reference-controls .btn { min-height: 44px; }
}
`;
