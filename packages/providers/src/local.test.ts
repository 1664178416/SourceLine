import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { clearLocalIndexCache, createLocalSearchProvider, getLocalIndexCacheInfo } from "./local.js";

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function documentHash(title: string, text: string): string {
  return createHash("sha256").update(title).update("\0").update(text).digest("hex");
}

describe("createLocalSearchProvider", () => {
  it("rejects blank local source roots at provider and cache entry points", async () => {
    expect(() => createLocalSearchProvider({ rootDir: "   " })).toThrow("Local sources rootDir must not be empty.");
    await expect(getLocalIndexCacheInfo({ rootDir: "   " })).rejects.toThrow("Local sources rootDir must not be empty.");
    await expect(clearLocalIndexCache({ rootDir: "   " })).rejects.toThrow("Local sources rootDir must not be empty.");
  });

  it("rejects local source roots with control characters at provider and cache entry points", async () => {
    expect(() => createLocalSearchProvider({ rootDir: "examples\nsources" })).toThrow(
      "Local sources rootDir must not contain control characters."
    );
    await expect(getLocalIndexCacheInfo({ rootDir: "examples\nsources" })).rejects.toThrow(
      "Local sources rootDir must not contain control characters."
    );
    await expect(clearLocalIndexCache({ rootDir: "examples\nsources" })).rejects.toThrow(
      "Local sources rootDir must not contain control characters."
    );
  });

  it("rejects overlong local source roots at provider and cache entry points", async () => {
    const rootDir = "s".repeat(2_001);

    expect(() => createLocalSearchProvider({ rootDir })).toThrow("Local sources rootDir must be at most 2000 characters.");
    await expect(getLocalIndexCacheInfo({ rootDir })).rejects.toThrow("Local sources rootDir must be at most 2000 characters.");
    await expect(clearLocalIndexCache({ rootDir })).rejects.toThrow("Local sources rootDir must be at most 2000 characters.");
  });

  it("finds matching Markdown chunks from a source folder", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "notes.md"),
        "# SourceLine Notes\n\nMarkdown and JSON reports make verification easier to share.\n\nUnrelated note.",
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "Markdown JSON verification reports",
        maxResults: 2
      });

      expect(results[0]?.provider).toBe("local");
      expect(results[0]?.title).toContain("SourceLine Notes");
      expect(results[0]?.snippet).toContain("Markdown and JSON reports");
      expect(results[0]?.path).toMatch(/notes\.md$/);
      expect(results[0]?.retrieval?.score).toBeGreaterThan(0);
      expect(results[0]?.retrieval?.matchedTerms).toEqual(expect.arrayContaining(["markdown", "json", "reports"]));
      expect(results[0]?.retrieval?.explanation).toContain("query terms matched");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("finds CJK evidence without whitespace-delimited words", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-cjk-1781067948639`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "zh.md"),
        "# \u4e2d\u6587\u8bc1\u636e\n\n\u672c\u5730\u68c0\u7d22\u53ef\u4ee5\u627e\u5230\u6ca1\u6709\u7a7a\u683c\u7684\u4e2d\u6587\u8bc1\u636e\u3002",
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "\u4e2d\u6587\u8bc1\u636e \u672c\u5730\u68c0\u7d22",
        maxResults: 2
      });

      expect(results[0]?.provider).toBe("local");
      expect(results[0]?.title).toContain("\u4e2d\u6587\u8bc1\u636e");
      expect(results[0]?.snippet).toContain("\u672c\u5730\u68c0\u7d22\u53ef\u4ee5\u627e\u5230\u6ca1\u6709\u7a7a\u683c\u7684\u4e2d\u6587\u8bc1\u636e");
      expect(results[0]?.retrieval?.matchedTerms).toEqual(
        expect.arrayContaining(["\u4e2d\u6587", "\u8bc1\u636e", "\u672c\u5730", "\u68c0\u7d22"])
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("uses stable non-empty result ids for non-ASCII source paths", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-cjk-id-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, "\u8bc1\u636e.md"), "# A\n\nSourceLine \u672c\u5730\u8bc1\u636e marker one.", "utf8");
      await writeFile(join(rootDir, "\u4e8b\u5b9e.md"), "# B\n\nSourceLine \u672c\u5730\u8bc1\u636e marker two.", "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "SourceLine \u672c\u5730\u8bc1\u636e marker",
        maxResults: 2
      });
      const ids = results.map((result) => result.id);
      const rawCache = await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8");
      const cache = JSON.parse(rawCache) as { entries?: Array<{ document?: { id?: string } }> };
      const cacheIds = cache.entries?.map((entry) => entry.document?.id) ?? [];

      expect(results).toHaveLength(2);
      expect(ids.every((id) => /^md-[a-z0-9]+#chunk-\d+$/.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(2);
      expect(cacheIds.every((id) => typeof id === "string" && /^md-[a-z0-9]+$/.test(id))).toBe(true);
      expect(new Set(cacheIds).size).toBe(2);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps Latin tokens when text mixes CJK and English without spaces", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-mixed-script-1781067948639`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "mixed.md"),
        "# Mixed Script\n\nSourceLine\u4e2d\u6587\u8bc1\u636e\u652f\u6301\u6df7\u5408\u68c0\u7d22\u3002",
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "SourceLine\u4e2d\u6587\u8bc1\u636e",
        maxResults: 2
      });

      expect(results[0]?.snippet).toContain("SourceLine\u4e2d\u6587\u8bc1\u636e\u652f\u6301\u6df7\u5408\u68c0\u7d22");
      expect(results[0]?.retrieval?.matchedTerms).toEqual(expect.arrayContaining(["sourceline", "\u4e2d\u6587", "\u8bc1\u636e"]));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("indexes readable HTML source files from a source folder", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-html-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "reference.html"),
        `<!doctype html>
        <html>
          <head>
            <title>Evidence Portal</title>
            <style>.hidden { display: none; }</style>
          </head>
          <body>
            <h1>Ignored fallback heading</h1>
            <script>window.noise = true;</script>
            <p>HTML source folders can provide citation evidence for SourceLine reports.</p>
          </body>
        </html>`,
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "HTML citation evidence SourceLine",
        maxResults: 2
      });

      expect(results[0]?.provider).toBe("local");
      expect(results[0]?.title).toContain("Evidence Portal");
      expect(results[0]?.path).toMatch(/reference\.html$/);
      expect(results[0]?.snippet).toContain("HTML source folders can provide citation evidence");
      expect(results[0]?.snippet).not.toContain("window.noise");
      expect(results[0]?.retrieval?.explanation).toContain("title boost");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps adjacent HTML list items separated in local source folders", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-html-list-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "list.html"),
        `<!doctype html>
        <html>
          <body>
            <ul><li>Alpha evidence marker<li>Beta verification marker</ul>
          </body>
        </html>`,
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "beta verification marker",
        maxResults: 1
      });

      const rawCache = await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8");
      const cache = JSON.parse(rawCache) as { entries?: Array<{ document?: { text?: string } }> };

      expect(results[0]?.snippet).toContain("Beta verification marker");
      expect(results[0]?.snippet).not.toContain("markerBeta");
      expect(results[0]?.text).toBe("Beta verification marker");
      expect(cache.entries?.[0]?.document?.text).toContain("Alpha evidence marker\n\nBeta verification marker");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("uses metadata titles from headless HTML fragments", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-html-fragment-title-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "fragment.html"),
        `<meta charset="utf-8">
        <title>Fragment Evidence Portal</title>
        <p>Headless HTML fragments can still provide local SourceLine evidence.</p>`,
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "Headless HTML fragments SourceLine evidence",
        maxResults: 1
      });

      expect(results[0]?.title).toContain("Fragment Evidence Portal");
      expect(results[0]?.snippet).toContain("Headless HTML fragments can still provide local SourceLine evidence");
      expect(results[0]?.retrieval?.explanation).toContain("title boost");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not promote body titles from headless HTML fragments", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-html-body-title-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "fragment.html"),
        `<p>Body introduction appears before the misleading title.</p>
        <title>Body Misleading Title</title>
        <h1>Visible Fragment Heading</h1>
        <p>Visible fragment evidence marker stays searchable.</p>`,
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "visible fragment evidence marker",
        maxResults: 1
      });

      expect(results[0]?.title).toContain("Visible Fragment Heading");
      expect(results[0]?.title).not.toContain("Body Misleading Title");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("ignores hidden and decorative HTML content in local source folders", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-html-template-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "template.html"),
        `<!doctype html>
        <html>
          <head>
            <!-- <title>Comment Fake Title</title> -->
            <script>const fake = "<title>Script Fake Title</title>";</script>
            <title>Head Published Title</title>
          </head>
          <body>
            <!-- <h1>Comment Hidden Title</h1><p>commentonly text should not be indexed.</p> -->
            <template><h1>Hidden Draft Title</h1><p>templatedraftonly hidden content should not be indexed.</p></template>
            <svg><title>Decorative Icon Title</title><text>svgicononly hidden label should not be indexed.</text></svg>
            <div hidden><h1>Hidden Attribute Title</h1><p>hiddenattronly text should not be indexed.</p></div>
            <section aria-hidden="true"><h1>Aria Hidden Title</h1><p>ariahiddenonly text should not be indexed.</p></section>
            <aside style="display:none"><h1>Display None Title</h1><p>displaynoneonly text should not be indexed.</p></aside>
            <div style="color:red; visibility: hidden"><h1>Visibility Hidden Title</h1><p>visibilityhiddenonly text should not be indexed.</p></div>
            <h1>Visible Published Title</h1>
            <p>Visible published evidence marker should be indexed.</p>
          </body>
        </html>`,
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const hiddenTokens = [
        "templatedraftonly",
        "svgicononly",
        "hiddenattronly",
        "ariahiddenonly",
        "displaynoneonly",
        "visibilityhiddenonly",
        "commentonly"
      ];
      const hiddenResults = await Promise.all(
        hiddenTokens.map((token, index) =>
          provider.search({
            claimId: `hidden-${index + 1}`,
            query: token,
            maxResults: 1
          })
        )
      );
      const visibleResults = await provider.search({
        claimId: "visible",
        query: "visible published evidence marker",
        maxResults: 1
      });
      const rawCache = await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8");
      const cache = JSON.parse(rawCache) as { entries?: Array<{ document?: { text?: string } }> };

      expect(hiddenResults).toEqual(hiddenTokens.map(() => []));
      expect(visibleResults[0]?.title).toContain("Head Published Title");
      expect(visibleResults[0]?.title).not.toContain("Comment Fake Title");
      expect(visibleResults[0]?.title).not.toContain("Comment Hidden Title");
      expect(visibleResults[0]?.title).not.toContain("Script Fake Title");
      expect(visibleResults[0]?.title).not.toContain("Hidden Draft Title");
      expect(visibleResults[0]?.title).not.toContain("Decorative Icon Title");
      expect(visibleResults[0]?.title).not.toContain("Hidden Attribute Title");
      expect(visibleResults[0]?.title).not.toContain("Aria Hidden Title");
      expect(visibleResults[0]?.title).not.toContain("Display None Title");
      expect(visibleResults[0]?.title).not.toContain("Visibility Hidden Title");
      expect(visibleResults[0]?.snippet).toContain("Visible published evidence marker");
      expect(cache.entries?.[0]?.document?.text).toBe(
        "Visible Published Title\n\nVisible published evidence marker should be indexed."
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("writes a reusable local index cache after searching", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-write-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, "notes.md"), "# Cache Notes\n\nReusable local evidence is indexed once.", "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      await provider.search({
        claimId: "claim-1",
        query: "reusable local evidence",
        maxResults: 1
      });

      const rawCache = await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8");
      const cache = JSON.parse(rawCache) as {
        schemaVersion?: number;
        entries?: Array<{ relativePath?: string; contentHash?: string; document?: { chunks?: unknown[] } }>;
      };

      expect(cache.schemaVersion).toBe(5);
      expect(cache.entries?.[0]?.relativePath).toBe("notes.md");
      expect(cache.entries?.[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(cache.entries?.[0]?.document?.chunks?.length).toBeGreaterThan(0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("skips oversized local source files instead of indexing or caching them", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-oversized-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, "huge.md"), `# Huge\n\nOversizedunique evidence.\n${"x".repeat(2_000_001)}`, "utf8");
      await writeFile(join(rootDir, "small.md"), "# Small\n\nSmall source marker stays searchable.", "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const oversizedResults = await provider.search({
        claimId: "claim-1",
        query: "oversizedunique evidence",
        maxResults: 5
      });
      const smallResults = await provider.search({
        claimId: "claim-1",
        query: "small source marker",
        maxResults: 5
      });
      const rawCache = await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8");
      const cache = JSON.parse(rawCache) as { entries?: Array<{ relativePath?: string }> };
      const info = await getLocalIndexCacheInfo({ rootDir });

      expect(oversizedResults).toHaveLength(0);
      expect(smallResults[0]?.path).toMatch(/small\.md$/);
      expect(cache.entries?.map((entry) => entry.relativePath)).toEqual(["small.md"]);
      expect(info.sourceFiles).toBe(2);
      expect(info.skippedSourceFiles).toBe(1);
      expect(info.skippedOversizedSourceFiles).toBe(1);
      expect(info.skippedOverBudgetSourceFiles).toBe(0);
      expect(info.uncachedSourceFiles).toBe(0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("indexes local source files up to the exact byte limit", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-byte-limit-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const prefix = "# Boundary\n\nExact limit marker stays searchable.\n";
      const filler = "x".repeat(2_000_000 - Buffer.byteLength(prefix));
      await writeFile(join(rootDir, "limit.md"), `${prefix}${filler}`, "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "exact limit marker",
        maxResults: 1
      });
      const info = await getLocalIndexCacheInfo({ rootDir });

      expect(results[0]?.snippet).toContain("Exact limit marker");
      expect(info.sourceFiles).toBe(1);
      expect(info.sourceBytes).toBe(2_000_000);
      expect(info.skippedSourceFiles).toBe(0);
      expect(info.skippedOversizedSourceFiles).toBe(0);
      expect(info.skippedOverBudgetSourceFiles).toBe(0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("skips local source files beyond the total source byte budget", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-total-budget-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      for (let index = 0; index < 11; index += 1) {
        const marker = `Budget${String(index).padStart(2, "0")} searchable evidence.\n`;
        await writeFile(join(rootDir, `note-${String(index).padStart(2, "0")}.md`), `${marker}${" ".repeat(2_000_000 - marker.length)}`, "utf8");
      }

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const includedResults = await provider.search({
        claimId: "claim-1",
        query: "budget09 evidence",
        maxResults: 1
      });
      const skippedResults = await provider.search({
        claimId: "claim-1",
        query: "budget10",
        maxResults: 1
      });
      const info = await getLocalIndexCacheInfo({ rootDir });

      expect(includedResults[0]?.path).toMatch(/note-09\.md$/);
      expect(skippedResults).toHaveLength(0);
      expect(info.sourceFiles).toBe(11);
      expect(info.skippedSourceFiles).toBe(1);
      expect(info.skippedOversizedSourceFiles).toBe(0);
      expect(info.skippedOverBudgetSourceFiles).toBe(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports self-written caches with zero-token chunks as valid", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-zero-token-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, "stopwords.md"), "the and for\n\n!!!", "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      await provider.search({
        claimId: "claim-1",
        query: "searchable evidence",
        maxResults: 1
      });

      const info = await getLocalIndexCacheInfo({ rootDir });
      const rawCache = await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8");
      const cache = JSON.parse(rawCache) as { entries?: Array<{ document?: { chunks?: Array<{ tokenCount?: number; tokens?: string[] }> } }> };
      const chunks = cache.entries?.[0]?.document?.chunks ?? [];

      expect(info.valid).toBe(true);
      expect(info.chunks).toBe(2);
      expect(chunks.map((chunk) => chunk.tokenCount)).toEqual([0, 0]);
      expect(chunks.map((chunk) => chunk.tokens)).toEqual([[], []]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });


  it("writes local index caches without leaving temporary files", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-atomic-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, "notes.md"), "Atomic cache writes keep local retrieval reusable.", "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      await provider.search({
        claimId: "claim-1",
        query: "atomic cache retrieval",
        maxResults: 1
      });

      const cacheDir = join(rootDir, ".sourceline", "cache");
      const cacheFiles = await readdir(cacheDir);
      const rawCache = await readFile(join(cacheDir, "local-index.json"), "utf8");

      expect(JSON.parse(rawCache).schemaVersion).toBe(5);
      expect(cacheFiles).toContain("local-index.json");
      expect(cacheFiles.filter((file) => file.startsWith("local-index.json.") && file.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent local index cache writes without leaving temporary files", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-concurrent-${Date.now()}`);
    const originalDateNow = Date.now;
    await mkdir(rootDir, { recursive: true });

    try {
      Date.now = () => 1_781_454_698_000;
      await writeFile(join(rootDir, "notes.md"), "Concurrent cache writes keep local retrieval reusable.", "utf8");

      const firstProvider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const secondProvider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const [firstResults, secondResults] = await Promise.all([
        firstProvider.search({
          claimId: "claim-1",
          query: "concurrent cache writes",
          maxResults: 1
        }),
        secondProvider.search({
          claimId: "claim-2",
          query: "local retrieval reusable",
          maxResults: 1
        })
      ]);

      const cacheDir = join(rootDir, ".sourceline", "cache");
      const cacheFiles = await readdir(cacheDir);
      const rawCache = await readFile(join(cacheDir, "local-index.json"), "utf8");

      expect(firstResults[0]?.snippet).toContain("Concurrent cache writes");
      expect(secondResults[0]?.snippet).toContain("local retrieval reusable");
      expect(JSON.parse(rawCache).schemaVersion).toBe(5);
      expect(cacheFiles).toEqual(["local-index.json"]);
    } finally {
      Date.now = originalDateNow;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports and clears local index cache state", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-info-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, "notes.md"), "Local cache status evidence is visible.", "utf8");

      const missingInfo = await getLocalIndexCacheInfo({ rootDir });
      expect(missingInfo.exists).toBe(false);
      expect(missingInfo.currentSchemaVersion).toBe(5);
      expect(missingInfo.cacheSchemaVersion).toBeUndefined();
      expect(missingInfo.sourceFiles).toBe(1);
      expect(missingInfo.uncachedSourceFiles).toBe(1);

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      await provider.search({
        claimId: "claim-1",
        query: "cache status evidence",
        maxResults: 1
      });

      const readyInfo = await getLocalIndexCacheInfo({ rootDir });
      expect(readyInfo.exists).toBe(true);
      expect(readyInfo.valid).toBe(true);
      expect(readyInfo.currentSchemaVersion).toBe(5);
      expect(readyInfo.cacheSchemaVersion).toBe(5);
      expect(readyInfo.entries).toBe(1);
      expect(readyInfo.currentEntries).toBe(1);
      expect(readyInfo.chunks).toBe(1);

      const clearResult = await clearLocalIndexCache({ rootDir });
      expect(clearResult.removed).toBe(true);
      expect((await getLocalIndexCacheInfo({ rootDir })).exists).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports and preserves non-file local index cache artifacts", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-non-file-${Date.now()}`);
    const cachePath = join(rootDir, ".sourceline", "cache", "local-index.json");
    await mkdir(cachePath, { recursive: true });

    try {
      const info = await getLocalIndexCacheInfo({ rootDir });

      expect(info.exists).toBe(true);
      expect(info.valid).toBe(false);
      expect(info.invalidReason).toContain("Local index cache must be a file:");
      await expect(clearLocalIndexCache({ rootDir })).rejects.toThrow("Local index cache must be a file:");
      expect((await stat(cachePath)).isDirectory()).toBe(true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reuses cached chunks when source metadata is unchanged", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-hit-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      const sourcePath = join(rootDir, "notes.md");
      const sourceText = "Cached proof evidence lives here.";
      await writeFile(sourcePath, sourceText, "utf8");
      const sourceStat = await stat(sourcePath);
      await writeFile(
        join(rootDir, ".sourceline", "cache", "local-index.json"),
        JSON.stringify(
          {
            schemaVersion: 5,
            entries: [
              {
                relativePath: "notes.md",
                mtimeMs: sourceStat.mtimeMs,
                size: sourceStat.size,
                contentHash: contentHash(sourceText),
                documentHash: documentHash("notes.md", sourceText),
                document: {
                  id: "notes-md",
                  title: "notes.md",
                  text: sourceText,
                  chunks: [
                    {
                      id: "chunk-1",
                      text: "Cached proof evidence lives here.",
                      startLine: 1,
                      endLine: 1,
                      tokens: ["cached", "proof", "evidence", "lives", "here"],
                      termFrequencies: [
                        ["cached", 1],
                        ["proof", 1],
                        ["evidence", 1],
                        ["lives", 1],
                        ["here", 1]
                      ],
                      tokenCount: 5,
                      normalizedText: "cached proof evidence lives here"
                    }
                  ]
                }
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "cached proof",
        maxResults: 1
      });

      expect(results[0]?.snippet).toContain("Cached proof evidence");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("repairs empty document ids when reusing old local index caches", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-empty-id-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      const sourcePath = join(rootDir, "\u8bc1\u636e.md");
      const sourceText = "Cached multilingual evidence marker.";
      await writeFile(sourcePath, sourceText, "utf8");
      const sourceStat = await stat(sourcePath);
      await writeFile(
        join(rootDir, ".sourceline", "cache", "local-index.json"),
        JSON.stringify(
          {
            schemaVersion: 5,
            entries: [
              {
                relativePath: "\u8bc1\u636e.md",
                mtimeMs: sourceStat.mtimeMs,
                size: sourceStat.size,
                contentHash: contentHash(sourceText),
                documentHash: documentHash("\u8bc1\u636e.md", sourceText),
                document: {
                  id: "",
                  title: "\u8bc1\u636e.md",
                  text: sourceText,
                  chunks: [
                    {
                      id: "chunk-1",
                      text: "Cached multilingual evidence marker.",
                      startLine: 1,
                      endLine: 1,
                      tokens: ["cached", "multilingual", "evidence", "marker"],
                      termFrequencies: [
                        ["cached", 1],
                        ["multilingual", 1],
                        ["evidence", 1],
                        ["marker", 1]
                      ],
                      tokenCount: 4,
                      normalizedText: "cached multilingual evidence marker"
                    }
                  ]
                }
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const results = await provider.search({
        claimId: "claim-1",
        query: "cached multilingual evidence",
        maxResults: 1
      });
      const rawCache = await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8");
      const cache = JSON.parse(rawCache) as { entries?: Array<{ document?: { id?: string } }> };

      expect(results[0]?.id).toMatch(/^md-[a-z0-9]+#chunk-1$/);
      expect(cache.entries?.[0]?.document?.id).toMatch(/^md-[a-z0-9]+$/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rebuilds unsupported local index cache schema versions", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-schema-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      const sourcePath = join(rootDir, "notes.md");
      await writeFile(sourcePath, "Fresh cache schema evidence should be rebuilt.", "utf8");
      const sourceStat = await stat(sourcePath);
      await writeFile(
        join(rootDir, ".sourceline", "cache", "local-index.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            entries: [
              {
                relativePath: "notes.md",
                mtimeMs: sourceStat.mtimeMs,
                size: sourceStat.size,
                document: {
                  id: "notes-md",
                  title: "Old Cached Source",
                  text: "Obsolete cached proof should not survive.",
                  chunks: [
                    {
                      id: "chunk-1",
                      text: "Obsolete cached proof should not survive.",
                      startLine: 1,
                      endLine: 1,
                      tokens: ["obsolete", "cached", "proof", "should", "not", "survive"],
                      termFrequencies: [
                        ["obsolete", 1],
                        ["cached", 1],
                        ["proof", 1],
                        ["should", 1],
                        ["not", 1],
                        ["survive", 1]
                      ],
                      tokenCount: 6,
                      normalizedText: "obsolete cached proof should not survive"
                    }
                  ]
                }
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const oldInfo = await getLocalIndexCacheInfo({ rootDir });
      expect(oldInfo.valid).toBe(false);
      expect(oldInfo.currentSchemaVersion).toBe(5);
      expect(oldInfo.cacheSchemaVersion).toBe(1);
      expect(oldInfo.invalidReason).toContain("Expected version 5");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const results = await provider.search({
        claimId: "claim-1",
        query: "fresh schema evidence",
        maxResults: 1
      });
      const rawCache = await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8");

      expect(results[0]?.snippet).toContain("Fresh cache schema evidence");
      expect(JSON.parse(rawCache).schemaVersion).toBe(5);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rebuilds v2 caches so mixed-script tokenization can take effect", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-v2-tokenizer-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      const sourcePath = join(rootDir, "mixed.md");
      await writeFile(
        sourcePath,
        "# Mixed Script\n\nSourceLine\u4e2d\u6587\u8bc1\u636e\u652f\u6301\u6df7\u5408\u68c0\u7d22\u3002",
        "utf8"
      );
      const sourceStat = await stat(sourcePath);
      await writeFile(
        join(rootDir, ".sourceline", "cache", "local-index.json"),
        JSON.stringify(
          {
            schemaVersion: 2,
            entries: [
              {
                relativePath: "mixed.md",
                mtimeMs: sourceStat.mtimeMs,
                size: sourceStat.size,
                document: {
                  id: "mixed-md",
                  title: "Old Mixed Script Cache",
                  text: "SourceLine\u4e2d\u6587\u8bc1\u636e\u652f\u6301\u6df7\u5408\u68c0\u7d22\u3002",
                  chunks: [
                    {
                      id: "chunk-1",
                      text: "Old v2 cache lacks mixed script tokens.",
                      startLine: 1,
                      endLine: 1,
                      tokens: ["old", "cache"],
                      termFrequencies: [
                        ["old", 1],
                        ["cache", 1]
                      ],
                      tokenCount: 2,
                      normalizedText: "old v2 cache lacks mixed script tokens"
                    }
                  ]
                }
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const oldInfo = await getLocalIndexCacheInfo({ rootDir });
      expect(oldInfo.valid).toBe(false);
      expect(oldInfo.currentSchemaVersion).toBe(5);
      expect(oldInfo.cacheSchemaVersion).toBe(2);
      expect(oldInfo.invalidReason).toContain("Expected version 5");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const results = await provider.search({
        claimId: "claim-1",
        query: "SourceLine\u4e2d\u6587\u8bc1\u636e",
        maxResults: 1
      });
      const rawCache = await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8");

      expect(results[0]?.snippet).toContain("SourceLine\u4e2d\u6587\u8bc1\u636e\u652f\u6301\u6df7\u5408\u68c0\u7d22");
      expect(results[0]?.retrieval?.matchedTerms).toEqual(expect.arrayContaining(["sourceline", "\u4e2d\u6587", "\u8bc1\u636e"]));
      expect(JSON.parse(rawCache).schemaVersion).toBe(5);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("repairs stale non-ASCII document ids when reusing old local index caches", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-stale-id-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      const firstPath = join(rootDir, "\u8bc1\u636e.md");
      const secondPath = join(rootDir, "\u4e8b\u5b9e.md");
      const firstText = "Cached multilingual evidence marker one.";
      const secondText = "Cached multilingual evidence marker two.";
      await writeFile(firstPath, firstText, "utf8");
      await writeFile(secondPath, secondText, "utf8");
      const firstStat = await stat(firstPath);
      const secondStat = await stat(secondPath);
      await writeFile(
        join(rootDir, ".sourceline", "cache", "local-index.json"),
        JSON.stringify(
          {
            schemaVersion: 5,
            entries: [
              {
                relativePath: "\u8bc1\u636e.md",
                mtimeMs: firstStat.mtimeMs,
                size: firstStat.size,
                contentHash: contentHash(firstText),
                documentHash: documentHash("\u8bc1\u636e.md", firstText),
                document: {
                  id: "md",
                  title: "\u8bc1\u636e.md",
                  text: firstText,
                  chunks: [
                    {
                      id: "chunk-1",
                      text: "Cached multilingual evidence marker one.",
                      startLine: 1,
                      endLine: 1,
                      tokens: ["cached", "multilingual", "evidence", "marker", "one"],
                      termFrequencies: [
                        ["cached", 1],
                        ["multilingual", 1],
                        ["evidence", 1],
                        ["marker", 1],
                        ["one", 1]
                      ],
                      tokenCount: 5,
                      normalizedText: "cached multilingual evidence marker one"
                    }
                  ]
                }
              },
              {
                relativePath: "\u4e8b\u5b9e.md",
                mtimeMs: secondStat.mtimeMs,
                size: secondStat.size,
                contentHash: contentHash(secondText),
                documentHash: documentHash("\u4e8b\u5b9e.md", secondText),
                document: {
                  id: "md",
                  title: "\u4e8b\u5b9e.md",
                  text: secondText,
                  chunks: [
                    {
                      id: "chunk-1",
                      text: "Cached multilingual evidence marker two.",
                      startLine: 1,
                      endLine: 1,
                      tokens: ["cached", "multilingual", "evidence", "marker", "two"],
                      termFrequencies: [
                        ["cached", 1],
                        ["multilingual", 1],
                        ["evidence", 1],
                        ["marker", 1],
                        ["two", 1]
                      ],
                      tokenCount: 5,
                      normalizedText: "cached multilingual evidence marker two"
                    }
                  ]
                }
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const results = await provider.search({
        claimId: "claim-1",
        query: "cached multilingual evidence marker",
        maxResults: 2
      });
      const rawCache = await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8");
      const cache = JSON.parse(rawCache) as { entries?: Array<{ document?: { id?: string } }> };
      const resultIds = results.map((result) => result.id);
      const cacheIds = cache.entries?.map((entry) => entry.document?.id) ?? [];

      expect(resultIds.every((id) => /^md-[a-z0-9]+#chunk-1$/.test(id))).toBe(true);
      expect(new Set(resultIds).size).toBe(2);
      expect(cacheIds.every((id) => typeof id === "string" && /^md-[a-z0-9]+$/.test(id))).toBe(true);
      expect(new Set(cacheIds).size).toBe(2);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
  it("invalidates stale cache entries when a source file changes", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-invalidates-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const sourcePath = join(rootDir, "notes.md");
      await writeFile(sourcePath, "Blue cobalt marker should be replaced.", "utf8");

      const firstProvider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      expect(
        await firstProvider.search({
          claimId: "claim-1",
          query: "blue cobalt",
          maxResults: 1
        })
      ).toHaveLength(1);

      await writeFile(sourcePath, "Crimson evidence has replaced the old cached content with a longer marker.", "utf8");

      const secondProvider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const freshResults = await secondProvider.search({
        claimId: "claim-1",
        query: "crimson evidence longer",
        maxResults: 1
      });
      const staleResults = await secondProvider.search({
        claimId: "claim-1",
        query: "blue cobalt",
        maxResults: 1
      });

      expect(freshResults[0]?.snippet).toContain("Crimson evidence");
      expect(staleResults).toHaveLength(0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("invalidates cache entries when content changes despite matching size and mtime metadata", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-hash-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const sourcePath = join(rootDir, "notes.md");
      const firstText = "Blue cobalt marker stays here.";
      const secondText = "Ruby violet marker stays here.";
      await writeFile(sourcePath, firstText, "utf8");

      const firstProvider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      expect(
        await firstProvider.search({
          claimId: "claim-1",
          query: "blue cobalt",
          maxResults: 1
        })
      ).toHaveLength(1);

      await writeFile(sourcePath, secondText, "utf8");
      const sourceStat = await stat(sourcePath);
      const cachePath = join(rootDir, ".sourceline", "cache", "local-index.json");
      const cache = JSON.parse(await readFile(cachePath, "utf8")) as {
        entries?: Array<{ mtimeMs?: number; size?: number; contentHash?: string }>;
      };
      const entry = cache.entries?.[0];
      if (!entry) {
        throw new Error("Expected local cache entry.");
      }
      entry.mtimeMs = sourceStat.mtimeMs;
      entry.size = sourceStat.size;
      await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");

      const secondProvider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const freshResults = await secondProvider.search({
        claimId: "claim-1",
        query: "ruby violet",
        maxResults: 1
      });
      const staleResults = await secondProvider.search({
        claimId: "claim-1",
        query: "blue cobalt",
        maxResults: 1
      });
      const repairedCache = JSON.parse(await readFile(cachePath, "utf8")) as { entries?: Array<{ contentHash?: string }> };

      expect(firstText).toHaveLength(secondText.length);
      expect(entry.contentHash).toBe(contentHash(firstText));
      expect(freshResults[0]?.snippet).toContain("Ruby violet");
      expect(staleResults).toHaveLength(0);
      expect(repairedCache.entries?.[0]?.contentHash).toBe(contentHash(secondText));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects cache entries whose cached document does not match the current source document", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-document-hash-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      const sourcePath = join(rootDir, "notes.md");
      const sourceText = "Fresh source evidence should be indexed.";
      const cachedText = "Poisoned cached payload should not be used.";
      await writeFile(sourcePath, sourceText, "utf8");
      const sourceStat = await stat(sourcePath);
      await writeFile(
        join(rootDir, ".sourceline", "cache", "local-index.json"),
        JSON.stringify(
          {
            schemaVersion: 5,
            entries: [
              {
                relativePath: "notes.md",
                mtimeMs: sourceStat.mtimeMs,
                size: sourceStat.size,
                contentHash: contentHash(sourceText),
                documentHash: documentHash("notes.md", cachedText),
                document: {
                  id: "notes-md",
                  title: "notes.md",
                  text: cachedText,
                  chunks: [
                    {
                      id: "chunk-1",
                      text: cachedText,
                      startLine: 1,
                      endLine: 1,
                      tokens: ["poisoned", "cached", "payload", "not", "used"],
                      termFrequencies: [
                        ["poisoned", 1],
                        ["cached", 1],
                        ["payload", 1],
                        ["not", 1],
                        ["used", 1]
                      ],
                      tokenCount: 5,
                      normalizedText: "poisoned cached payload should not be used"
                    }
                  ]
                }
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const info = await getLocalIndexCacheInfo({ rootDir });
      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const freshResults = await provider.search({
        claimId: "claim-1",
        query: "fresh source evidence",
        maxResults: 1
      });
      const poisonedResults = await provider.search({
        claimId: "claim-1",
        query: "poisoned cached",
        maxResults: 1
      });
      const rawCache = await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8");
      const rebuilt = JSON.parse(rawCache) as { entries?: Array<{ documentHash?: string }> };

      expect(info.valid).toBe(true);
      expect(info.staleEntries).toBe(1);
      expect(freshResults[0]?.snippet).toContain("Fresh source evidence");
      expect(poisonedResults).toHaveLength(0);
      expect(rebuilt.entries?.[0]?.documentHash).toBe(documentHash("notes.md", sourceText));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects cache entries whose metadata hashes match but cached document payload differs", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-document-payload-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      const sourcePath = join(rootDir, "notes.md");
      const sourceText = "Fresh source payload evidence should be indexed.";
      const cachedText = "Poisoned cached payload should not be used.";
      await writeFile(sourcePath, sourceText, "utf8");
      const sourceStat = await stat(sourcePath);
      await writeFile(
        join(rootDir, ".sourceline", "cache", "local-index.json"),
        JSON.stringify(
          {
            schemaVersion: 5,
            entries: [
              {
                relativePath: "notes.md",
                mtimeMs: sourceStat.mtimeMs,
                size: sourceStat.size,
                contentHash: contentHash(sourceText),
                documentHash: documentHash("notes.md", sourceText),
                document: {
                  id: "notes-md",
                  title: "Poisoned Cache Title",
                  text: cachedText,
                  chunks: [
                    {
                      id: "chunk-1",
                      text: cachedText,
                      startLine: 1,
                      endLine: 1,
                      tokens: ["poisoned", "cached", "payload", "not", "used"],
                      termFrequencies: [
                        ["poisoned", 1],
                        ["cached", 1],
                        ["payload", 1],
                        ["not", 1],
                        ["used", 1]
                      ],
                      tokenCount: 5,
                      normalizedText: "poisoned cached payload should not be used"
                    }
                  ]
                }
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const info = await getLocalIndexCacheInfo({ rootDir });
      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const freshResults = await provider.search({
        claimId: "claim-1",
        query: "fresh source payload evidence",
        maxResults: 1
      });
      const poisonedResults = await provider.search({
        claimId: "claim-1",
        query: "poisoned cached",
        maxResults: 1
      });
      const rebuilt = JSON.parse(await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8")) as {
        entries?: Array<{ document?: { text?: string; title?: string }; documentHash?: string }>;
      };

      expect(info.valid).toBe(true);
      expect(info.staleEntries).toBe(1);
      expect(freshResults[0]?.snippet).toContain("Fresh source payload evidence");
      expect(poisonedResults).toHaveLength(0);
      expect(rebuilt.entries?.[0]?.document?.title).toBe("notes.md");
      expect(rebuilt.entries?.[0]?.document?.text).toBe(sourceText);
      expect(rebuilt.entries?.[0]?.documentHash).toBe(documentHash("notes.md", sourceText));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects cache entries whose cached chunks do not match their cached document text", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-chunk-consistency-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      const sourcePath = join(rootDir, "notes.md");
      const sourceText = "Fresh chunk consistency evidence should be indexed.";
      await writeFile(sourcePath, sourceText, "utf8");
      const sourceStat = await stat(sourcePath);
      await writeFile(
        join(rootDir, ".sourceline", "cache", "local-index.json"),
        JSON.stringify(
          {
            schemaVersion: 5,
            entries: [
              {
                relativePath: "notes.md",
                mtimeMs: sourceStat.mtimeMs,
                size: sourceStat.size,
                contentHash: contentHash(sourceText),
                documentHash: documentHash("notes.md", sourceText),
                document: {
                  id: "notes-md",
                  title: "notes.md",
                  text: sourceText,
                  chunks: [
                    {
                      id: "chunk-1",
                      text: "Poisoned payload text should not be used.",
                      startLine: 1,
                      endLine: 1,
                      tokens: ["poisoned", "payload", "text", "not", "used"],
                      termFrequencies: [
                        ["poisoned", 1],
                        ["payload", 1],
                        ["text", 1],
                        ["not", 1],
                        ["used", 1]
                      ],
                      tokenCount: 5,
                      normalizedText: "poisoned payload text should not be used"
                    }
                  ]
                }
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const invalidInfo = await getLocalIndexCacheInfo({ rootDir });
      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const freshResults = await provider.search({
        claimId: "claim-1",
        query: "fresh chunk consistency evidence",
        maxResults: 1
      });
      const poisonedResults = await provider.search({
        claimId: "claim-1",
        query: "poisoned payload text",
        maxResults: 1
      });

      expect(invalidInfo.valid).toBe(false);
      expect(invalidInfo.cacheSchemaVersion).toBe(5);
      expect(invalidInfo.invalidReason).toContain("Invalid local index cache structure");
      expect(freshResults[0]?.snippet).toContain("Fresh chunk consistency evidence");
      expect(poisonedResults).toHaveLength(0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("ignores corrupt local index caches", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-corrupt-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      await writeFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "{not-json", "utf8");
      await writeFile(join(rootDir, "notes.md"), "Recoverable evidence should still be indexed.", "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "recoverable evidence",
        maxResults: 1
      });
      const rawCache = await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8");

      expect(results[0]?.snippet).toContain("Recoverable evidence");
      expect(JSON.parse(rawCache).schemaVersion).toBe(5);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("treats oversized local index caches as invalid and rebuilds from sources", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-oversized-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      const cachePath = join(rootDir, ".sourceline", "cache", "local-index.json");
      await writeFile(cachePath, "{}", "utf8");
      await truncate(cachePath, 50_000_001);
      await writeFile(join(rootDir, "notes.md"), "Fresh oversized-cache recovery evidence should be indexed.", "utf8");

      const invalidInfo = await getLocalIndexCacheInfo({ rootDir });
      expect(invalidInfo.exists).toBe(true);
      expect(invalidInfo.valid).toBe(false);
      expect(invalidInfo.cacheBytes).toBe(50_000_001);
      expect(invalidInfo.invalidReason).toContain("larger than 50000000 bytes");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const results = await provider.search({
        claimId: "claim-1",
        query: "oversized cache recovery evidence",
        maxResults: 1
      });
      const rawCache = await readFile(cachePath, "utf8");

      expect(results[0]?.snippet).toContain("Fresh oversized-cache recovery evidence");
      expect(JSON.parse(rawCache).schemaVersion).toBe(5);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe relative paths in local index caches", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-unsafe-path-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      const sourceText = "Fresh safe cache evidence should be indexed.";
      await writeFile(join(rootDir, "notes.md"), sourceText, "utf8");
      await writeFile(
        join(rootDir, ".sourceline", "cache", "local-index.json"),
        JSON.stringify(
          {
            schemaVersion: 5,
            entries: [
              {
                relativePath: "../outside.md",
                mtimeMs: 1,
                size: 1,
                contentHash: contentHash(sourceText),
                documentHash: documentHash("Unsafe Cached Source", "Poisoned outside cache evidence should not be used."),
                document: {
                  id: "outside-md",
                  title: "Unsafe Cached Source",
                  text: "Poisoned outside cache evidence should not be used.",
                  chunks: [
                    {
                      id: "chunk-1",
                      text: "Poisoned outside cache evidence should not be used.",
                      startLine: 1,
                      endLine: 1,
                      tokens: ["poisoned", "outside", "cache", "evidence"],
                      termFrequencies: [
                        ["phantom", 1],
                        ["outside", 1],
                        ["cache", 1],
                        ["evidence", 1]
                      ],
                      tokenCount: 4,
                      normalizedText: "poisoned outside cache evidence"
                    }
                  ]
                }
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const invalidInfo = await getLocalIndexCacheInfo({ rootDir });
      expect(invalidInfo.valid).toBe(false);
      expect(invalidInfo.cacheSchemaVersion).toBe(5);
      expect(invalidInfo.invalidReason).toContain("Invalid local index cache structure");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const freshResults = await provider.search({
        claimId: "claim-1",
        query: "fresh safe cache evidence",
        maxResults: 1
      });
      const unsafeResults = await provider.search({
        claimId: "claim-1",
        query: "poisoned outside",
        maxResults: 1
      });
      const rawCache = await readFile(join(rootDir, ".sourceline", "cache", "local-index.json"), "utf8");

      expect(freshResults[0]?.snippet).toContain("Fresh safe cache evidence");
      expect(unsafeResults).toHaveLength(0);
      expect(JSON.parse(rawCache).entries?.[0]?.relativePath).toBe("notes.md");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
  it("rejects invalid chunk metadata in local index caches", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-bad-chunk-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      const sourceText = "Fresh chunk metadata evidence should be indexed.";
      await writeFile(join(rootDir, "notes.md"), sourceText, "utf8");
      await writeFile(
        join(rootDir, ".sourceline", "cache", "local-index.json"),
        JSON.stringify(
          {
            schemaVersion: 5,
            entries: [
              {
                relativePath: "notes.md",
                mtimeMs: 1,
                size: 1,
                contentHash: contentHash(sourceText),
                documentHash: documentHash("Bad Chunk Cache", "Phantom toxword marker should not be used."),
                document: {
                  id: "notes-md",
                  title: "Bad Chunk Cache",
                  text: "Phantom toxword marker should not be used.",
                  chunks: [
                    {
                      id: "chunk-1",
                      text: "Phantom toxword marker should not be used.",
                      startLine: 4,
                      endLine: 2,
                      tokens: ["phantom", "toxword", "marker"],
                      termFrequencies: [
                        ["phantom", 1],
                        ["toxword", 1],
                        ["marker", 1]
                      ],
                      tokenCount: 3,
                      normalizedText: "phantom toxword marker"
                    }
                  ]
                }
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const invalidInfo = await getLocalIndexCacheInfo({ rootDir });
      expect(invalidInfo.valid).toBe(false);
      expect(invalidInfo.cacheSchemaVersion).toBe(5);
      expect(invalidInfo.invalidReason).toContain("Invalid local index cache structure");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const freshResults = await provider.search({
        claimId: "claim-1",
        query: "fresh chunk metadata evidence",
        maxResults: 1
      });
      const poisonedResults = await provider.search({
        claimId: "claim-1",
        query: "phantom toxword marker",
        maxResults: 1
      });

      expect(freshResults[0]?.snippet).toContain("Fresh chunk metadata evidence");
      expect(poisonedResults).toHaveLength(0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe chunk ids in local index caches", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-unsafe-chunk-id-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      const sourcePath = join(rootDir, "notes.md");
      const sourceText = "Fresh safe cache evidence should be indexed.";
      await writeFile(sourcePath, sourceText, "utf8");
      const sourceStat = await stat(sourcePath);
      await writeFile(
        join(rootDir, ".sourceline", "cache", "local-index.json"),
        JSON.stringify(
          {
            schemaVersion: 5,
            entries: [
              {
                relativePath: "notes.md",
                mtimeMs: sourceStat.mtimeMs,
                size: sourceStat.size,
                contentHash: contentHash(sourceText),
                documentHash: documentHash("Unsafe Chunk Id Cache", "Poisoned chunk marker should not be used."),
                document: {
                  id: "notes-md",
                  title: "Unsafe Chunk Id Cache",
                  text: "Poisoned chunk marker should not be used.",
                  chunks: [
                    {
                      id: "chunk-1\npoison",
                      text: "Poisoned chunk marker should not be used.",
                      startLine: 1,
                      endLine: 1,
                      tokens: ["poisoned", "chunk", "marker"],
                      termFrequencies: [
                        ["poisoned", 1],
                        ["chunk", 1],
                        ["marker", 1]
                      ],
                      tokenCount: 3,
                      normalizedText: "poisoned chunk marker"
                    }
                  ]
                }
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const invalidInfo = await getLocalIndexCacheInfo({ rootDir });
      expect(invalidInfo.valid).toBe(false);
      expect(invalidInfo.cacheSchemaVersion).toBe(5);
      expect(invalidInfo.invalidReason).toContain("Invalid local index cache structure");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });
      const freshResults = await provider.search({
        claimId: "claim-1",
        query: "fresh safe cache evidence",
        maxResults: 1
      });
      const poisonedResults = await provider.search({
        claimId: "claim-1",
        query: "poisoned marker",
        maxResults: 1
      });

      expect(freshResults[0]?.id).toMatch(/#chunk-1$/);
      expect(freshResults[0]?.snippet).toContain("Fresh safe cache evidence");
      expect(poisonedResults).toHaveLength(0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not index SourceLine cache contents as source evidence", async () => {
    const rootDir = join(tmpdir(), `sourceline-cache-skip-${Date.now()}`);
    await mkdir(join(rootDir, ".sourceline", "cache"), { recursive: true });

    try {
      await writeFile(join(rootDir, "public.md"), "Public evidence mentions SourceLine reports.", "utf8");
      await writeFile(join(rootDir, ".sourceline", "cache", "leak.md"), "Secret cache marker should not appear.", "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const cacheResults = await provider.search({
        claimId: "claim-1",
        query: "secret cache marker",
        maxResults: 5
      });
      const publicResults = await provider.search({
        claimId: "claim-1",
        query: "public evidence SourceLine",
        maxResults: 5
      });

      expect(cacheResults).toHaveLength(0);
      expect(publicResults[0]?.path).toMatch(/public\.md$/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("builds a compact snippet around matched terms", async () => {
    const rootDir = join(tmpdir(), `sourceline-snippet-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const longPrefix = Array.from({ length: 80 }, (_, index) => `prefix${index}`).join(" ");
      const longSuffix = Array.from({ length: 80 }, (_, index) => `suffix${index}`).join(" ");
      await writeFile(join(rootDir, "long.md"), `${longPrefix} SourceLine retrieval explains matched evidence ${longSuffix}`, "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "retrieval matched evidence",
        maxResults: 1
      });

      expect(results[0]?.snippet?.length).toBeLessThan(380);
      expect(results[0]?.snippet).toContain("retrieval explains matched evidence");
      expect(results[0]?.snippet?.startsWith("...")).toBe(true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("boosts chunks from documents with matching titles", async () => {
    const rootDir = join(tmpdir(), `sourceline-title-boost-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, "privacy.md"), "# Privacy Confirmation\n\nThe workflow includes confirmation.", "utf8");
      await writeFile(join(rootDir, "generic.md"), "# Generic Notes\n\nThe workflow includes confirmation.", "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "privacy confirmation",
        maxResults: 2
      });

      expect(results[0]?.path).toMatch(/privacy\.md$/);
      expect(results[0]?.retrieval?.matchedTerms).toEqual(expect.arrayContaining(["privacy", "confirmation"]));
      expect(results[0]?.retrieval?.explanation).toContain("title boost");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("orders equally scored local results deterministically", async () => {
    const rootDir = join(tmpdir(), `sourceline-stable-order-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, "zeta.md"), "# Same Score\n\nSourceLine stable evidence marker.", "utf8");
      await writeFile(join(rootDir, "alpha.md"), "# Same Score\n\nSourceLine stable evidence marker.", "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "SourceLine stable evidence marker",
        maxResults: 2
      });

      expect(results.map((result) => result.path.replace(/\\/g, "/"))).toEqual([
        expect.stringMatching(/alpha\.md$/),
        expect.stringMatching(/zeta\.md$/)
      ]);
      expect(results[0]?.retrieval?.score).toBe(results[1]?.retrieval?.score);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("normalizes and caps direct local search query text", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-query-cap-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, "long.md"), `${"x".repeat(500)} local query cap evidence.`, "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: ` \u001b[31m${"x".repeat(700)}\u001b[0m `,
        maxResults: 1
      });

      expect(results[0]?.query).toBe("x".repeat(500));
      expect(results[0]?.path).toMatch(/long\.md$/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("returns no local results for invalid direct search requests", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-invalid-request-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, "notes.md"), "Local evidence should only be searched for valid requests.", "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      await expect(
        provider.search({
          claimId: "claim-1",
          query: "local evidence",
          maxResults: 0
        })
      ).resolves.toEqual([]);
      await expect(
        provider.search({
          claimId: "claim-1",
          query: "local evidence",
          maxResults: 1.5
        })
      ).resolves.toEqual([]);
      await expect(
        provider.search({
          claimId: "claim-1",
          query: " \u001b[31m \u001b[0m ",
          maxResults: 1
        })
      ).resolves.toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("caps direct local search result counts", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-result-count-cap-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await Promise.all(
        Array.from({ length: 25 }, (_, index) =>
          writeFile(join(rootDir, `note-${String(index).padStart(2, "0")}.md`), "Shared local result cap evidence.", "utf8")
        )
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "shared local result cap evidence",
        maxResults: 25
      });

      expect(results).toHaveLength(20);
      expect(results.every((result) => result.rank >= 1 && result.rank <= 20)).toBe(true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("normalizes and caps direct local result text fields", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-output-cap-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(
        join(rootDir, "long.md"),
        `# \u001b[31m${"Long Local Title ".repeat(180)}\u001b[0m\n\nmarker ${"x".repeat(30_000)}`,
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "marker",
        maxResults: 1
      });

      expect(results[0]?.title).toHaveLength(2_000);
      expect(results[0]?.title).toMatch(/\.\.\. \[truncated\]$/);
      expect(results[0]?.title).not.toContain("\u001b");
      expect(results[0]?.path?.length).toBeLessThanOrEqual(2_000);
      expect(results[0]?.snippet?.length).toBeLessThanOrEqual(2_000);
      expect(results[0]?.text).toHaveLength(20_000);
      expect(results[0]?.text).toMatch(/\.\.\. \[truncated\]$/);
      expect(results[0]?.retrieval?.explanation?.length).toBeLessThanOrEqual(4_000);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("caps direct local retrieval matched terms", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-matched-terms-cap-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const terms = Array.from({ length: 60 }, (_, index) => `term${String(index).padStart(3, "0")}`);
      await writeFile(join(rootDir, "terms.md"), terms.join(" "), "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: terms.join(" "),
        maxResults: 1
      });

      expect(results[0]?.retrieval?.matchedTerms).toHaveLength(50);
      expect(results[0]?.retrieval?.matchedTerms?.[0]).toBe("term000");
      expect(results[0]?.retrieval?.matchedTerms).toContain("term049");
      expect(results[0]?.retrieval?.matchedTerms).not.toContain("term050");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("boosts exact query phrases over scattered terms", async () => {
    const rootDir = join(tmpdir(), `sourceline-phrase-boost-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, "exact.md"), "# Exact\n\nLocal retrieval scoring explains why evidence was selected.", "utf8");
      await writeFile(
        join(rootDir, "scattered.md"),
        "# Scattered\n\nLocal source folders use retrieval. The report shows scoring for selected evidence.",
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "local retrieval scoring",
        maxResults: 2
      });

      expect(results[0]?.path).toMatch(/exact\.md$/);
      expect(results[0]?.retrieval?.explanation).toContain("phrase boost");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps result quality when many unrelated chunks are indexed", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-index-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const unrelatedChunks = Array.from(
        { length: 120 },
        (_, index) => `General archive entry ${index} discusses cooking, travel, music, and planning notes.`
      ).join("\n\n");
      await writeFile(join(rootDir, "archive.md"), unrelatedChunks, "utf8");
      await writeFile(
        join(rootDir, "target.md"),
        "# Evidence Ranking\n\nSourceLine local retrieval uses BM25 scoring to rank evidence chunks.",
        "utf8"
      );

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "SourceLine BM25 scoring local",
        maxResults: 3
      });

      expect(results[0]?.path).toMatch(/target\.md$/);
      expect(results[0]?.retrieval?.matchedTerms).toEqual(expect.arrayContaining(["sourceline", "bm25", "scoring", "local"]));
      expect(results.map((result) => result.path).some((path) => /archive\.md$/.test(path))).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects excessively deep local source directories", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-depth-${Date.now()}`);
    let deepDir = rootDir;

    for (let index = 0; index < 65; index += 1) {
      deepDir = join(deepDir, "d");
    }
    await mkdir(deepDir, { recursive: true });

    try {
      await writeFile(join(deepDir, "notes.md"), "Deep evidence should not trigger unbounded recursion.", "utf8");
      const provider = createLocalSearchProvider({ rootDir });

      await expect(
        provider.search({
          claimId: "claim-1",
          query: "deep evidence",
          maxResults: 1
        })
      ).rejects.toThrow("Local source directory nesting must be at most 64 levels:");
      await expect(getLocalIndexCacheInfo({ rootDir })).rejects.toThrow("Local source directory nesting must be at most 64 levels:");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects too many supported local source files", async () => {
    const rootDir = join(tmpdir(), `sourceline-local-file-count-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      for (let start = 0; start < 5_001; start += 100) {
        await Promise.all(
          Array.from({ length: Math.min(100, 5_001 - start) }, (_, offset) =>
            writeFile(join(rootDir, `note-${String(start + offset).padStart(4, "0")}.md`), "", "utf8")
          )
        );
      }

      const provider = createLocalSearchProvider({ rootDir });

      await expect(
        provider.search({
          claimId: "claim-1",
          query: "evidence",
          maxResults: 1
        })
      ).rejects.toThrow("Local sources must contain at most 5000 supported files:");
      await expect(getLocalIndexCacheInfo({ rootDir })).rejects.toThrow("Local sources must contain at most 5000 supported files:");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("honors .sourcelineignore patterns in the source folder", async () => {
    const rootDir = join(tmpdir(), `sourceline-ignore-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, ".sourcelineignore"), "private.txt\nignored/\n", "utf8");
      await writeFile(join(rootDir, "public.md"), "Public evidence mentions SourceLine reports.", "utf8");
      await writeFile(join(rootDir, "private.txt"), "Private evidence should not appear.", "utf8");
      await mkdir(join(rootDir, "ignored"), { recursive: true });
      await writeFile(join(rootDir, "ignored", "note.md"), "Ignored folder evidence should not appear.", "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "evidence appear SourceLine",
        maxResults: 10
      });

      expect(results.map((result) => result.path)).toEqual([expect.stringMatching(/public\.md$/)]);
      expect(results.some((result) => result.snippet?.includes("Private evidence"))).toBe(false);
      expect(results.some((result) => result.snippet?.includes("Ignored folder evidence"))).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects local ignore paths that are not files", async () => {
    const rootDir = join(tmpdir(), `sourceline-ignore-dir-${Date.now()}`);
    await mkdir(join(rootDir, ".sourcelineignore"), { recursive: true });

    try {
      const provider = createLocalSearchProvider({ rootDir });

      await expect(
        provider.search({
          claimId: "claim-1",
          query: "SourceLine evidence",
          maxResults: 1
        })
      ).rejects.toThrow("Local ignore file must be a file:");
      await expect(getLocalIndexCacheInfo({ rootDir })).rejects.toThrow("Local ignore file must be a file:");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects oversized local ignore files before reading patterns", async () => {
    const rootDir = join(tmpdir(), `sourceline-ignore-large-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, ".sourcelineignore"), "x".repeat(1_000_001), "utf8");

      await expect(getLocalIndexCacheInfo({ rootDir })).rejects.toThrow("Local ignore file is larger than 1000000 bytes:");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects local ignore rules with control characters", async () => {
    const rootDir = join(tmpdir(), `sourceline-ignore-control-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, ".sourcelineignore"), "public.md\nbad\u0000pattern\n", "utf8");

      await expect(getLocalIndexCacheInfo({ rootDir })).rejects.toThrow("Local ignore rule must not contain control characters:");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects overlong local ignore rules", async () => {
    const rootDir = join(tmpdir(), `sourceline-ignore-rule-large-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, ".sourcelineignore"), `${"x".repeat(1_001)}\n`, "utf8");

      await expect(getLocalIndexCacheInfo({ rootDir })).rejects.toThrow("Local ignore rule must be at most 1000 characters:");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects too many local ignore rules", async () => {
    const rootDir = join(tmpdir(), `sourceline-ignore-too-many-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const rules = Array.from({ length: 1_001 }, (_, index) => `private-${index}.md`).join("\n");
      await writeFile(join(rootDir, ".sourcelineignore"), `${rules}\n`, "utf8");

      await expect(getLocalIndexCacheInfo({ rootDir })).rejects.toThrow("Local ignore files must define at most 1000 rules.");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("supports negated .sourcelineignore patterns", async () => {
    const rootDir = join(tmpdir(), `sourceline-negated-ignore-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await writeFile(join(rootDir, ".sourcelineignore"), "ignored/\n!ignored/keep.md\n*.txt\n!visible.txt\n", "utf8");
      await mkdir(join(rootDir, "ignored"), { recursive: true });
      await writeFile(join(rootDir, "ignored", "keep.md"), "Important SourceLine evidence should appear.", "utf8");
      await writeFile(join(rootDir, "ignored", "drop.md"), "Dropped SourceLine evidence should not appear.", "utf8");
      await writeFile(join(rootDir, "visible.txt"), "Visible SourceLine text evidence should appear.", "utf8");
      await writeFile(join(rootDir, "hidden.txt"), "Hidden SourceLine text evidence should not appear.", "utf8");

      const provider = createLocalSearchProvider({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "SourceLine evidence appear",
        maxResults: 10
      });
      const paths = results.map((result) => result.path.replace(/\\/g, "/"));

      expect(paths).toEqual(
        expect.arrayContaining([expect.stringMatching(/ignored\/keep\.md$/), expect.stringMatching(/visible\.txt$/)])
      );
      expect(paths.some((path) => /ignored\/drop\.md$/.test(path))).toBe(false);
      expect(paths.some((path) => /hidden\.txt$/.test(path))).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("skips local source files that disappear after directory scanning", async () => {
    vi.resetModules();
    const rootDir = join(tmpdir(), `sourceline-vanishing-source-${Date.now()}`);
    const vanishingPath = join(rootDir, "vanishing.md");
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, "stable.md"), "Stable SourceLine evidence remains searchable.", "utf8");
    await writeFile(vanishingPath, "Vanishing SourceLine evidence should not break indexing.", "utf8");

    let removed = false;
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();

      return {
        ...actual,
        readdir: async (...args: Parameters<typeof actual.readdir>) => {
          const entries = await actual.readdir(...args);
          if (!removed && args[0] === rootDir) {
            removed = true;
            await actual.rm(vanishingPath, { force: true });
          }
          return entries;
        }
      };
    });

    try {
      const { createLocalSearchProvider: createLocalSearchProviderWithMockedFs } = await import("./local.js");
      const provider = createLocalSearchProviderWithMockedFs({
        rootDir,
        now: () => new Date("2026-06-07T08:00:00.000Z")
      });

      const results = await provider.search({
        claimId: "claim-1",
        query: "Stable SourceLine evidence",
        maxResults: 5
      });

      expect(removed).toBe(true);
      expect(results.map((result) => result.path.replace(/\\/g, "/"))).toEqual([expect.stringMatching(/stable\.md$/)]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
