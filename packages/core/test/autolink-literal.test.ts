import type { Link, Root } from "mdast";
import type { Options } from "remark-stringify";
import type { Data, Processor } from "unified";
import { describe, expect, it } from "vitest";
import { createFormatter, format, handleRoot } from "../src/format.js";
import { formatWithMap } from "../src/positions.js";
import { parse } from "../src/parse.js";

type ToMarkdownExtensions = NonNullable<Data["toMarkdownExtensions"]>;
type Handlers = NonNullable<Options["handlers"]>;
type Handle = NonNullable<Handlers[keyof Handlers]>;
type PeekableHandle = Handle & { peek?: Handle };
type ToMarkdownState = Parameters<Handle>[2];

/**
 * The autolink half of invariant A (task 1.50, DECISIONS #review-1-r6 L2): a link the serializer
 * writes in the `<…>` form must parse back to the same url, because CommonMark §6.4 reads the
 * bytes between the angle brackets literally and nothing inside them can be escaped. The
 * built-in `link` handler (`mdast-util-to-markdown/lib/handle/link.js:28-45`, read in
 * node_modules at 2.1.2) hides the construct stack for that form — `state.stack = []` — and
 * writes `state.containerPhrasing(node)`, so the text child still goes through `safe()` with
 * `before: "<"` and `after: ">"`. With the stack empty, `patternInScope` (`lib/util/pattern-in-scope.js:28-29`,
 * `listInScope` answers `none` — `true` — for a pattern without `inConstruct`) admits exactly the
 * `unsafe` entries that have no `inConstruct`, plus `safe()`'s own backslash rule. Enumerated
 * here, one row each, with the line read:
 *
 * - `\` — `lib/util/safe.js:147` (`escapeBackslashes`, applied at :109 and :127; :152 appends
 *   `config.after`, so the closing `>` counts as the next character): a backslash before ASCII
 *   punctuation `[!-/:-@[-`{-~]` is doubled. The presence rows: `https://x.y\` (before `>`) and
 *   `Foo\_bar` (before `_`). The `+z` twin — a letter after — is an absence row.
 * - `lib/unsafe.js` entries without `inConstruct`, every one `atBreak`: `#` :69, `)` :87, `*`
 *   :90, `+` :93, `-` :96, `.` :98, `<` :105, `=` :114, `>` :117, `[` :121, `_` :132, `` ` ``
 *   :136, `~` :145. `compile-pattern.js:11` compiles `atBreak` to require `[\r\n][\t ]*` before
 *   the character, and `format-link-as-autolink.js:32` refuses a url holding any of `\0`–` `, so
 *   none can fire inside an autolink: these are the absence rows, the autolink form kept.
 * - The extensions' entries `state.unsafe` also holds (`lib/configure.js` merges them):
 *   `mdast-util-gfm-table/lib/index.js` `|` :165, `:` :170, `-` :176, all `atBreak` — absence
 *   rows for the same reason; every entry of `mdast-util-gfm-strikethrough` and
 *   `mdast-util-gfm-autolink-literal` has an `inConstruct` and is out of scope.
 * - `<` and `>` are also refused by `format-link-as-autolink.js:32` itself, so the built-in
 *   writes the resource form for them without the app's fallback; their source can only be a
 *   resource link (neither the GFM literal nor a `<…>` autolink can hold them).
 *
 * Each row is built at two positions — `https://x.y/` + c + `z` and the trailing twin
 * `https://x.y` + c — and asserts four things: the bytes `format(parse(·))` writes (`toBe`), the
 * `parse ∘ format` fixed point, that the parse holds exactly one `link` whose `url` is the source
 * url, and that the text values joined equal the source tree's. The source is the `<…>` autolink
 * (the parser's own tree for the form under test) except for `<` and `>`.
 */

interface Row {
  character: string;
  /** The rule that names the character, as `file:line`. */
  rule: string;
  /** The bytes expected for `https://x.y/` + c + `z` and `https://x.y` + c; absent → `<url>`. */
  bytes?: { mid: string; trailing: string };
  /** `[url](url)` as the source, for the two characters no autolink form can hold. */
  resourceSource?: true;
}

