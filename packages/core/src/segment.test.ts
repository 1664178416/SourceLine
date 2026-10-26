import { describe, expect, it } from "vitest";
import { segmentDocument } from "./segment.js";

describe("segmentDocument", () => {
  it("normalizes classic Mac carriage-return line endings", () => {
    expect(segmentDocument("first line\r\n\r\nsecond line\rthird line")).toEqual([
      {
        id: "segment-1",
        text: "first line",
        startLine: 1,
        endLine: 1
      },
      {
        id: "segment-2",
        text: "second line\nthird line",
        startLine: 3,
        endLine: 4
      }
    ]);
  });
});
