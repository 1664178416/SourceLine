import type { DocumentSegment } from "./types.js";

export function segmentDocument(text: string): DocumentSegment[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const segments: DocumentSegment[] = [];
  let current: string[] = [];
  let startLine = 1;

  const flush = (endLine: number): void => {
    const segmentText = current.join("\n").trim();
    if (segmentText.length === 0) {
      current = [];
      return;
    }

    segments.push({
      id: `segment-${segments.length + 1}`,
      text: segmentText,
      startLine,
      endLine
    });
    current = [];
  };

  lines.forEach((line, index) => {
    if (line.trim().length === 0) {
      flush(index);
      startLine = index + 2;
      return;
    }

    if (current.length === 0) {
      startLine = index + 1;
    }
    current.push(line);
  });

  flush(lines.length);
  return segments;
}
