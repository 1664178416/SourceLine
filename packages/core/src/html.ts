const HIDDEN_HTML_ELEMENT_PATTERN = new RegExp(
  String.raw`<([a-z][\w:-]*)\b(?=[^>]*(?:${[
    String.raw`\saria-hidden\s*=\s*(?:"true"|'true'|true)(?=\s|>|\/)`,
    String.raw`\shidden(?:\s|=|>|\/)`,
    String.raw`\sstyle\s*=\s*(?:"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"|'[^']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^']*')`
  ].join("|")}))[^>]*>[\s\S]*?<\/\1>`,
  "gi"
);

export function htmlToText(html: string): string {
  return extractVisibleHtmlBody(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(p|div|section|article|header|footer|main|aside|nav|li|h[1-6]|blockquote|tr)\b[^>]*>/gi, "\n\n")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|li|h[1-6]|blockquote|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, codePoint: string) => decodeHtmlCodePoint(codePoint, 10, match))
    .replace(/&#x([0-9a-f]+);/gi, (match, codePoint: string) => decodeHtmlCodePoint(codePoint, 16, match))
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return fallback;
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}
