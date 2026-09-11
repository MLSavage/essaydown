import { expect, test, type Page } from "@playwright/test";

/**
 * Task 1.17's typing-latency measurement (task 1.10's phase check, DECISIONS #review-1-r0 F5).
 *
 * **The protocol.** A document of agent-written prose is generated in this file (never a personal
 * text: DECISIONS #011), loaded through `/dev/editor`'s "Load fixture…" input, and the caret is
 * put in a paragraph in the middle of it — the source view's caret by carrying the rendered one
 * across with Cmd/Ctrl+/, which is the same place in the same document. Then {@link WARM_UPS}
 * single-character presses are made and discarded, and {@link PRESSES} more are measured. A press
 * is Playwright's `keyboard.press`, so the browser's own trusted keystroke path runs; both ends of
 * every measurement are taken *in the page*, by a `keydown` listener and two `MutationObserver`s,
 * so nothing crosses the CDP boundary inside a sample. Two latencies are recorded per press:
 *
 * - `pane`: keydown → the first mutation of the Markdown pane (`[data-testid="markdown"]`). This
 *   is the whole per-keystroke path — the editing transaction, the conversion to mdast, the store
 *   commit, React's re-render and the serialisation. It is the protocol Claude's r0 measurement
 *   used (rendered p95 15.0 / 13.9 / 14.1 ms at 10 k words, 26.3 ms at 20 k; source 40.6 ms at
 *   10 k), so the numbers below are comparable with those.
 * - `surface`: keydown → the first mutation of the editor's own DOM (`.ProseMirror`, `.cm-content`)
 *   — what the person typing actually sees change.
 *
 * The two are the same event in the rendered view up to React's scheduling, and they are not the
 * same event in the source view any more: since this task the source buffer is committed on the
 * coalescing boundary rather than per keystroke (`bindCodeMirror`), so during a burst the pane
 * does not mutate at all and `pane` has no samples to report. That is the fix, not a gap in the
 * measurement — the CodeMirror buffer is what the user sees, and `surface` measures it. The
 * assertion below therefore reads `pane` for the rendered view and `surface` for the source view:
 * in each case the metric that is on the keystroke path *for that view*.
 *
 * - `commit` (the source view only; task 1.31, DECISIONS #review-1-r1 G9): the deferred commit at
 *   the burst boundary — the timer callback that parses the whole buffer, pushes the snapshot and
 *   has the pane re-rendered — measured from the start of that callback to the first mutation of
 *   the Markdown pane after the burst's last press. The callback's start is taken by a wrapper
 *   the harness puts around `window.setTimeout` (the binding's timer is a plain `setTimeout`, and
 *   the pane's re-render lands in the microtask right after the callback, so the latest timer
 *   callback to start before a pane mutation is the commit that caused it). One sample per burst:
 *   the measured run's own boundary and {@link COMMIT_BURSTS} − 1 more bursts of one press each,
 *   every one waited to its commit. Evidence only — it is printed and attached like the other two
 *   lines and no assertion reads it; its first consumer is Phase 2's autosave.
 *
 * **What is asserted, and what is only reported.** The assertion is a relationship between two
 * document sizes, never a magnitude (CLAUDE.md): p95 at {@link LARGE} words is at most
 * {@link MAX_GROWTH}× p95 at {@link SMALL} words. The document is 10× larger, the rendered
 * keystroke path is still O(document) (`pmToMdast` runs over the whole tree; incremental
 * conversion is a v1.1 backlog line), and the source keystroke path should now be independent of
 * size, so the honest expectation is ≈10 for the rendered view and ≈1 for the source view. The
 * bound is 25 rather than 10 because the p95 at 1 k words is small enough to be dominated by fixed
 * per-event cost and by one outlier in {@link PRESSES} samples, and because these specs run on
 * shared CI runners. What the bound catches is a keystroke path that has become superlinear in
 * document size — a ratio near 100, not a ratio of 12.
 *
 * The absolute p50/p95 are printed and attached as annotations as *evidence for the 1.10.r1
 * reviewers*, who judge the 16 ms criterion of task 1.10's phase check from them. They are one
 * machine's numbers under one protocol (task 1.10 r0: two reviewers measured the same tree at
 * 14 ms and 39 ms p95 under two protocols), and this file is served by Vite's dev build, so no
 * absolute number is ever a pass condition here.
 */

