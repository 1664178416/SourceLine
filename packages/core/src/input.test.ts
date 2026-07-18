import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
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
            <template><p>templatedraftonly hidden input text.</p></template>
            <svg><title>Decorative Input Icon</title><text>svgicononly hidden input text.</text></svg>
            <div hidden><p>hiddenattronly hidden input text.</p></div>
            <section aria-hidden="true"><p>ariahiddenonly hidden input text.</p></section>
            <aside style="display:none"><p>displaynoneonly hidden input text.</p></aside>
            <div style="color:red; visibility: hidden"><p>visibilityhiddenonly hidden input text.</p></div>
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
      expect(input.text).not.toContain("templatedraftonly");
      expect(input.text).not.toContain("svgicononly");
      expect(input.text).not.toContain("hiddenattronly");
      expect(input.text).not.toContain("ariahiddenonly");
      expect(input.text).not.toContain("displaynoneonly");
      expect(input.text).not.toContain("visibilityhiddenonly");
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

  it("ignores fake body tags in comments and scripts for local HTML files", async () => {
    const rootDir = join(tmpdir(), `sourceline-html-fake-body-input-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const htmlPath = join(rootDir, "fake-body.html");
      await writeFile(
        htmlPath,
        `<!-- <body><p>commentbodyonly hidden text</p></body> -->
        <script>const ignored = "<body><p>scriptbodyonly hidden text</p></body>";</script>
        <html>
          <body>
            <h1>Actual Input Title</h1>
            <p>Actual input evidence remains readable.</p>
          </body>
        </html>`,
        "utf8"
      );

      const input = await loadInput({
        kind: "file",
        path: htmlPath
      });

      expect(input.text).toContain("Actual Input Title\n\nActual input evidence remains readable.");
      expect(input.text).not.toContain("commentbodyonly");
      expect(input.text).not.toContain("scriptbodyonly");
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

  it("rejects local file inputs larger than the input byte limit", async () => {
    const rootDir = join(tmpdir(), `sourceline-large-file-input-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const textPath = join(rootDir, "large.txt");
      await writeFile(textPath, "x".repeat(2_000_001), "utf8");

      await expect(loadInput({ kind: "file", path: textPath })).rejects.toThrow("larger than 2000000 bytes");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("bounds local file reads even if the file grows after metadata is checked", async () => {
    vi.resetModules();
    let closeCalls = 0;

    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();

      return {
        ...actual,
        stat: async () => ({
          isFile: () => true,
          size: 1
        }),
        open: async () => ({
          read: async (buffer: Buffer) => ({ bytesRead: buffer.length }),
          close: async () => {
            closeCalls += 1;
          }
        })
      };
    });

    try {
      const { loadInput: loadInputWithMockedFs } = await import("./input.js");

      await expect(loadInputWithMockedFs({ kind: "file", path: "growing.txt" })).rejects.toThrow(
        "larger than 2000000 bytes"
      );
      expect(closeCalls).toBe(1);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("normalizes local file paths before reading", async () => {
    const rootDir = join(tmpdir(), `sourceline-trim-file-input-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      const textPath = join(rootDir, "answer.txt");
      await writeFile(textPath, "SourceLine trims file paths at the core boundary.", "utf8");

      const input = await loadInput({
        kind: "file",
        path: `  ${textPath}  `
      });

      expect(input.text).toBe("SourceLine trims file paths at the core boundary.");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe local file input paths before reading", async () => {
    await expect(loadInput({ kind: "file", path: "   " })).rejects.toThrow("File input path must not be empty.");
    await expect(loadInput({ kind: "file", path: "source\nanswer.md" })).rejects.toThrow(
      "File input path must not contain control characters."
    );
    await expect(loadInput({ kind: "file", path: "x".repeat(2_001) })).rejects.toThrow(
      "File input path must be at most 2000 characters."
    );
    await expect(loadInput({ kind: "file", path: "sources/" })).rejects.toThrow(
      "File input path must be a file path, not a directory."
    );
    await expect(loadInput({ kind: "file", path: "sources\\" })).rejects.toThrow(
      "File input path must be a file path, not a directory."
    );
  });

  it("rejects local file inputs that point to directories", async () => {
    const rootDir = join(tmpdir(), `sourceline-dir-file-input-${Date.now()}`);
    await mkdir(rootDir, { recursive: true });

    try {
      await expect(loadInput({ kind: "file", path: rootDir })).rejects.toThrow("File input must be a file:");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects inline text inputs with no readable text", async () => {
    await expect(loadInput({ kind: "text", text: " \n\t " })).rejects.toThrow("Text input contains no readable text.");
    await expect(loadInput({ kind: "stdin", text: " \n\t " })).rejects.toThrow("Stdin contains no readable text.");
  });

  it("rejects inline text and stdin inputs larger than the input byte limit", async () => {
    const oversizedText = "x".repeat(2_000_001);

    await expect(loadInput({ kind: "text", text: oversizedText })).rejects.toThrow("Text input is larger than 2000000 bytes");
    await expect(loadInput({ kind: "stdin", text: oversizedText })).rejects.toThrow("Stdin input is larger than 2000000 bytes");
  });

  it("rejects unsupported input kinds instead of treating them as text", async () => {
    await expect(loadInput({ kind: "clipboard", text: "Readable text." } as never)).rejects.toThrow(
      'Unsupported input kind "clipboard". Use file, url, stdin, or text.'
    );
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
              <template><p>templatedraftonly hidden URL text.</p></template>
              <svg><title>Decorative URL Icon</title><text>svgicononly hidden URL text.</text></svg>
              <div hidden><p>hiddenattronly hidden URL text.</p></div>
              <section aria-hidden="true"><p>ariahiddenonly hidden URL text.</p></section>
              <aside style="display:none"><p>displaynoneonly hidden URL text.</p></aside>
              <div style="color:red; visibility: hidden"><p>visibilityhiddenonly hidden URL text.</p></div>
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
    expect(input.text).not.toContain("templatedraftonly");
    expect(input.text).not.toContain("svgicononly");
    expect(input.text).not.toContain("hiddenattronly");
    expect(input.text).not.toContain("ariahiddenonly");
    expect(input.text).not.toContain("displaynoneonly");
    expect(input.text).not.toContain("visibilityhiddenonly");
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

  it("ignores fake body tags in comments and scripts for HTML URLs", async () => {
    const input = await loadInput({
      kind: "url",
      url: "https://example.com/fake-body",
      fetchImpl: async () =>
        new Response(
          `<!-- <body><p>commentbodyonly hidden text</p></body> -->
          <script>const ignored = "<body><p>scriptbodyonly hidden text</p></body>";</script>
          <html>
            <body>
              <h1>Actual URL Title</h1>
              <p>Actual URL evidence remains readable.</p>
            </body>
          </html>`,
          {
            status: 200,
            headers: {
              "content-type": "text/html"
            }
          }
        )
    });

    expect(input.text).toContain("Actual URL Title\n\nActual URL evidence remains readable.");
    expect(input.text).not.toContain("commentbodyonly");
    expect(input.text).not.toContain("scriptbodyonly");
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

  it("bounds URL response text when a fetch implementation does not expose a stream", async () => {
    const oversizedBody = "x".repeat(2_000_001);

    await expect(
      loadInput({
        kind: "url",
        url: "https://example.com/no-stream",
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers({
              "content-type": "text/plain"
            }),
            body: undefined,
            text: async () => oversizedBody
          }) as Response
      })
    ).rejects.toThrow("larger than 2000000 bytes");
  });

  it("times out URL response body reads that never finish", async () => {
    vi.useFakeTimers();

    try {
      const pendingInput = loadInput({
        kind: "url",
        url: "https://example.com/hung-body",
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers({
              "content-type": "text/plain"
            }),
            body: undefined,
            text: async () => await new Promise<string>(() => undefined)
          }) as Response
      });
      const assertion = expect(pendingInput).rejects.toThrow("Timed out fetching https://example.com/hung-body after 15000 ms.");

      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
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

  it("rejects URL inputs with embedded credentials before fetching", async () => {
    let fetchCalls = 0;
    await expect(
      loadInput({
        kind: "url",
        url: "https://user:secret@example.com/private",
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response("not used");
        }
      })
    ).rejects.toThrow("Invalid URL input: URL must not include username or password.");

    expect(fetchCalls).toBe(0);
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
        url: `https://example.com/${"a".repeat(2_000)}`,
        fetchImpl
      })
    ).rejects.toThrow("Invalid URL input: URL must be at most 2000 characters.");

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

  it("times out URL fetches even when fetch ignores abort signals", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let aborted = false;

    try {
      const pendingInput = loadInput({
        kind: "url",
        url: "https://example.com/hangs",
        fetchImpl: async (_url, init) => {
          signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
          signal?.addEventListener("abort", () => {
            aborted = true;
          });

          return await new Promise<Response>(() => undefined);
        }
      });
      const assertion = expect(pendingInput).rejects.toThrow("Timed out fetching https://example.com/hangs after 15000 ms.");

      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(true);
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
  });

  it("normalizes and bounds noisy URL fetch failures", async () => {
    let thrown: unknown;
    try {
      await loadInput({
        kind: "url",
        url: "https://example.com/noisy-network",
        fetchImpl: async () => {
          throw new Error(`bad\n\u001b[31mred\u001b[0m\u0007 ${"x".repeat(1_500)} hidden-tail`);
        }
      });
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    const prefix = "Failed to fetch https://example.com/noisy-network: ";
    expect(message.startsWith(`${prefix}bad red `)).toBe(true);
    expect(message).toContain("[truncated]");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("\u0007");
    expect(message).not.toContain("hidden-tail");
    expect(message.length).toBeLessThanOrEqual(prefix.length + 1_000);
  });
});
