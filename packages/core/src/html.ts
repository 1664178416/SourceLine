const HTML_TAG_PATTERN = /<\/?([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
const HTML_ATTRIBUTE_PATTERN = /\s+([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const HIDDEN_STYLE_PATTERN = /\b(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;
const VOID_HTML_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);
const HTML_ENTITY_PATTERN = /&(?:#(\d+)|#x([0-9a-f]+)|(nbsp|amp|lt|gt|quot|apos));/gi;
const HTML_NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'"
};

export function htmlToText(html: string): string {
  return extractVisibleHtmlBody(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(p|div|section|article|header|footer|main|aside|nav|li|h[1-6]|blockquote|tr)\b[^>]*>/gi, "\n\n")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|li|h[1-6]|blockquote|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(HTML_ENTITY_PATTERN, decodeHtmlEntity)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntity(
  match: string,
  decimalCodePoint: string | undefined,
  hexadecimalCodePoint: string | undefined,
  namedEntity: string | undefined
): string {
  if (namedEntity !== undefined) {
    return HTML_NAMED_ENTITIES[namedEntity.toLowerCase()] ?? match;
  }

  return hexadecimalCodePoint === undefined
    ? decodeHtmlCodePoint(decimalCodePoint ?? "", 10, match)
    : decodeHtmlCodePoint(hexadecimalCodePoint, 16, match);
}

function extractVisibleHtmlBody(html: string): string {
  const visibleHtml = sanitizeHtmlStructure(html);
  const body = visibleHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? visibleHtml;
  return removeHiddenHtmlElements(body);
}

function sanitizeHtmlStructure(html: string): string {
  return removeHtmlNonContentElements(removeHtmlComments(html));
}

function removeHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ");
}

function removeHiddenHtmlElements(html: string): string {
  const openElements: Array<{ name: string; hidesContent: boolean }> = [];
  const hiddenRanges: Array<{ start: number; end: number }> = [];
  let hiddenDepth = 0;
  let hiddenStart: number | undefined;

  for (const match of html.matchAll(HTML_TAG_PATTERN)) {
    const tag = match[0];
    const name = match[1]?.toLowerCase();
    const index = match.index;
    if (!name || index === undefined) {
      continue;
    }

    if (tag.startsWith("</")) {
      const matchingIndex = findLastOpenElement(openElements, name);
      if (matchingIndex < 0) {
        continue;
      }

      for (let stackIndex = openElements.length - 1; stackIndex >= matchingIndex; stackIndex -= 1) {
        const element = openElements.pop();
        if (element?.hidesContent) {
          hiddenDepth -= 1;
        }
      }
      if (hiddenDepth === 0 && hiddenStart !== undefined) {
        hiddenRanges.push({ start: hiddenStart, end: index + tag.length });
        hiddenStart = undefined;
      }
      continue;
    }

    const selfClosing = /\/\s*>$/.test(tag) || VOID_HTML_ELEMENTS.has(name);
    if (selfClosing) {
      continue;
    }

    const hidesContent = hasHiddenHtmlAttribute(tag);
    if (hidesContent && hiddenDepth === 0) {
      hiddenStart = index;
    }
    if (hidesContent) {
      hiddenDepth += 1;
    }
    openElements.push({ name, hidesContent });
  }

  if (hiddenStart !== undefined) {
    hiddenRanges.push({ start: hiddenStart, end: html.length });
  }

  return removeHtmlRanges(html, hiddenRanges);
}

function findLastOpenElement(elements: Array<{ name: string }>, name: string): number {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    if (elements[index]?.name === name) {
      return index;
    }
  }

  return -1;
}

function hasHiddenHtmlAttribute(tag: string): boolean {
  for (const match of tag.matchAll(HTML_ATTRIBUTE_PATTERN)) {
    const name = match[1]?.toLowerCase();
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (name === "hidden") {
      return true;
    }
    if (name === "aria-hidden" && value.toLowerCase() === "true") {
      return true;
    }
    if (name === "style" && HIDDEN_STYLE_PATTERN.test(value)) {
      return true;
    }
  }

  return false;
}

function removeHtmlRanges(html: string, ranges: Array<{ start: number; end: number }>): string {
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    result += `${html.slice(cursor, range.start)} `;
    cursor = range.end;
  }

  return result + html.slice(cursor);
}

function removeHtmlNonContentElements(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ");
}

function decodeHtmlCodePoint(value: string, radix: number, fallback: string): string {
  const codePoint = Number.parseInt(value, radix);
  if (
    !Number.isSafeInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  ) {
    return fallback;
  }

  return String.fromCodePoint(codePoint);
}