/** Words in the small document, and in the large one. The ratio is what the assertion reads. */
const SMALL = 1_000;
const LARGE = 10_000;

/** Presses discarded before measuring, and presses measured. */
const WARM_UPS = 20;
const PRESSES = 120;

/** The factor of the doc comment: 10× the document, an O(document) path, one runner's noise. */
const MAX_GROWTH = 25;

/** Source-view burst boundaries measured for the `commit` line: the run's own and four more. */
const COMMIT_BURSTS = 5;

/** One measured configuration: which view, and how big the document is. */
type View = "rendered" | "source";

interface Samples {
  readonly pane: number[];
  readonly surface: number[];
  /** Empty for the rendered view, whose per-keystroke commit is what `pane` already measures. */
  readonly commit: number[];
}

/** What the in-page harness records: `performance.now()` at every keydown, mutation and timer. */
interface Record {
  keys: number[];
  pane: number[];
  surface: number[];
  /** When each `setTimeout` callback started; the deferred source commit is one of them. */
  timers: number[];
}

/**
 * A word bank and the sentences it builds: agent-written prose about writing, with no Markdown
 * construct in it, so the document is a plain sequence of paragraphs at every size.
 */
const WORDS = [
  "sentence",
  "paragraph",
  "draft",
  "argument",
  "reader",
  "revision",
  "structure",
  "clarity",
  "evidence",
  "outline",
  "claim",
  "passage",
  "editor",
  "voice",
  "rhythm",
  "essay",
  "notebook",
  "margin",
  "question",
  "answer",
  "carries",
  "holds",
  "turns",
  "reads",
  "leaves",
  "keeps",
  "wants",
  "makes",
  "shows",
  "asks",
  "the",
  "a",
  "one",
  "every",
  "another",
  "quiet",
  "plain",
  "long",
  "short",
  "careful",
];

/** mulberry32, seeded per document, so every machine and every attempt types over the same prose. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `words` words of prose, in paragraphs of five sentences, as Markdown. */
function prose(words: number, seed: number): string {
  const next = random(seed);
  const paragraphs: string[] = [];
  let written = 0;
  while (written < words) {
    const sentences: string[] = [];
    for (let n = 0; n < 5 && written < words; n += 1) {
      const length = 8 + Math.floor(next() * 9);
      const picked: string[] = [];
      for (let w = 0; w < length; w += 1) {
        picked.push(WORDS[Math.floor(next() * WORDS.length)]);
      }
      written += picked.length;
      sentences.push(
        `${picked[0][0].toUpperCase()}${picked[0].slice(1)} ${picked.slice(1).join(" ")}.`,
      );
    }
    paragraphs.push(sentences.join(" "));
  }
  return `${paragraphs.join("\n\n")}\n`;
}

/** Load `source` through the dev bar's "Load fixture…" input, as `editor-clipboard.spec.ts` does. */
async function load(page: Page, name: string, source: string): Promise<void> {
  await page
    .getByTestId("fixture-file")
    .setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(source, "utf8") });
  await expect(page.getByTestId("status")).toHaveText(`Loaded ${name}`);
}

/**
 * Put the caret in a paragraph in the middle of the document, in `view`.
 *
 * The rendered caret is placed by clicking the middle paragraph. The source caret is that same
 * caret carried across by the toggle (task 1.7), which is both the shortest way to reach the
 * middle of a virtualised CodeMirror document and the same place in the same prose.
 */
async function putCaretMidDocument(page: Page, view: View): Promise<void> {
  const paragraphs = page.locator(".ProseMirror > p");
  const count = await paragraphs.count();
  expect(count).toBeGreaterThan(2);
  await paragraphs.nth(Math.floor(count / 2)).click();
  if (view === "rendered") return;
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("mode")).toHaveText("source");
  await page.locator(".cm-content").waitFor();
}

