# MARKDOWN-STYLE.md — Essay Down's canonical Markdown

Essay Down owns the bytes of every file it saves. `packages/core/src/format.ts` configures
`remark-stringify` so that `format(parse(x))` produces exactly the shapes below, and
`packages/core/src/parse.ts` configures `remark-parse` with the extension set of PRD §4.
This document is the specification and, because `packages/core/test/markdown-style.test.ts`
extracts the twelve examples from it and asserts on them, it is also the test data. Editing an
example here changes the test.

## The rules

1. **Headings are ATX.** `#` through `######`, one space after the hashes, never setext
   (`===` / `---` underlines).
2. **Bullets are `-`.** Never `*`, never `+`. Nested bullets indent by two spaces per level.
3. **Ordered lists use `1.`** and the numbers increment: `1.`, `2.`, `3.`.
4. **Code blocks are fenced with ```` ``` ````** and the info string is preserved verbatim.
   Indented code becomes a fence with an empty info string.
5. **Tables are pipe tables with aligned columns.** Every row is padded to the widest cell in
   its column, the delimiter row carries the alignment (`:-`, `-:`, `:-:`), and leading and
   trailing pipes are always written.
6. **Exactly one blank line between blocks.** Never zero, never two.
7. **`*emphasis*` and `**strong**`** — asterisks, never underscores.
8. **Links are inline**: `[text](destination)` with the destination unpadded, or an autolink
   `<https://example.org>` when the text is the destination. Titles are double-quoted.
9. **Images are inline with a relative path**: `![alt](relative/path)`.
10. **No hard wrap.** A paragraph written on one line stays on one line, however long it is;
    the formatter never introduces a line break inside a paragraph.
11. **Exactly one trailing newline** at the end of the file.

## Further rules, not among the twelve examples

- **Thematic breaks are `---`** on their own line, no spaces (`***`, `___` and `- - -` all
  normalise to it).
- **Blockquotes** are `> ` on every line of the quoted block.
- **Strikethrough** is `~~text~~`; **inline code** is `` `text` ``.
- **Footnotes and task lists are not enabled** (PRD §4). `[^1]` and `- [ ]` reach the tree as
  plain `text` and may be re-escaped by the formatter; that is accepted (PRD §6.1, invariant B).
- **`html` blocks and `yaml` front matter are opaque** (PRD §6.1). Their bytes are emitted
  exactly as the parser captured them, so comments, quoting style, block scalars, duplicate keys
  and malformed YAML all survive a round trip untouched. Only the two app-owned front-matter
  keys `title` and `question` are ever rewritten, and only by an in-app edit.

## The twelve examples

Each example is one `format(parse(input))` assertion. The input block is fed to `parse`, the
output block is the exact bytes `format` must return. Both blocks are fenced with four tildes so
that examples may contain fences of their own; the content of a block always ends with exactly
one newline.

### Example 1 — headings are ATX

Input:

~~~~markdown
Title
=====

Subheading
----------

Body text.
~~~~

Output:

~~~~markdown
# Title

## Subheading

Body text.
~~~~

### Example 2 — bullets are `-`

Input:

~~~~markdown
* first
* second
* third
~~~~

Output:

~~~~markdown
- first
- second
- third
~~~~

### Example 3 — nested bullets indent by two spaces

Input:

~~~~markdown
- one
    - two
        - three
~~~~

Output:

~~~~markdown
- one
  - two
    - three
~~~~

### Example 4 — ordered lists increment

Input:

~~~~markdown
1. first
1. second
1. third
~~~~

Output:

~~~~markdown
1. first
2. second
3. third
~~~~

### Example 5 — fenced code, info string preserved

Input:

~~~~markdown
~~~python
print("hello")
~~~
~~~~

Output:

~~~~markdown
```python
print("hello")
```
~~~~

### Example 6 — indented code becomes a fence

Input:

~~~~markdown
    const answer = 42;
~~~~

Output:

~~~~markdown
```
const answer = 42;
```
~~~~

### Example 7 — tables have aligned columns

Input:

~~~~markdown
|Section|Words|
|:--|--:|
|Opening|412|
|The turn|1180|
~~~~

Output:

~~~~markdown
| Section  | Words |
| :------- | ----: |
| Opening  |   412 |
| The turn |  1180 |
~~~~

### Example 8 — exactly one blank line between blocks

Input:

~~~~markdown
First paragraph.



Second paragraph.
~~~~

Output:

~~~~markdown
First paragraph.

Second paragraph.
~~~~

### Example 9 — `*emphasis*` and `**strong**`

Input:

~~~~markdown
An _emphatic_ and __forceful__ and ___both___ sentence.
~~~~

Output:

~~~~markdown
An *emphatic* and **forceful** and ***both*** sentence.
~~~~

### Example 10 — links are inline

Input:

~~~~markdown
See [the PRD]( docs/PRD.md 'the spec' ) and <https://example.org>.
~~~~

Output:

~~~~markdown
See [the PRD](docs/PRD.md "the spec") and <https://example.org>.
~~~~

### Example 11 — images are inline with a relative path

Input:

~~~~markdown
![A fountain pen](assets/essay/pen.png 'nib detail')
~~~~

Output:

~~~~markdown
![A fountain pen](assets/essay/pen.png "nib detail")
~~~~

### Example 12 — no hard wrap, exactly one trailing newline

Input:

~~~~markdown
A paragraph long enough that a wrapping formatter would break it, kept on a single line because the canonical style never introduces a line break inside a paragraph, and followed by two spare blank lines that the formatter drops.


~~~~

Output:

~~~~markdown
A paragraph long enough that a wrapping formatter would break it, kept on a single line because the canonical style never introduces a line break inside a paragraph, and followed by two spare blank lines that the formatter drops.
~~~~