const ROWS: Row[] = [
  {
    character: "\\",
    rule: "safe.js:147 (escapeBackslashes; :152 counts `after`)",
    // `\z`: a letter after, nothing doubled, the autolink kept. `\` before `>`: doubled, so the
    // app falls back to the resource form, whose label and destination both decode `\\` to `\`.
    bytes: { mid: "<https://x.y/\\z>\n", trailing: "[https://x.y\\\\](https://x.y\\\\)\n" },
  },
  { character: "#", rule: "unsafe.js:69 (atBreak)" },
  { character: ")", rule: "unsafe.js:87 (atBreak, before \\d+)" },
  { character: "*", rule: "unsafe.js:90 (atBreak)" },
  { character: "+", rule: "unsafe.js:93 (atBreak)" },
  { character: "-", rule: "unsafe.js:96 (atBreak); gfm-table lib/index.js:176 (atBreak)" },
  { character: ".", rule: "unsafe.js:98 (atBreak, before \\d+)" },
  {
    character: "<",
    rule: "unsafe.js:105 (atBreak); refused by format-link-as-autolink.js:32",
    // The built-in's own resource form: `<z` is escaped in a label (unsafe.js:106-111, in
    // `phrasing`), a trailing `<` before `]` is not.
    bytes: { mid: "[https://x.y/\\<z](https://x.y/<z)\n", trailing: "[https://x.y<](https://x.y<)\n" },
    resourceSource: true,
  },
  { character: "=", rule: "unsafe.js:114 (atBreak)" },
  {
    character: ">",
    rule: "unsafe.js:117 (atBreak); refused by format-link-as-autolink.js:32",
    bytes: { mid: "[https://x.y/>z](https://x.y/>z)\n", trailing: "[https://x.y>](https://x.y>)\n" },
    resourceSource: true,
  },
  { character: "[", rule: "unsafe.js:121 (atBreak)" },
  { character: "_", rule: "unsafe.js:132 (atBreak)" },
  { character: "`", rule: "unsafe.js:136 (atBreak)" },
  { character: "~", rule: "unsafe.js:145 (atBreak)" },
  { character: "|", rule: "gfm-table lib/index.js:165 (atBreak)" },
  { character: ":", rule: "gfm-table lib/index.js:170 (atBreak)" },
];

function links(root: Root): Link[] {
  const out: Link[] = [];
  const walk = (node: { type: string; children?: unknown[] }): void => {
    if (node.type === "link") out.push(node as Link);
    for (const child of node.children ?? []) walk(child as { type: string; children?: unknown[] });
  };
  walk(root);
  return out;
}

/** Every `value`-bearing node's text, in document order. */
function textValues(root: Root): string {
  const out: string[] = [];
  const walk = (node: { type: string; value?: string; children?: unknown[] }): void => {
    if (typeof node.value === "string") out.push(node.value);
    for (const child of node.children ?? []) {
      walk(child as { type: string; value?: string; children?: unknown[] });
    }
  };
  walk(root);
  return out.join("");
}

/** The four assertions every row and every named guard makes, for one source and one url. */
function assertRoundTrip(source: string, url: string, bytes: string): void {
  const tree = parse(source);
  const found = links(tree);
  expect(found.length, `${JSON.stringify(source)}: one link`).toBe(1);
  expect(found[0].url, `${JSON.stringify(source)}: the source url`).toBe(url);
  const out = format(tree);
  expect(out, `${JSON.stringify(source)}: bytes`).toBe(bytes);
  const reparsed = parse(out);
  expect(format(reparsed), `${JSON.stringify(source)}: fixed point`).toBe(out);
  expect(links(reparsed).map((link) => link.url), `${JSON.stringify(source)}: url kept`).toEqual([url]);
  expect(textValues(reparsed), `${JSON.stringify(source)}: text values`).toBe(textValues(tree));
}