/**
 * Install the in-page harness: one `keydown` listener, two `MutationObserver`s and a wrapper
 * around `window.setTimeout`, all recording `performance.now()` into four arrays. Attribution
 * happens afterwards, in Node — a press's latency is the first mutation recorded between its
 * keydown and the next one — so nothing waits on a timeout per press, and a mutation that arrives
 * after the run (the deferred source commit) belongs to no press: it belongs to the burst, and is
 * the `commit` line's sample (see the header).
 */
async function installHarness(page: Page, view: View): Promise<void> {
  await page.evaluate(
    (selector: string) => {
      const record: { keys: number[]; pane: number[]; surface: number[]; timers: number[] } = {
        keys: [],
        pane: [],
        surface: [],
        timers: [],
      };
      const pane = document.querySelector('[data-testid="markdown"]');
      const surface = document.querySelector(selector);
      if (pane === null || surface === null) throw new Error("no pane or no editing surface");
      document.addEventListener(
        "keydown",
        () => {
          record.keys.push(performance.now());
        },
        true,
      );
      const options = { childList: true, subtree: true, characterData: true };
      new MutationObserver(() => record.pane.push(performance.now())).observe(pane, options);
      new MutationObserver(() => record.surface.push(performance.now())).observe(surface, options);
      // The wrapper returns the native handle, so `clearTimeout` (the binding's cancel on every
      // further keystroke) keeps working; only function handlers are wrapped, which the binding's
      // timer is.
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        typeof handler === "function"
          ? nativeSetTimeout(() => {
              record.timers.push(performance.now());
              handler(...args);
            }, timeout)
          : nativeSetTimeout(handler, timeout)) as typeof window.setTimeout;
      (window as unknown as { __latency: typeof record }).__latency = record;
    },
    view === "rendered" ? ".ProseMirror" : ".cm-content",
  );
}

/** The letters pressed, cycled so the presses are not all the same character. */
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Press `count` single characters, each one after the previous press has reached the editing
 * surface, so every press's mutations fall inside its own window and the whole run stays well
 * inside one coalescing burst.
 */
async function press(page: Page, count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    await page.keyboard.press(LETTERS[n % LETTERS.length]);
    await page.waitForFunction(() => {
      const record = (window as unknown as { __latency: { keys: number[]; surface: number[] } })
        .__latency;
      const last = record.keys[record.keys.length - 1];
      return last !== undefined && record.surface.some((at) => at >= last);
    });
  }
}

/** Whether the pane has mutated since the latest keydown: the deferred source commit has run. */
function settled(page: Page): Promise<unknown> {
  return page.waitForFunction(() => {
    const record = (window as unknown as { __latency: { keys: number[]; pane: number[] } })
      .__latency;
    const last = record.keys[record.keys.length - 1];
    return last !== undefined && record.pane.some((at) => at >= last);
  });
}

/**
 * The source view's burst boundaries (task 1.31; DECISIONS #review-1-r1 G9): wait for the
 * measured run's own deferred commit, then `bursts - 1` more bursts of one press each, every one
 * waited to its commit, so the `commit` line has one sample per burst. These presses come after
 * the measured ones and `collect` stops before them.
 */
async function commitBursts(page: Page, bursts: number): Promise<void> {
  await settled(page);
  for (let n = 1; n < bursts; n += 1) {
    await page.keyboard.press(LETTERS[n % LETTERS.length]);
    await settled(page);
  }
}

/**
 * Attribute every recorded mutation to the press it followed, discarding the warm-ups. Read
 * straight after the presses, before the source view's deferred commit has fired, so that commit
 * is attributed to no press (the source `pane` line reads `n=0` by design; see the header).
 */
