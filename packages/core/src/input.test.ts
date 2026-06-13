import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadInput } from "./input.js";

const coreRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const coreVersion = (JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8")) as { version: string }).version;

describe("loadInput", () => {
  it("loads readable text from local HTML files", async () => {
    const rootDir = join(tmpdir(), `sourceline-html-input-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const htmlPath = join(rootDir, "answer.html");
      await writeFile(
        htmlPath,
        `<!doctype html>
        <html>
          <head>
            <style>.hidden { display: none; }</style>
          </head>
          <body>
            <h1>SourceLine &amp; HTML</h1>
            <script>window.noise = true;</script>
            <p>Local HTML input becomes readable text.</p>
          </body>
        </html>`,
        "utf8"
      );

      const input = await loadInput({
        kind: "file",
        path: htmlPath
      });

      expect(input.kind).toBe("file");
      expect(input.name).toBe("answer.html");
      expect(input.text).toContain("SourceLine & HTML");
      expect(input.text).toContain("Local HTML input becomes readable text.");
      expect(input.text).toContain("SourceLine & HTML\n\nLocal HTML input becomes readable text.");
      expect(input.text).not.toContain("window.noise");
      expect(input.text).not.toContain("display: none");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps adjacent HTML list items separated in local files", async () => {
    const rootDir = join(tmpdir(), `sourceline-html-list-input-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const htmlPath = join(rootDir, "list.html");
      await writeFile(
        htmlPath,
        `<!doctype html>
        <html>
          <body>
            <ul><li>SourceLine extracts claims<li>Evidence reports stay readable</ul>
          </body>
        </html>`,
        "utf8"
      );

      const input = await loadInput({
        kind: "file",
        path: htmlPath
      });

      expect(input.text).toContain("SourceLine extracts claims\n\nEvidence reports stay readable");
      expect(input.text).not.toContain("claimsEvidence");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects local file inputs with no readable text", async () => {
    const rootDir = join(tmpdir(), `sourceline-empty-file-input-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const textPath = join(rootDir, "empty.txt");
      const htmlPath = join(rootDir, "empty.html");
      await writeFile(textPath, " \n\t ", "utf8");
      await writeFile(
        htmlPath,
        "<!doctype html><html><head><style>body{color:red}</style></head><body><script>window.noise = true;</script></body></html>",
        "utf8"
      );

      await expect(loadInput({ kind: "file", path: textPath })).rejects.toThrow("contains no readable text");
      await expect(loadInput({ kind: "file", path: htmlPath })).rejects.toThrow("contains no readable text");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects inline text inputs with no readable text", async () => {
    await expect(loadInput({ kind: "text", text: " \n\t " })).rejects.toThrow("Text input contains no readable text.");
    await expect(loadInput({ kind: "stdin", text: " \n\t " })).rejects.toThrow("Stdin contains no readable text.");
  });

  it("loads and cleans readable text from HTML URLs", async () => {
    const input = await loadInput({
      kind: "url",
      url: "https://example.com/report",
      fetchImpl: async () =>
        new Response(
          `<!doctype html>
          <html>
            <head>
              <title>Ignored title</title>
              <style>.hidden { display: none; }</style>
              <script>window.noise = true;</script>
            </head>
            <body>
              <h1>SourceLine &amp; Evidence</h1>
              <p>Markdown reports make verification easier.</p>
            </body>
          </html>`,
          {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8"
            }
          }
        )
    });

    expect(input.kind).toBe("url");
    expect(input.name).toBe("https://example.com/report");
    expect(input.text).toContain("SourceLine & Evidence");
    expect(input.text).toContain("Markdown reports make verification easier.");
    expect(input.text).toContain("SourceLine & Evidence\n\nMarkdown reports make verification easier.");
    expect(input.text).not.toContain("Ignored title");
    expect(input.text).not.toContain("window.noise");
    expect(input.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps adjacent HTML list items separated in URL input", async () => {
    const input = await loadInput({
      kind: "url",
      url: "https://example.com/list",
      fetchImpl: async () =>
        new Response("<body><ul><li>First source claim<li>Second source claim</ul></body>", {
          status: 200,
          headers: {
            "content-type": "text/html"
          }
        })
    });

    expect(input.text).toContain("First source claim\n\nSecond source claim");
    expect(input.text).not.toContain("claimSecond");
  });
  it("loads plain-text URLs without HTML cleanup", async () => {
    let requestedHeaders: HeadersInit | undefined;
    const input = await loadInput({
      kind: "url",
      url: "https://example.com/plain.txt",
      fetchImpl: async (_url, init) => {
        requestedHeaders = init?.headers;
        return new Response("SourceLine checks plain text URLs.", {
          status: 200,
          headers: {
            "content-type": "text/plain"
          }
        });
      }
    });

    expect(input.text).toBe("SourceLine checks plain text URLs.");
    expect(new Headers(requestedHeaders).get("user-agent")).toBe(`SourceLine/${coreVersion}`);
  });

  it("rejects URL inputs with oversized content-length headers before reading the body", async () => {
    await expect(
      loadInput({
        kind: "url",
        url: "https://example.com/large",
        fetchImpl: async () =>
          new Response("SourceLine should not read this body.", {
            status: 200,
            headers: {
              "content-length": "2000001",
              "content-type": "text/plain"
            }
          })
      })
    ).rejects.toThrow("larger than 2000000 bytes");
  });

  it("ignores malformed content-length headers and still reads bounded URL bodies", async () => {
    const input = await loadInput({
      kind: "url",
      url: "https://example.com/malformed-length",
      fetchImpl: async () =>
        new Response("SourceLine reads bounded bodies despite bad length headers.", {
          status: 200,
          headers: {
            "content-length": "2000001abc",
            "content-type": "text/plain"
          }
        })
    });

    expect(input.text).toBe("SourceLine reads bounded bodies despite bad length headers.");
  });

  it("keeps malformed numeric HTML entities from breaking URL input", async () => {
    const input = await loadInput({
      kind: "url",
      url: "https://example.com/bad-entity",
      fetchImpl: async () =>
        new Response("<body><p>Broken &#9999999999; and hex &#x41; remain useful.</p></body>", {
          status: 200,
          headers: {
            "content-type": "text/html"
          }
        })
    });

    expect(input.text).toBe("Broken &#9999999999; and hex A remain useful.");
  });

  it("raises a useful error for failed URL fetches", async () => {
    await expect(
      loadInput({
        kind: "url",
        url: "https://example.com/missing",
        fetchImpl: async () => new Response("Missing", { status: 404 })
      })
    ).rejects.toThrow("HTTP 404");
  });

  it("rejects unsupported URL protocols", async () => {
    await expect(
      loadInput({
        kind: "url",
        url: "file:///tmp/source.md",
        fetchImpl: async () => new Response("not used")
      })
    ).rejects.toThrow('Unsupported URL protocol "file:"');
  });

  it("rejects URL inputs with blank values or control characters before fetching", async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response("not used");
    };

    await expect(
      loadInput({
        kind: "url",
        url: "   ",
        fetchImpl
      })
    ).rejects.toThrow("Invalid URL input: URL must not be empty.");

    await expect(
      loadInput({
        kind: "url",
        url: "https://example.com/\nchanged",
        fetchImpl
      })
    ).rejects.toThrow("Invalid URL input: URL must not contain control characters.");

    expect(fetchCalls).toBe(0);
  });

  it("raises a useful error when URL fetches are aborted", async () => {
    await expect(
      loadInput({
        kind: "url",
        url: "https://example.com/slow",
        fetchImpl: async () => {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
      })
    ).rejects.toThrow("Timed out fetching https://example.com/slow after 15000 ms.");
  });

  it("includes the URL when network fetches fail", async () => {
    await expect(
      loadInput({
        kind: "url",
        url: "https://example.com/network",
        fetchImpl: async () => {
          throw new Error("socket disconnected");
        }
      })
    ).rejects.toThrow("Failed to fetch https://example.com/network: socket disconnected");
  });});
