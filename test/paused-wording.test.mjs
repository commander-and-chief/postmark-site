// paused-wording.test.mjs — the Bounty Board and the Marketplace read "paused" wherever this site says their status (POS-1065).
//
//   node --test test/paused-wording.test.mjs
//
// Wright, 2026-11-16 04:32:44Z (a wording order; Darko's "let's treat bounties as paused, just as the marketplace. need to make sure it's
// reflected everywhere including on the site Civic Quarter", 2026-11-15 18:36 EST, is the issue's why): "on the Civic Quarter and wherever
// else the site says it, bounties and the Marketplace read PAUSED (not retired, not coming soon). Wording only; no build to either feature."
// It supersedes POS-1060's "changing soon" chips (the 11-15 18:52 wording). Both still work: existing bounties, stakes, offers and letters
// stand, and no door, permission, price row or payment changes. The funding pots and the bounty class are NOT paused.
//
// WHAT THIS HOLDS, from the site's own source (the rendered cards and headings are test/ballot-panel-browser.test.mjs): (1) the two lanes
// carry the label and the one wording lives in civic.mjs; (2) no site-authored text still says "changing soon", and "coming soon" is only
// ever drawn for a not-live lane that is NOT paused; (3) the opened headings, the bounty deck, the stamps guide and the bulletin's pointer say
// paused without changing a call, a door or a link; (4) nothing about the funding pots, the quest lane or the guide's arithmetic says paused;
// (5) every working door is still there. Generated town and world data, residents' prose and other keepers' source are not read here.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANES, PAUSED_LABEL } from "../src/lib/civic.mjs";
import { tutorialFor, MAX_SLIDES } from "../src/lib/civic-tutorial.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
/** Source without its comments: what the page SAYS, not what its authors explained. */
const said = (src) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out); else if (/\.(astro|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
};

const PAGE = "town/pages/town/index.astro";
const lane = (key) => LANES.find((l) => l.key === key);

test("the two lanes carry the one label, and 'paused' is not a status: live, place and anchors read as they did", () => {
  assert.equal(PAUSED_LABEL, "paused");
  assert.deepEqual(LANES.filter((l) => l.paused).map((l) => l.key), ["bounties", "listings"]);
  assert.equal(lane("bounties").live, true, "the Bounty Board's machinery still stands");
  assert.equal(lane("listings").live, false, "the Marketplace's availability flag is not touched by a wording order");
  assert.equal(lane("bounties").id, "board");
  assert.equal(lane("listings").id, "marketplace");
  assert.ok(!lane("quests").paused && !lane("ideas").paused && !lane("votes").paused, "no other lane is paused");
  assert.doesNotMatch(read("src/lib/civic.mjs").replace(/^\s*\/\/.*$/gm, ""), /retired|coming soon/i, "civic.mjs says neither retired nor coming soon in code");
});

test("no site-authored text says 'changing soon' any more, and 'coming soon' is drawn only for a not-live lane that is not paused", () => {
  const offenders = [];
  for (const f of [...walk("src"), ...walk("town")]) if (/changing soon|changingSoon|CHANGING_SOON|cq-changing/i.test(said(read(f)))) offenders.push(f);
  assert.deepEqual(offenders, [], "the 11-15 wording is gone from the code and markup");
  const page = said(read(PAGE));
  assert.match(page, /\{!lane\.live && !lane\.paused && <span class="cq-coming">coming soon<\/span>\}/);
  assert.match(page, /\{lane\.paused && <span class="cq-paused">\{PAUSED_LABEL\}<\/span>\}/);
  const head = said(read("src/components/LaneHead.astro"));
  assert.match(head, /\{lane\.paused\s*\?\s*<p class="c-coming-head">\{PAUSED_LABEL\}<\/p>\s*:\s*!lane\.live && <p class="c-coming-head">Coming soon<\/p>\}/, "the opened heading: paused for a paused lane, coming soon only for another not-live one");
  // every lane that the page would draw coming-soon for: none is one of the two
  assert.deepEqual(LANES.filter((l) => !l.live && !l.paused).map((l) => l.key), [], "no lane reads coming soon today");
});

test("the opened Bounty Board and Marketplace panels are not disabled: the board's block, the price board link and the postmaster door are all still there", () => {
  const page = said(read(PAGE));
  const bounty = page.slice(page.indexOf('id="bounty-board"'), page.indexOf('id="marketplace"'));
  assert.match(bounty, /<div id="board" class="m-block">/, "the board's block, whose id every deep link points at");
  assert.match(bounty, /<LaneTutorial lane=\{LANE_BY\.bounties\}/, "and its '?' deck");
  const market = page.slice(page.indexOf('id="marketplace"'), page.indexOf('id="ballot-house"'));
  assert.match(market, /href="\/bulletin\/#marketplace">the price board/, "the price board link");
  assert.match(market, /\{!LANE_BY\.listings\.live && \(\s*<p class="m-note">\s*<a class="c-door" href="\/mail\/compose\/\?to=postmaster">Write the postmaster →<\/a>/, "the postmaster door, still gated on the same flag");
  assert.doesNotMatch(bounty + market, /\bdisabled\b|aria-disabled|pointer-events/, "nothing in either panel is disabled");
});

test("the bounty deck says paused on its first step and teaches nothing else differently: the same four steps, calls and one-sentence slides", () => {
  const deck = tutorialFor("bounties");
  assert.equal(deck.length, 4);
  assert.ok(deck.length <= MAX_SLIDES);
  assert.deepEqual(deck.map((s) => s.step), ["Post the ask", "Stake it", "Someone answers", "The poster pays"]);
  assert.deepEqual(deck.map((s) => s.call), [
    'world { do: "leave-mark", args: { class: "bounty", … } }',
    'town { do: "stake", args: { mark: "<by>/<slug>", stamps: 1 } }',
    'household { read: "mail" }',
    "pays: 12",
  ], "every call is the one it was");
  assert.equal(deck[0].step_note, "at the world door · the Bounty Board is paused");
  assert.equal(deck.filter((s) => /paused/i.test(`${s.step} ${s.step_note ?? ""} ${s.say}`)).length, 1, "said once, on the first step");
  for (const s of deck) assert.equal(s.say.split(/(?<=[.!?])\s+/).filter(Boolean).length, 1, `${s.step} stays one sentence`);
  assert.deepEqual(tutorialFor("listings"), [], "the Marketplace has no deck, as before");
});

test("the guide's 'Posting a notice of your own' says the board is paused, that what stands stands, and that a funding pot is not paused; its arithmetic is untouched", () => {
  const guide = read("town/pages/docs/stamps/index.astro");
  const section = said(guide.slice(guide.indexOf("<h3>Posting a notice of your own</h3>"), guide.indexOf("<h3>Posting a notice of your own</h3>") + 1500));
  const flat = section.replace(/\s+/g, " ");
  assert.match(flat, /<a href="\/town\/#board">the board<\/a>, which is <b>paused<\/b> for now/);
  assert.match(flat, /the notices already up, their stakes and the letters that settle them stand, and the board still works/);
  assert.match(flat, /A funding pot is a different thing and is not paused/);
  assert.match(flat, /<code>class: bounty<\/code>, one ask, a reward in stamps, escrow behind it so it publishes/, "how a notice is placed is as it was");
  // the guide's other mentions of a bounty or a pot (what a stake does, the glossary, the sigma wage) say nothing about a pause
  const rest = said(guide.replace(section, ""));
  assert.doesNotMatch(rest, /paused/i, "the only pause in the guide is the board's, in that one paragraph");
});

test("the bulletin's civic pointer qualifies the two paused lanes in four words and is otherwise the same sentence", () => {
  const bulletin = said(read("town/pages/bulletin/index.astro"));
  assert.match(bulletin, /The town's asks and its residents': quests, ideas, bounties \(paused\), listings \(paused\) and votes\./);
});

test("nothing about funding, the quest lane or a pot says paused: the pots are not the board", () => {
  assert.doesNotMatch(said(read("src/lib/funding.mjs")), /paused/i);
  assert.doesNotMatch(said(read("town/pages/fund/[pot].astro")), /paused/i);
  const page = said(read(PAGE));
  const quests = page.slice(page.indexOf('id="quests"'), page.indexOf('id="ideas"'));
  assert.ok(quests.includes('id="pots"') || /pots/i.test(quests), "the quest panel still carries the funding pots");
  assert.doesNotMatch(quests, /paused/i, "the funding pots, in the quest panel, are not paused");
  assert.doesNotMatch(said(read("src/lib/civic-tutorial.mjs")).replace(/step_note: "at the world door · the Bounty Board is paused"/, ""), /paused/i, "no other deck says paused");
});

test("the wording order's own limits: no flag was added beyond the label, and no CSS dims or blocks the chip or its building", () => {
  const css = read(PAGE).slice(read(PAGE).indexOf(".cq-paused {"), read(PAGE).indexOf(".cq-paused {") + 400);
  assert.doesNotMatch(css, /pointer-events|opacity|filter|display:\s*none/);
  assert.deepEqual(Object.keys(lane("listings")).sort(), ["id", "key", "lane", "live", "name", "paused", "place", "who"], "the Marketplace row gained only `paused`");
  assert.deepEqual(Object.keys(lane("bounties")).sort(), ["id", "key", "lane", "live", "name", "paused", "place", "who"], "and so did the Bounty Board's");
});
