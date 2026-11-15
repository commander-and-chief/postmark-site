// mail-index-words.test.mjs — /mail/'s three counts say what they count, and its
// Resident filter shows names (POS-855, site UX).
//
//   node --test test/mail-index-words.test.mjs
//
// Source-level and synthetic: nothing here reads the residents' data or a built
// page. The numbers are untouched by this change (the same expressions feed them);
// the words around them, and the Resident filter's option labels, are what's pinned.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { residentOptions, metricsFromLedger } from "../src/lib/mail.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const index = src("town", "pages", "mail", "index.astro");
const component = src("src", "components", "MailConversations.astro");
const pagePage = src("town", "pages", "mail", "page", "[page].astro");
const officePage = src("town", "pages", "mail", "office", "[...page].astro");

// ── THE RESIDENT FILTER ─────────────────────────────────────────────────────

const RESIDENTS = [
  { handle: "wren", address: { agent: "Wren" } },
  { handle: "vermillion", address: { agent: "Vermillion" } },
  { handle: "ash", address: { agent: "ash the Younger" } },
  { handle: "quill" },
  { handle: "cobalt", address: { agent: "  " } },
  { handle: "sepia", address: { agent: "sepia" } },
  { handle: "dune", address: { agent: "Zephyr" } },
  { handle: "bay", address: { agent: "zephyr" } },
];

test("an option shows the display name and the handle, and its value stays the handle", () => {
  const byValue = Object.fromEntries(residentOptions(RESIDENTS).map((o) => [o.value, o.label]));
  assert.equal(byValue.vermillion, "Vermillion (vermillion)");
  assert.equal(byValue.ash, "ash the Younger (ash)");
  assert.deepEqual(Object.keys(byValue).sort(), RESIDENTS.map((r) => r.handle).sort(), "a resident is missing, doubled or re-valued");
});

test("a resident with no usable name, or only the handle again, shows the handle alone", () => {
  const byValue = Object.fromEntries(residentOptions(RESIDENTS).map((o) => [o.value, o.label]));
  assert.equal(byValue.quill, "quill");
  assert.equal(byValue.cobalt, "cobalt");
  assert.equal(byValue.sepia, "sepia");
});

test("options sort by the shown label, case-insensitive, the handle breaking a tie", () => {
  const labels = residentOptions(RESIDENTS).map((o) => o.label);
  assert.deepEqual(labels, [
    "ash the Younger (ash)", "cobalt", "quill", "sepia", "Vermillion (vermillion)", "Wren (wren)",
    "zephyr (bay)", "Zephyr (dune)",
  ]);
  // sorted by handle alone, "ash" < "bay" < "cobalt" ...: the labels' order is not the handles' order
  const handles = residentOptions(RESIDENTS).map((o) => o.value);
  assert.notDeepEqual(handles, [...handles].sort());
});

test("the page builds its options from residentOptions, not the bare handles", () => {
  assert.match(index, /residentOptions\(residents\)/);
  assert.match(index, /residentChoices\.map\(\(o\) => <option value=\{o\.value\}>\{o\.label\}<\/option>\)/);
  assert.doesNotMatch(index, /residents\.map\(\(r\) => r\.handle\)\.sort\(\)/, "the raw handle list is back");
  assert.doesNotMatch(index, /<option value=\{h\}>\{h\}<\/option>/, "an option shows the raw handle again");
});

test("the filter's script and query contract are the page's own, unchanged", () => {
  assert.match(index, /const PANEL_FIELDS = \["q", "resident", "region", "since", "until", "thread"\];/);
  assert.match(index, /<select name="resident">/);
});

// ── THE THREE COUNTS ─────────────────────────────────────────────────────────

test("the header count says the office's letter threads are in it", () => {
  // the whole line, so a lost space before the bounces count reads red
  assert.match(
    index,
    /\{metrics\.totals\.deliveries\} deliveries · \{threads\.length\} letter threads, the office's included · \{metrics\.totals\.bounces\} bounces, kept honestly\n/,
  );
  // and it is still every thread, as it was
  assert.match(index, /import threads from "@\/data\/postmark\/threads\.json"/);
});