describe("autolink round trip (task 1.50, L2): the `<…>` form is written exactly when it carries the url byte for byte", () => {
  describe("every character `safe()` can rewrite with the construct stack hidden, at two positions", () => {
    for (const row of ROWS) {
      const mid = `https://x.y/${row.character}z`;
      const trailing = `https://x.y${row.character}`;
      const source = (url: string): string => (row.resourceSource ? `[${url}](${url})\n` : `<${url}>\n`);
      it(`${JSON.stringify(row.character)} — ${row.rule} — mid: bytes, fixed point, one link with the url, text equal`, () => {
        assertRoundTrip(source(mid), mid, row.bytes?.mid ?? `<${mid}>\n`);
      });
      it(`${JSON.stringify(row.character)} — ${row.rule} — trailing: bytes, fixed point, one link with the url, text equal`, () => {
        assertRoundTrip(source(trailing), trailing, row.bytes?.trailing ?? `<${trailing}>\n`);
      });
    }

    it("the rows are exactly the stack-hidden set: one backslash rule, thirteen unsafe.js entries, two gfm-table characters", () => {
      // The `-` entry is both unsafe.js:96 and gfm-table :176, so the table has 16 rows for the
      // 17 references; an entry added to either file without an `inConstruct` is a row missing.
      expect(ROWS.map((row) => row.character).join("")).toBe("\\#)*+-.<=>[_`~|:");
      expect(new Set(ROWS.map((row) => row.character)).size).toBe(ROWS.length);
    });
  });

  describe("named guards", () => {
    it("the backslash before the closing `>` (`see https://x.y\\ end`): the resource form, whose parse holds the one-backslash url", () => {
      assertRoundTrip("see https://x.y\\ end\n", "https://x.y\\", "see [https://x.y\\\\](https://x.y\\\\) end\n");
    });

    it("`\\_` (the hand-escaped underscore in a Wikipedia url): the resource form, the url's single backslash kept", () => {
      assertRoundTrip(
        "see https://en.wikipedia.org/wiki/Foo\\_bar end\n",
        "https://en.wikipedia.org/wiki/Foo\\_bar",
        "see [https://en.wikipedia.org/wiki/Foo\\\\\\_bar](https://en.wikipedia.org/wiki/Foo\\\\_bar) end\n",
      );
    });

    it("the `www.` form: the text and the url differ, so the built-in takes the resource form on its own — the fallback is not involved", () => {
      assertRoundTrip("see www.x.y\\ end\n", "http://www.x.y\\", "see [www.x.y\\\\](http://www.x.y\\\\) end\n");
    });

    it("the plain autolink literal and the plain autolink (the absence cases): the `<…>` form is kept", () => {
      assertRoundTrip("see https://example.com/a_b end\n", "https://example.com/a_b", "see <https://example.com/a_b> end\n");
      assertRoundTrip("<https://example.com/a_b>\n", "https://example.com/a_b", "<https://example.com/a_b>\n");
    });

    it("an email autolink carries its url through the `mailto:` the parser prefixes (format-link-as-autolink.js:27), so `<a@b.c>` is kept", () => {
      assertRoundTrip("see a@b.c end\n", "mailto:a@b.c", "see <a@b.c> end\n");
      assertRoundTrip("<a@b.c>\n", "mailto:a@b.c", "<a@b.c>\n");
    });

    it("a `mailto:` autolink whose url holds a backslash before punctuation falls back like any other", () => {
      assertRoundTrip("<mailto:x\\.y>\n", "mailto:x\\.y", "[mailto:x\\\\.y](mailto:x\\\\.y)\n");
    });
  });

  describe("invariant A on the parser's own trees: the five sources format to themselves", () => {
    const SOURCES = [
      "see [https://x.y\\\\](https://x.y\\\\) end\n",
      "see [https://en.wikipedia.org/wiki/Foo\\\\\\_bar](https://en.wikipedia.org/wiki/Foo\\\\_bar) end\n",
      "see [www.x.y\\\\](http://www.x.y\\\\) end\n",
      "see <https://example.com/a_b> end\n",
      "<https://example.com/a_b>\n",
    ];
    for (const source of SOURCES) {
      it(`${JSON.stringify(source)} formats to itself`, () => {
        expect(format(parse(source))).toBe(source);
      });
    }

    it("the five sources are the canonical forms of the task's five: `see https://x.y\\ end`, the Wikipedia url, `see www.x.y\\ end`, the plain literal, the plain autolink", () => {
      const originals = [
        "see https://x.y\\ end\n",
        "see https://en.wikipedia.org/wiki/Foo\\_bar end\n",
        "see www.x.y\\ end\n",
        "see https://example.com/a_b end\n",
        "<https://example.com/a_b>\n",
      ];
      expect(originals.map((original) => format(parse(original)))).toEqual(SOURCES);
    });
  });

  describe("`formatWithMap` inherits the wrapper", () => {
    it("`formatWithMap(parse(\"see https://x.y\\\\ end\\n\"))` is a fixed point, nothing unresolved, and the backslash's spelling is the two-character escape", () => {
      const source = "see https://x.y\\ end\n";
      const { text, map, spellings } = formatWithMap(parse(source));
      expect(text).toBe("see [https://x.y\\\\](https://x.y\\\\) end\n");
      expect(format(parse(text))).toBe(text);
      expect(map.unresolved).toEqual([]);
      // The link is the paragraph's second child; its text child is `https://x.y\`, whose last
      // character (index 11) is the backslash, written as `\\` at offsets 16–18 of `text`.
      const table = spellings["0.1.0"];
      expect(table).toBeDefined();
      const value = "https://x.y\\";
      const index = value.length - 1;
      expect(value[index]).toBe("\\");
      expect(table.ends[index] - table.starts[index]).toBe(2);
      expect(text.slice(table.starts[index], table.ends[index])).toBe("\\\\");
      // The other eleven characters are spelled as themselves, one byte each.
      for (let i = 0; i < index; i++) {
        expect(text.slice(table.starts[i], table.ends[i]), `character ${i}`).toBe(value[i]);
      }
    });
  });

  describe("installation: the wrapper on the real `State`", () => {
    /** Run `probe` on the `State` of a serialization of `root`, after the app's `root` handler has run. */
    function withState(root: Root, probe: (state: ToMarkdownState, info: Parameters<Handle>[3]) => void): void {
      createFormatter()
        .use(function capture(this: Processor) {
          const data = this.data();
          const extensions: ToMarkdownExtensions = (data.toMarkdownExtensions ??= []);
          extensions.push({
            handlers: {
              paragraph: (_node, _parent, state, info) => {
                probe(state, info);
                return "";
              },
            },
          });
        })
        .stringify(root);
    }

    const paragraph: Root = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: "a" }] }] };
    const autolink = (url: string): Link => ({ type: "link", url, title: null, children: [{ type: "text", value: url }] });

    it("`state.handlers.link` is not the package's handler once `root` has run, and it carries a `peek`", () => {
      let installed: PeekableHandle | undefined;
      let builtin: PeekableHandle | undefined;
      createFormatter()
        .use(function capture(this: Processor) {
          const data = this.data();
          const extensions: ToMarkdownExtensions = (data.toMarkdownExtensions ??= []);
          extensions.push({
            handlers: {
              root: (_node, _parent, state) => {
                builtin = state.handlers.link;
                return "";
              },
            },
          });
        })
        .stringify(paragraph);
      withState(paragraph, (state) => {
        installed = state.handlers.link;
      });
      expect(typeof builtin).toBe("function");
      expect(installed).not.toBe(builtin);
      expect(typeof installed?.peek).toBe("function");
    });

    it("`peek` answers `[` when the fallback will be taken and `<` otherwise (both punctuation, so the previous sibling's escaping is the same)", () => {
      withState(paragraph, (state, info) => {
        const peek = (state.handlers.link as PeekableHandle).peek as Handle;
        expect(peek(autolink("https://x.y\\"), undefined, state, info)).toBe("[");
        expect(peek(autolink("https://example.com/a_b"), undefined, state, info)).toBe("<");
        // `resourceLink` is restored after the fallback call: the option the fallback sets for
        // one call only is `false` again, as `stringifyOptions()` configures it.
        expect(state.handlers.link(autolink("https://x.y\\"), undefined, state, info)).toBe("[https://x.y\\\\](https://x.y\\\\)");
        expect(state.options.resourceLink).toBe(false);
      });
    });

    it("the wrapper is installed once per `State`: a second dispatch of `root` on the same state leaves `state.handlers.link` as it is", () => {
      let same: boolean | undefined;
      withState(paragraph, (state, info) => {
        const installed = state.handlers.link;
        // An empty root, so the second dispatch serializes nothing and re-enters nothing.
        handleRoot({ type: "root", children: [] }, undefined, state, info);
        same = state.handlers.link === installed;
      });
      expect(same).toBe(true);
    });
  });
});
