/**
 * Minimal DOM helpers.
 *
 * No framework, for the same reason there is no build step: the whole project
 * has to stay a folder of static files that a browser can run directly. These
 * six functions are the entire abstraction.
 */

/** el("div.card", { onclick }, child, child) - tag, #id and .classes in one string. */
export function el(spec, props = {}, ...children) {
  const [tag = "div", ...classes] = spec.split(".");
  const [name, id] = tag.split("#");
  const node = document.createElement(name || "div");
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(" ");

  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = `${node.className} ${value}`.trim();
    else if (key === "html") node.innerHTML = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== "list") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }

  add(node, children);
  return node;
}

function add(parent, children) {
  for (const child of children.flat(4)) {
    // `list.length && el(...)` yields 0, not false, when the list is empty -
    // and 0 is a perfectly good text node, so it renders as a stray "0" beside
    // real content. Nothing here ever wants a bare number as a child, so the
    // guard treats it as the conditional it was meant to be.
    if (child == null || child === false || child === 0 || child === "") continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const clear = (node) => {
  while (node.firstChild) node.firstChild.remove();
  return node;
};

export const fill = (node, ...children) => {
  clear(node);
  add(node, children);
  return node;
};

/** Human-readable relative time, for journal entries and saved articles. */
export function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const units = [
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.35, "week"],
    [12, "month"],
  ];
  let value = s / 60;
  let label = "minute";
  for (const [size, next] of units) {
    if (value < size) break;
    value /= size;
    label = next;
  }
  const n = Math.floor(value);
  return `${n} ${label}${n === 1 ? "" : "s"} ago`;
}

/** A 0-5 style segmented meter. Colour follows severity, not value. */
export function meter(value, max = 5, tone = "") {
  const bar = el(`div.meter${tone ? `.${tone}` : ""}`);
  for (let i = 0; i < max; i++) bar.append(el(`i${i < Math.round(value) ? ".on" : ""}`));
  return bar;
}

export const titleCase = (s) => String(s ?? "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