test("the active-threads stat says it counts letters in the record's last two weeks, from the record", () => {
  assert.match(index, /<b>\{metrics\.active_threads\}<\/b><span>letter threads, the office's included, with a letter in the record's last 14 days<\/span>/);
  assert.doesNotMatch(index, /<span>active threads<\/span>/, "the bare 'active threads' label is back");
  assert.match(index, /the office's included/);
  assert.match(index, /not from today's date/);
});

test("what the active-threads words say is what metricsFromLedger counts (synthetic)", () => {
  const ledger = [{ kind: "delivery", date: "2026-07-31" }];
  const th = (lastDate) => ({ participants: ["a", "b"], lastDate });
  // as-of 07-31; cut = 07-17, inclusive; the office's thread (participants incl. an office) still counts
  const threads = [th("2026-07-17"), th("2026-07-16"), th("2026-07-31"), { participants: ["postmaster", "a"], lastDate: "2026-07-31" }];
  assert.equal(metricsFromLedger(ledger, threads).active_threads, 3);
});

// ── POS-1051: LETTER THREADS, NOT "CONVERSATIONS"; THE SUBJECT; THE NOTE ─────
// Darko, 2026-11-14 23:20 EST: "'conversations' being used for letter threads here is very confusing". Wright, 2026-11-15 06:32Z: "the
// full subject, or cut at a word boundary with an ellipsis, never mid-word. No invented capitals, no guesses from the body."

import { subjectLabel } from "../src/lib/mail.mjs";
import { threadTitle } from "../src/lib/pm.mjs";

test("POS-1051: no postal surface says 'conversations' for letters in what a reader sees", () => {
  const files = {
    index, component, pagePage, officePage,
    thread: src("town", "pages", "mail", "[thread].astro"),
    older: src("town", "pages", "mail", "[thread]", "older", "[part].astro"),
    pair: src("town", "pages", "mail", "with", "[pair].astro"),
    moved: src("town", "pages", "[...moved].astro"),
  };
  for (const [name, text] of Object.entries(files)) {
    // visible words only: drop comments and the component's own file name / import
    const visible = text.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/MailConversations/g, "").replace(/id="conversations"/g, "").replace(/conversationOrder/g, "");
    assert.ok(!/conversation/i.test(visible), `${name}: still says "conversation" in a visible string: ${(/.{30}conversation.{20}/i.exec(visible) ?? [""])[0]}`);
  }
  assert.match(component, /noun = "letter threads"/);
  assert.match(files.thread, /a Postmark letter thread/);
  assert.match(files.older, /aria-label="parts of this letter thread"/);
  assert.match(files.pair, /in this correspondence can write back here/, "the pair page uses its own noun, 'correspondence'");
  assert.match(files.pair, /for a correspondence kept/);
  assert.match(index, /<span>The letter threads<\/span><\/div>/);
  assert.match(index, /id="conversations"/, "the anchor (a deep link) is unchanged");
});

test("POS-1051: the three counts name their populations, and their expressions are untouched", () => {
  assert.match(index, /\{threads\.length\} letter threads, the office's included/, "ALL letter threads, office included");
  assert.match(index, /<b>\{metrics\.active_threads\}<\/b><span>letter threads, the office's included, with a letter in the record's last 14 days<\/span>/, "the 14-day window, office included");
  assert.match(index, /whose newest letter is dated within 14 days of the newest date in the record \(that boundary day counts\)/, "boundary included, from the record");
  assert.match(index, /the office's letter threads \(\{runs\.office\.length\.toLocaleString\("en-US"\)\}\)/, "the office's own count");
  assert.match(index, /<MailConversations threads=\{runs\.town\} page=\{1\} scope="between residents" \/>/, "the resident-only list says 'between residents'");
});

test("POS-1051: the writing-gate note is aligned to the Mail header's column, for this header only", () => {
  assert.match(index, /\.mail-head :global\(\.write-gate-note\) \{ max-width: 62ch; margin-left: auto; margin-right: auto; text-align: center; \}/);
  assert.match(index, /\.mail-head \.how \{ max-width: 62ch; margin: 0 auto;/, "the same 62ch centred column as the paragraph above it");
  const note = src("src", "components", "WriteGateNote.astro");
  assert.match(note, /margin: 0\.7em 0 0; max-width: 46ch;/, "the component's own style, and so its other hosts, are unchanged");
  assert.match(note, /Letters go out from a household: the desk asks you to sign in with GitHub, and a resident\s+has to live at that account\. Agents write through the/, "its text is unchanged");
});

test("POS-1051: a derived subject is shown whole, or cut at a word boundary with an ellipsis, never mid-word, never re-cased", () => {
  const words = "the long and winding road to the harbour where the lanterns are mended every single evening before the second bell";
  const slug = `ada-2031-01-02-${words.replace(/ /g, "-")}`;
  const title = threadTitle(slug);
  assert.equal(title, words, "the title is the slug's own words");
  assert.equal(subjectLabel("lantern repairs"), "lantern repairs", "a short subject is whole");
  assert.equal(subjectLabel(title, title.length), title, "exactly at the bound: whole");
  for (const max of [20, 41, 50, 80, 100]) {
    const out = subjectLabel(title, max);
    assert.ok(out.endsWith("…") && out.length <= max + 1, `max ${max}: cut with an ellipsis (${out})`);
    const kept = out.slice(0, -1);
    assert.ok(title.startsWith(kept) && (title[kept.length] === " "), `max ${max}: the cut falls on a word boundary, not inside a word ("${kept}")`);
    assert.equal(kept, kept.toLowerCase(), "no invented capitals");
    assert.ok(!kept.endsWith(" "), "no dangling space before the ellipsis");
  }
  assert.equal(subjectLabel("x".repeat(120)), "x".repeat(120), "one word longer than the bound is kept whole, never cut inside it");
  assert.equal(subjectLabel(null), "");
  // the card uses it for the visible title and keeps the whole subject on hover; it never reads a letter body for a subject
  assert.match(component, /<span class="t-title" title=\{threadTitle\(t\.key\)\}>\{subjectLabel\(threadTitle\(t\.key\)\)\}<\/span>/);
  assert.doesNotMatch(component, /byId\.get\(t\.key\)\.body[^;]*title|first\.title/);
});

test("the list footer names its scope, and the shared component is told it by every page that uses it", () => {
  assert.match(component, /scope = ""/);
  assert.match(component, /of \{n\(threads\.length\)\}\{scope && ` \$\{scope\}`\}, newest first/);
  assert.match(index, /<MailConversations threads=\{runs\.town\} page=\{1\} scope="between residents" \/>/);
  assert.match(pagePage, /<MailConversations threads=\{town\} page=\{page\} scope="between residents" \/>/);
  assert.match(officePage, /<MailConversations threads=\{office\} page=\{page\} base="\/mail\/office\/" scope="with the office" \/>/);
});
