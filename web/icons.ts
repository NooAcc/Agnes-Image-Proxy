const PATHS: Record<string, string> = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  gallery:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M4 18l5-5 4 4 3-3 4 4"/>',
  accounts: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/>',
  logs: '<rect x="5" y="4" width="14" height="16" rx="1.5"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 17V7M7 12l5-5 5 5"/><path d="M5 19h14"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/>',
  logout: '<path d="M10 5H5v14h5"/><path d="M15 8l4 4-4 4M19 12H9"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};

export function icon(name: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}

export const ICON_SPRITE = `<svg aria-hidden="true" style="display:none">${
  Object.entries(PATHS)
    .map(([name, path]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${path}</symbol>`)
    .join("")
}</svg>`;
