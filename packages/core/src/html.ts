const HIDDEN_HTML_ELEMENT_PATTERN = new RegExp(
  String.raw`<([a-z][\w:-]*)\b(?=[^>]*(?:${[
    String.raw`\saria-hidden\s*=\s*(?:"true"|'true'|true)(?=\s|>|\/)`,
    String.raw`\shidden(?:\s|=|>|\/)`,
    String.raw`\sstyle\s*=\s*(?:"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"|'[^']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^']*')`
  ].join("|")}))[^>]*>[\s\S]*?<\/\1>`,
  "gi"
);
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
  return html.replace(HIDDEN_HTML_ELEMENT_PATTERN, " ");
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
