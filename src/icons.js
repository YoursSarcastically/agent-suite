/**
 * Icons.
 *
 * SF-Symbols-shaped rather than emoji: single stroke weight, rounded caps,
 * currentColor, 24px grid. Emoji carry their own colour and their own vendor's
 * drawing style, both of which fight a monochrome system - and at 20px they
 * read as decoration rather than as part of the interface.
 */

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

export const ICONS = {
  braindump: svg(`<path d="M4 7h10M4 12h13M4 17h7"/><path d="M18.5 15.5l1.6 1.6 3-3.4"/>`),
  pile: svg(`<path d="M3.5 6.2c2.8-1.2 5.7-1.2 8.5 0 2.8-1.2 5.7-1.2 8.5 0v11.6c-2.8-1.2-5.7-1.2-8.5 0-2.8-1.2-5.7-1.2-8.5 0Z"/><path d="M12 6.2v11.6"/>`),
  journal: svg(`<path d="M5 4.5h11a2.5 2.5 0 0 1 2.5 2.5v12.5H7.5A2.5 2.5 0 0 1 5 17Z"/><path d="M5 17a2.5 2.5 0 0 1 2.5-2.5h11"/><path d="M9 8.5h5.5"/>`),
  recommend: svg(`<path d="M4 5.5h16v11H4Z"/><path d="M8 5.5v11M16 5.5v11"/><path d="M4 11h16"/><path d="M9 20h6"/>`),
  workbench: svg(`<path d="M4 7h9M17 7h3"/><path d="M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.1"/><circle cx="9" cy="17" r="2.1"/>`),
};

/** An <span> wrapper so the icon inherits colour and sizing from its container. */
export function icon(name, className = "icon") {
  const span = document.createElement("span");
  span.className = className;
  span.innerHTML = ICONS[name] ?? "";
  return span;
}