async function collect(page: Page): Promise<Omit<Samples, "commit">> {
  const record = await page.evaluate(() => (window as unknown as { __latency: Record }).__latency);
  const first = (times: number[], from: number, until: number): number | null => {
    const at = times.find((time) => time >= from && time < until);
    return at === undefined ? null : at - from;
  };
  const pane: number[] = [];
  const surface: number[] = [];
  for (let index = WARM_UPS; index < record.keys.length; index += 1) {
    const from = record.keys[index];
    const until = record.keys[index + 1] ?? Number.POSITIVE_INFINITY;
    const paneLatency = first(record.pane, from, until);
    const surfaceLatency = first(record.surface, from, until);
    if (paneLatency !== null) pane.push(paneLatency);
    if (surfaceLatency !== null) surface.push(surfaceLatency);
  }
  return { pane, surface };
}

/**
 * The `commit` samples, read after {@link commitBursts}: for each burst boundary from the last
 * measured press on, the first pane mutation after the boundary's press, attributed to the latest
 * timer callback to start before it — the deferred commit — with the distance as the sample.
 */
async function collectCommits(page: Page, measured: number): Promise<number[]> {
  const record = await page.evaluate(() => (window as unknown as { __latency: Record }).__latency);
  const commit: number[] = [];
  for (let index = measured - 1; index < record.keys.length; index += 1) {
    const from = record.keys[index];
    const until = record.keys[index + 1] ?? Number.POSITIVE_INFINITY;
    const mutation = record.pane.find((time) => time >= from && time < until);
    if (mutation === undefined) continue;
    const started = record.timers.filter((time) => time <= mutation).at(-1);
    if (started !== undefined) commit.push(mutation - started);
  }
  return commit;
}

/** The `p`th percentile of `values` (nearest rank), or `null` when there is nothing to report. */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function show(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} ms`;
}

/** One measured configuration, printed and attached, and returned for the ratio assertion. */
async function measure(page: Page, view: View, words: number): Promise<Samples> {
  await page.goto("/dev/editor");
  await page.locator(".ProseMirror").waitFor();
  await load(page, `latency-${words}.md`, prose(words, words));
  await putCaretMidDocument(page, view);
  await installHarness(page, view);
  await press(page, WARM_UPS + PRESSES);
  const measured = await collect(page);
  let commit: number[] = [];
  if (view === "source") {
    await commitBursts(page, COMMIT_BURSTS);
    commit = await collectCommits(page, WARM_UPS + PRESSES);
  }
  const samples: Samples = { ...measured, commit };

  const line = (metric: keyof Samples, of: string): string =>
    `${view} ${words} words ${metric}: p50 ${show(percentile(samples[metric], 50))}, p95 ${show(
      percentile(samples[metric], 95),
    )} (n=${samples[metric].length} ${of})`;
  const lines = [line("pane", `of ${PRESSES}`), line("surface", `of ${PRESSES}`)];
  // The third line is the source view's alone: the burst boundary is where its commit runs.
  if (view === "source") lines.push(line("commit", "bursts"));
  for (const text of lines) {
    // The numbers are this spec's product, for the 1.10.r1 reviewers (see the header).
    console.log(text);
    test.info().annotations.push({ type: "latency", description: text });
  }
  return samples;
}

/** The metric that is on the keystroke path for `view`; see the header. */
function assertedMetric(view: View): keyof Samples {
  return view === "rendered" ? "pane" : "surface";
}

test.describe("typing latency on /dev/editor", () => {
  // Two document loads, 280 presses and a round trip per press: minutes, not seconds.
  test.describe.configure({ timeout: 600_000 });

  for (const view of ["rendered", "source"] as const) {
    test(`${view} view: p95 grows by at most ${MAX_GROWTH}× from ${SMALL} to ${LARGE} words`, async ({
      page,
    }) => {
      const metric = assertedMetric(view);
      const small = await measure(page, view, SMALL);
      const large = await measure(page, view, LARGE);

      const smallP95 = percentile(small[metric], 95);
      const largeP95 = percentile(large[metric], 95);
      expect(smallP95, `no ${metric} sample at ${SMALL} words`).not.toBeNull();
      expect(largeP95, `no ${metric} sample at ${LARGE} words`).not.toBeNull();
      expect(largeP95!).toBeLessThanOrEqual(smallP95! * MAX_GROWTH);
    });
  }
});
