import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rewriteAssetUrls } from "../src/index.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const fixtureNames = Object.keys(
  JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>,
);

// Renaming a.md → b.md: each case is the whole source and the whole expected output (task 2.18).
describe("rewriteAssetUrls: destinations into assets/<old>/ are rewritten", () => {
  it("rewrites an image destination", () => {
    expect(rewriteAssetUrls("See ![x](assets/a/x.png) here.\n", "a", "b")).toBe("See ![x](assets/b/x.png) here.\n");
  });

  it("rewrites a ./assets/<old>/ destination, keeping the ./", () => {
    expect(rewriteAssetUrls("![x](./assets/a/x.png)\n", "a", "b")).toBe("![x](./assets/b/x.png)\n");
  });

  it("rewrites a link destination", () => {
    expect(rewriteAssetUrls("[the scan](assets/a/scan.pdf)\n", "a", "b")).toBe("[the scan](assets/b/scan.pdf)\n");
  });

  it("rewrites a definition destination, leaving the reference that uses it", () => {
    expect(rewriteAssetUrls("![x][pen]\n\n[pen]: assets/a/pen.png\n", "a", "b")).toBe(
      "![x][pen]\n\n[pen]: assets/b/pen.png\n",
    );
  });

  it("rewrites the destination but not alt text or a title holding the same bytes", () => {
    expect(rewriteAssetUrls('![assets/a/x.png](assets/a/x.png "assets/a/x.png")\n', "a", "b")).toBe(
      '![assets/a/x.png](assets/b/x.png "assets/a/x.png")\n',
    );
  });

  it("rewrites an angle-bracketed destination whose stems hold a space", () => {
    expect(rewriteAssetUrls("![x](<assets/my essay/x.png>)\n", "my essay", "our essay")).toBe(
      "![x](<assets/our essay/x.png>)\n",
    );
  });

  it("re-spells a bare destination inside angle brackets when the new stem holds a space", () => {
    expect(rewriteAssetUrls("![x](assets/a/x.png)\n", "a", "my essay")).toBe("![x](<assets/my essay/x.png>)\n");
  });

  it("rewrites every destination, including an image inside a link, keeping CRLF bytes", () => {
    expect(rewriteAssetUrls("[![i](assets/a/i.png)](assets/a/big.png)\r\n\r\n![j](assets/a/j.png)\r\n", "a", "b")).toBe(
      "[![i](assets/b/i.png)](assets/b/big.png)\r\n\r\n![j](assets/b/j.png)\r\n",
    );
  });
});

describe("rewriteAssetUrls: authored literals holding the same bytes stay byte-identical", () => {
  const cases: [string, string][] = [
    ["a prose literal", "The folder assets/a/x.png holds it.\n"],
    ["inline code", "Run `cp x assets/a/x.png` first.\n"],
    ["fenced code", "```\n![x](assets/a/x.png)\n```\n"],
    ["html", '<img src="assets/a/x.png">\n'],
    ["yaml", "---\nref: assets/a/x.png\n---\n\n# A\n"],
    ["../assets/<old>/", "![x](../assets/a/x.png)\n"],
    ["sub/assets/<old>/", "![x](sub/assets/a/x.png)\n"],
    ["https://…/assets/<old>/", "![x](https://example.com/assets/a/x.png)\n"],
    ["alt text", "![assets/a/x.png](other/x.png)\n"],
    ["a destination whose prefix is spelled with a character reference", "![x](assets/&#97;/x.png)\n"],
  ];
  it("leaves the source identical when the stem does not change", () => {
    const source = "![x](assets/a/x.png)\n";
    expect(rewriteAssetUrls(source, "a", "a")).toBe(source);
  });

  for (const [name, source] of cases) {
    it(`leaves ${name} byte-identical`, () => {
      expect(rewriteAssetUrls(source, "a", "b")).toBe(source);
    });
  }
});

describe("rewriteAssetUrls: corpus identity leg (fixtures/markdown/index.json)", () => {
  it("reads a non-empty fixture list from the index", () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  for (const name of fixtureNames) {
    it(`${name}: no destination into the renamed stem → the identical string`, () => {
      const source = readFileSync(`${FIXTURES}/${name}`, "utf8");
      expect(rewriteAssetUrls(source, "no-such-stem", "other-stem")).toBe(source);
    });

    it(`${name}: renaming every stem it references there and back → the identical string`, () => {
      const source = readFileSync(`${FIXTURES}/${name}`, "utf8");
      const stems = new Set([...source.matchAll(/assets\/([^/\s()<>"]+(?: [^/\s()<>"]+)*)\//g)].map((m) => m[1] ?? ""));
      for (const stem of stems) {
        const there = rewriteAssetUrls(source, stem, `${stem}-renamed`);
        expect(rewriteAssetUrls(there, `${stem}-renamed`, stem)).toBe(source);
      }
    });
  }
});
