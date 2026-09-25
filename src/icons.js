
const P = (d) => `<path d="${d}"/>`;

const ICONS = {
  gauge: P("M2.5 12.5h11") + P("M3.6 12.5a4.4 4.4 0 0 1 8.8 0") + P("M8 12.5 10.8 8.2"),

  pen: P("M2.5 13.5l.9-3.3 7.6-7.6 2.4 2.4-7.6 7.6z") + P("M9.9 4.9l2.4 2.4"),

  export: P("M8 9V2") + P("M5.2 4.8 8 2l2.8 2.8") + P("M2.5 10.5v1.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5"),

  import: P("M8 2v7") + P("M5.2 6.2 8 9l2.8-2.8") + P("M2.5 10.5v1.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5"),

  exportAll: P("M2.5 13.5h11") + P("M4.5 11h7") + P("M8 2v6") + P("M5.5 5.5 8 8l2.5-2.5"),

  x: P("M3.5 3.5l9 9") + P("M12.5 3.5l-9 9"),

  swap: P("M2.5 5.5h9.5") + P("M9.5 3 12 5.5 9.5 8") + P("M13.5 10.5H4") + P("M6.5 8 4 10.5 6.5 13"),

  capture: `<path d="M2.5 9.6v2.9A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V9.6"/>` + P("M8 2v7.3") + P("M5.3 6.8 8 9.5l2.7-2.7"),

  // 礼物：盒盖 + 盒身 + 竖丝带 + 两侧蝴蝶结
  gift:
    `<rect x="2.6" y="6.6" width="10.8" height="2.6" rx=".7"/>` +
    `<rect x="3.9" y="9.9" width="8.2" height="4.1" rx=".7"/>` +
    P("M8 6.6v7.4") +
    P("M8 6.5C6.6 6.5 5.4 5.6 5.4 4.4c0-1.4 2-1.7 2.6 2.1z") +
    P("M8 6.5c1.4 0 2.6-.9 2.6-2.1 0-1.4-2-1.7-2.6 2.1z"),

  // 自动领取：小礼物 + 循环弧 → “反复领取”
  giftRepeat:
    `<rect x="2.3" y="7.2" width="8.6" height="2.2" rx=".6"/>` +
    `<rect x="3.4" y="10" width="6.4" height="3.8" rx=".6"/>` +
    P("M6.6 7.2v6.6") +
    P("M6.6 7.1c-1.1 0-2.1-.7-2.1-1.7 0-1.1 1.6-1.4 2.1 1.7z") +
    P("M6.6 7.1c1.1 0 2.1-.7 2.1-1.7 0-1.1-1.6-1.4-2.1 1.7z") +
    P("M11.7 3.6a2.3 2.3 0 1 1 1.4 4.1"),

  refresh: P("M13.5 8a5.5 5.5 0 1 1-1.6-3.9") + P("M13.5 2.5V6.5h-4"),

  userPlus: P("M6 6.8a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6") + P("M2 13.5v-.9a4 4 0 0 1 8 0v.9") + P("M12 5.5v4") + P("M10 7.5h4"),

  play: `<path d="M5 3.2v9.6l8.2-4.8z" fill="currentColor" stroke="none"/>`,

  power: P("M8 2v5.5") + P("M4.6 4.3a5 5 0 1 0 6.8 0"),

  sliders: P("M2 4.5h12") + P("M2 11.5h12") + `<rect x="8.5" y="2.5" width="4" height="4"/>` + `<rect x="3.5" y="9.5" width="4" height="4"/>`,

  lock: `<rect x="3.5" y="7.2" width="9" height="6.3"/>` + P("M5.5 7.2V5a2.5 2.5 0 0 1 5 0v2.2") + P("M8 9.7v1.8"),

  snow: P("M8 1.4v13.2") + P("M2.1 4.7l11.8 6.6") + P("M13.9 4.7L2.1 11.3")
    + P("M6.1 2.9 8 4.6l1.9-1.7") + P("M6.1 13.1 8 11.4l1.9 1.7")
    + P("M2.3 8.4 4.2 7.6 4 5.5") + P("M13.7 8.4 11.8 7.6 12 5.5"),

  lockOpen: `<rect x="3.5" y="7.2" width="9" height="6.3"/>` + P("M5.5 7.2V5a2.5 2.5 0 0 1 4.9-.6") + P("M8 9.7v1.8"),

  check: P("M3 8.6l3.3 3.2L13 4.6"),
  alert: P("M8 2.2 14.8 13.8H1.2z") + P("M8 6.4v3.2") + P("M8 11.6v.2"),

  folder: `<path d="M2.5 5v6.5A1.5 1.5 0 0 0 4 13h8a1.5 1.5 0 0 0 1.5-1.5V6.5A1.5 1.5 0 0 0 12 5H8L6.6 3.5H4A1.5 1.5 0 0 0 2.5 5z"/>`,
  chevDown: P("M4.5 6 8 9.5 11.5 6"),

  arrowDown: P("M8 2.5v9.5") + P("M4.8 8.8 8 12l3.2-3.2"),
  arrowUp: P("M8 13.5V4") + P("M4.8 7.2 8 4l3.2 3.2"),
  bolt: `<path d="M9 1.8 3.8 9.2h3.1L6.6 14.2 11.9 6.7H8.8z"/>`,
  search: `<circle cx="7" cy="7" r="4.3"/>` + P("M10.2 10.2 14 14"),

  browser: `<rect x="2.2" y="3.4" width="11.6" height="9.2" rx="1.4"/>` + P("M2.2 6.2h11.6") + `<circle cx="4.3" cy="4.8" r=".7" fill="currentColor" stroke="none"/>`,

  eye: `<path d="M1.8 8s2.4-4.2 6.2-4.2S14.2 8 14.2 8s-2.4 4.2-6.2 4.2S1.8 8 1.8 8z"/>` + `<circle cx="8" cy="8" r="1.8"/>`,
  eyeOff: `<path d="M1.8 8s2.4-4.2 6.2-4.2S14.2 8 14.2 8s-2.4 4.2-6.2 4.2S1.8 8 1.8 8z"/>` + `<circle cx="8" cy="8" r="1.8"/>` + P("M3 16 13 0"),
  xCircle: `<circle cx="8" cy="8" r="5.5"/>` + P("M6.2 6.2l3.6 3.6") + P("M9.8 6.2 6.2 9.8"),

  empty: P("M3 3h10") + P("M3 13h10") + `<path d="M8 6.2v3.6M6.2 8h3.6" stroke-dasharray="2 1.6"/>`,

  copy: `<rect x="5.6" y="5.6" width="8" height="8" rx="1.2"/>` + `<path d="M10.4 3.4V3A1.4 1.4 0 0 0 9 1.6H3.4A1.4 1.4 0 0 0 2 3v5.6A1.4 1.4 0 0 0 3.4 10h.4"/>`,

  plug: P("M6 2v3.2") + P("M10 2v3.2") + `<path d="M4.2 5.2h7.6v2.4A3.8 3.8 0 0 1 8 11.4a3.8 3.8 0 0 1-3.8-3.8z"/>` + P("M8 11.4v2.6"),

  target: `<circle cx="8" cy="8" r="5"/>` + `<circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/>` + P("M8 1v2.2") + P("M8 12.8V15") + P("M1 8h2.2") + P("M12.8 8H15"),

  restart: P("M13.4 8a5.4 5.4 0 1 1-1.58-3.82") + P("M13.5 2.6v3.2h-3.2") + P("M8 5.4v2.6"),
};

export function ic(name, size = 16, cls = "") {
  const body = ICONS[name];
  if (!body) return "";
  return `<svg class="ic${cls ? " " + cls : ""}" width="${size}" height="${size}" viewBox="0 0 16 16"
    fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">${body}</svg>`;
}
