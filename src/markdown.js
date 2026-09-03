/**
 * A very small Markdown renderer.
 *
 * Models emit Markdown whether or not you ask them to, so a chat UI that prints
 * raw text shows people `**What is WebGPU?**` and looks broken. This handles the
 * subset that actually turns up in replies: fenced code, headings, bold, italic,
 * inline code, links, and both kinds of list.
 *
 * HTML is escaped before anything else runs. The input is model output, which is
 * shaped by whatever the user pasted into the conversation, so it is treated as
 * untrusted throughout - every construct below emits tags around escaped text,
 * never text that becomes tags.
 */

const escape = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline constructs, applied to already-escaped text. */
function inline(text) {
  return text
    // `code` first: nothing inside a code span should be interpreted further.
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\b_([^_\n]+)_\b/g, "<em>$1</em>")
    // Only http(s) links become anchors, and they always open safely.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function markdown(src) {
  const out = [];
  const lines = escape(String(src ?? "")).split("\n");
  let i = 0;
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) { out.push(`<p>${inline(paragraph.join(" "))}</p>`); paragraph = []; }
  };
  const flushList = () => {
    if (list) { out.push(`<${list.tag}>${list.items.join("")}</${list.tag}>`); list = null; }
  };
  const flush = () => { flushParagraph(); flushList(); };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code: consumed verbatim, no inline processing inside.
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${body.join("\n")}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(`<li>${inline((bullet ?? numbered)[1])}</li>`);
      i++;
      continue;
    }

    if (!line.trim()) { flush(); i++; continue; }

    flushList();
    paragraph.push(line.trim());
    i++;
  }

  flush();
  return out.join("");
}
