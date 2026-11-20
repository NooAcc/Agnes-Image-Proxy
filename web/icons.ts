const PATHS: Record<string, string> = {
  overview:
    '<rect x="3" y="3" width="7.5" height="7.5" rx="1.7"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.7"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.7"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.7"/>',
  gallery:
    '<rect x="3" y="4.5" width="18" height="15" rx="2.4"/><circle cx="9" cy="10" r="1.8"/><path d="M4.5 17.5l4.6-4.4 3.5 3.3 3-2.8 4 3.7"/>',
  accounts:
    '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 19.5c0-3.4 2.9-5.8 6.5-5.8s6.5 2.4 6.5 5.8"/>',
  logs: '<rect x="4.5" y="3.5" width="15" height="17" rx="2.2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  settings:
    '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V5M7.5 9.5L12 5l4.5 4.5"/><path d="M5 19h14"/>',
  bolt: '<path d="M13 3L5 14h5.5l-1 7L18 10h-5.5z"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4.5V10h-5.5"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7"/><path d="M10 11v5M14 11v5"/>',
  logout: '<path d="M10 5H5v14h5"/><path d="M14.5 8.5L18 12l-3.5 3.5M18 12H9"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  sun:
    '<circle cx="12" cy="12" r="3.6"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/>',
  moon: '<path d="M20 14.5A8.2 8.2 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  search: '<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6L20 20"/>',
  copy:
    '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2.5"/>',
  download: '<path d="M12 4.5v10M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
  chevronLeft: '<path d="M14.5 6L8.5 12l6 6"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4.2L21 19.5H3z"/><path d="M12 9.5v4.2M12 16.6v.1"/>',
  power: '<path d="M12 3.5v8"/><path d="M7 6.4a7.5 7.5 0 1 0 10 0"/>',
  pencil:
    '<path d="M4.5 19.5l.8-4L16.4 4.4a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.5 18.7z"/><path d="M14.5 6.3l3.2 3.2"/>',
  external:
    '<path d="M13.5 5H19v5.5"/><path d="M19 5l-7.5 7.5"/><path d="M18 14.5V18a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18V7a1.5 1.5 0 0 1 1.5-1.5H9"/>',
  clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.5V12l3 1.8"/>',
  image:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17.5l4.5-4.3 3.4 3.2 3-2.7 4.1 3.8"/>',
  key:
    '<circle cx="8" cy="15.5" r="3.6"/><path d="M10.6 12.9L19.5 4M15.5 8l2.5 2.5M18 5.5L20.5 8"/>',
  eye:
    '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff:
    '<path d="M4 4l16 16"/><path d="M9.9 5.2A9.7 9.7 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-2.3 3.3M6.3 7.4A16.8 16.8 0 0 0 2.5 12S6 19 12 19a9.5 9.5 0 0 0 3.6-.7"/><path d="M10 10a2.8 2.8 0 0 0 4 4"/>',
  list:
    '<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  filter: '<path d="M4 5.5h16l-6.2 7.2v5.6l-3.6 1.7v-7.3z"/>',
  info: '<circle cx="12" cy="12" r="8.2"/><path d="M12 11v5M12 8.2v.1"/>',
};

export function icon(name: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}

export const ICON_SPRITE = `<svg aria-hidden="true" style="display:none">${
  Object.entries(PATHS)
    .map(([name, path]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${path}</symbol>`)
    .join("")
}</svg>`;

/** Inline SVG favicon (URL-encoded; no external request). */
export const FAVICON_URI =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2040%2040%22%3E%3Crect%20width%3D%2240%22%20height%3D%2240%22%20rx%3D%2211%22%20fill%3D%22%2316a34a%22%2F%3E%3Cpath%20d%3D%22M20%209.5l2.5%206.4%206.5%202.4-6.5%202.4L20%2027l-2.5-6.3L11%2018.3l6.5-2.4z%22%20fill%3D%22%23d1fae5%22%2F%3E%3C%2Fsvg%3E";

/** Brand mark: rounded tile with an aperture-style spark. */
export const BRAND_MARK =
  `<svg class="brand-mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
<defs><linearGradient id="brand-grad" x1="4" y1="2" x2="36" y2="38" gradientUnits="userSpaceOnUse">
<stop stop-color="#34d399"/><stop offset="1" stop-color="#0d9488"/></linearGradient></defs>
<rect width="40" height="40" rx="11" fill="url(#brand-grad)"/>
<path d="M20 9.5l2.5 6.4 6.5 2.4-6.5 2.4L20 27l-2.5-6.3L11 18.3l6.5-2.4z" fill="#04220f" opacity=".9"/>
<circle cx="20" cy="18.3" r="1.7" fill="#d1fae5"/>
</svg>`;
