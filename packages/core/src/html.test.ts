import { describe, expect, it } from "vitest";
import { htmlToText } from "./html.js";

describe("htmlToText", () => {
  it("extracts normalized visible text from HTML", () => {
    const text = htmlToText(`<!doctype html>
      <!-- <body><p>commentonly hidden text</p></body> -->
      <script>const ignored = "<body><p>scriptonly hidden text</p></body>";</script>
      <html>
        <body>
          <h1>SourceLine &amp; HTML</h1>
          <template><p>templateonly hidden text.</p></template>
          <svg><title>Icon</title><text>svgonly hidden text.</text></svg>
          <div hidden><p>hiddenattronly hidden text.</p></div>
          <section aria-hidden="true"><p>ariahiddenonly hidden text.</p></section>
          <aside style="display:none"><p>displaynoneonly hidden text.</p></aside>
          <div style="visibility: hidden"><p>visibilityhiddenonly hidden text.</p></div>
          <p>Visible evidence remains readable.</p>
        </body>
      </html>`);

    expect(text).toBe("SourceLine & HTML\n\nVisible evidence remains readable.");
    expect(text).not.toContain("commentonly");
    expect(text).not.toContain("scriptonly");
    expect(text).not.toContain("templateonly");
    expect(text).not.toContain("svgonly");
    expect(text).not.toContain("hiddenattronly");
    expect(text).not.toContain("ariahiddenonly");
    expect(text).not.toContain("displaynoneonly");
    expect(text).not.toContain("visibilityhiddenonly");
  });

  it("decodes each HTML entity exactly once", () => {
    expect(htmlToText("<p>&amp;lt;tag&amp;gt; &amp;#65; &amp;amp; &lt;ok&gt; &#65; &#x42;</p>")).toBe(
      "&lt;tag&gt; &#65; &amp; <ok> A B"
    );
  });

  it("keeps unsafe numeric entities printable while normalizing valid whitespace", () => {
    expect(htmlToText("<p>before&#13;after &#0; &#27; &#xD800; &#x1F600;</p>")).toBe(
      "before\nafter &#0; &#27; &#xD800; \u{1f600}"
    );
  });
});
