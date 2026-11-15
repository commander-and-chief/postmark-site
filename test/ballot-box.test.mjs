// ballot-box.test.mjs — the Ballot Box page's reading of the office's GET /api/votes (POS-1054).
//
//   node --test test/ballot-box.test.mjs
//
// Synthetic replies only (invented topics, designs and counts), in the shape postmark-office's voteList gives (Office main 48452f5d,
// src/votes.mjs): { topics: [{ topic, status, cap_per_household_per_candidate, window, candidates: [{ candidate, staked }] }], note,
// awaiting_intake? }. The rendered half is test/ballot-box-browser.test.mjs.
//
// WRIGHT, 2026-11-15 15:01:14Z: "Build exactly the description: the civic quarter's look, the open ballots live from the office's
// read, closed ones under past ballots, no 'coming soon'."

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readVotes, stakedOf, topicWords } from "../src/lib/ballot-box.mjs";

const page = readFileSync(new URL("../town/pages/votes/index.astro", import.meta.url), "utf8");

const cand = (candidate, staked) => ({ candidate, staked });
const ballot = (topic, status, candidates, extra = {}) => ({ topic, status, cap_per_household_per_candidate: 20, window: "staking opens after the submissions close and runs a week", candidates, ...extra });
const HEARTH = ballot("hearth-names", "staking", [cand("Emberlight", 14), cand("Kettle Song", 0), cand("The Long Table", 31), cand("Ash & Ivy", 7)]);
const SUBS = ballot("lantern-colours", "submissions", [cand("Amber", 0), cand("Dusk blue", 0)]);
const PAST = ballot("old-vote", "closed", [cand("Iris", 22), cand("Oriel", 9)]);

test("an open ballot's every design is kept, in the office's order, zero included, with its backing", () => {
  const v = readVotes({ topics: [HEARTH], note: "n" });
  assert.equal(v.state, "ok");
  assert.deepEqual(v.staking[0].candidates.map((c) => [c.candidate, c.staked]), [["Emberlight", 14], ["Kettle Song", 0], ["The Long Table", 31], ["Ash & Ivy", 7]]);
  assert.equal(v.staking[0].candidates[1].pct, 0, "a zero-backed design has an empty bar, but is still listed");
  assert.equal(v.staking[0].candidates[2].pct, 100, "the leader's bar is full, the others in proportion");
  assert.equal(v.staking[0].words, "hearth names", "the topic's slug in a reader's words, no re-casing");
  assert.equal(v.staking[0].total, 52);
});

test("submissions, staking and closed land in their own places; only closed is past", () => {
  const v = readVotes({ topics: [PAST, SUBS, HEARTH] });
  assert.deepEqual(v.staking.map((t) => t.topic), ["hearth-names"]);
  assert.deepEqual(v.submissions.map((t) => t.topic), ["lantern-colours"], "a submission is open but is not staking");
  assert.deepEqual(v.past.map((t) => t.topic), ["old-vote"]);
  assert.deepEqual(v.unrecognised, []);
});

test("an unknown status is shown as unrecognised, never filed as closed (or as open)", () => {
  for (const status of ["archived", "CLOSED", "", null, 7, undefined]) {
    const v = readVotes({ topics: [ballot("odd", status, [cand("A", 1)])] });
    assert.equal(v.past.length, 0, `status ${JSON.stringify(status)} is not past`);
    assert.equal(v.staking.length + v.submissions.length, 0, `nor open`);
    assert.equal(v.unrecognised.length, 1);
  }
});

test("an unreadable reply is unreadable: never 'no ballots', never zero", () => {
  for (const [reply, opts] of [[null, {}], [undefined, {}], ["<html>", {}], [[], {}], [{}, {}], [{ topics: "x" }, {}], [{ topics: null }, {}], [{ topics: [HEARTH] }, { refusal: true }]]) {
    const v = readVotes(reply, opts);
    assert.equal(v.state, "unreadable", JSON.stringify(reply)?.slice(0, 40));
    assert.deepEqual([v.staking, v.submissions, v.past], [[], [], []], "and no board is drawn from a refusal");
  }
  assert.equal(readVotes({ topics: [] }).state, "empty", "only a READABLE empty list says there are none");
  assert.equal(readVotes({ topics: [null, 7, { topic: "" }] }).state, "unreadable", "a list of nothing drawable is not 'none'");
});

test("a staked figure that is not a number is unreadable, never 0", () => {
  assert.equal(stakedOf(12), 12);
  assert.equal(stakedOf("12"), 12);
  assert.equal(stakedOf(0), 0);
  for (const bad of [null, undefined, "", "x", "-3", NaN, Infinity, -1, {}, []]) assert.equal(stakedOf(bad), null, JSON.stringify(bad));
  const v = readVotes({ topics: [ballot("t", "staking", [cand("A", 5), cand("B", "lots"), cand("C", null)])] });
  assert.deepEqual(v.staking[0].candidates.map((c) => c.staked), [5, null, null]);
  assert.equal(v.staking[0].total, null, "no total from a partly unreadable list");
});

test("an intake note is an intake note: not a ballot, not zero-backed; and a 503 refusal carries only its note", () => {
  const v = readVotes({ topics: [HEARTH], awaiting_intake: ["new-ballot"], awaiting_intake_note: "x" });
  assert.deepEqual(v.intake.map((i) => i.topic), ["new-ballot"]);
  assert.ok(!v.staking.concat(v.submissions, v.past).some((t) => t.topic === "new-ballot"), "never shown as a ballot");
  const refused = readVotes({ error: "the office has not taken ballot \"new-ballot\" into its record yet", awaiting_intake: ["new-ballot"] }, { refusal: true });
  assert.equal(refused.state, "unreadable");
  assert.deepEqual(refused.intake.map((i) => i.topic), ["new-ballot"]);
});

test("the window is the office's prose and is never parsed as a clock; hostile strings stay strings", () => {
  const v = readVotes({ topics: [ballot("t", "staking", [cand("<img src=x onerror=alert(1)>", 3)], { window: "closes 2031-02-30 25:61 (or when we say)" })] });
  assert.equal(v.staking[0].window, "closes 2031-02-30 25:61 (or when we say)", "carried verbatim: no date is derived");
  assert.equal(v.staking[0].candidates[0].candidate, "<img src=x onerror=alert(1)>", "a design is text, escaped only at render");
  assert.ok(!("closes" in v.staking[0]) && !("closesAt" in v.staking[0]) && !("winner" in v.staking[0]), "no invented date or winner");
  assert.equal(topicWords("a-b--c"), "a b  c");
});

import { LANES } from "../src/lib/civic.mjs";
import { MAX_SLIDES, callLabel, tutorialFor } from "../src/lib/civic-tutorial.mjs";

test("the Ballot House is a LIVE lane: no 'coming soon', and its '?' deck is built from the doors the office names (stake args from/topic/candidate/stamps, the mail's three lines)", () => {
  const votes = LANES.find((l) => l.key === "votes");
  assert.equal(votes.live, true, "the building and the panel head stop saying 'coming soon'");
  assert.equal(LANES.find((l) => l.key === "listings").live, false, "only the ballot house's chrome changed: the marketplace is still not live");
  assert.equal(votes.id, "ballot-house");
  assert.equal(votes.place, "the-town/the-ballot-house", "its place and anchor are the same");
  const deck = tutorialFor("votes");
  assert.ok(deck.length > 0 && deck.length <= MAX_SLIDES);
  assert.deepEqual(deck.map((s) => s.call), ['town { read: "votes" }', 'household { do: "stake-vote", args: { from: "…", topic: "…", candidate: "…", stamps: 1 } }', "stake_topic: …, stake_candidate: …, stake_stamps: 1"]);
  assert.equal(callLabel(deck[2]), "In the letter, write:", "the mail slide is a letter line, labelled as one");
  const said = deck.map((s) => s.say).join(" ");
  assert.ok(!/\bcap\b|reward|mint|\+1|earn/i.test(said), "no cap or reward promise in the deck");
  for (const s of deck) assert.equal(s.say.split(/(?<=[.!?])\s+/).filter(Boolean).length, 1, `one sentence: ${s.say}`);
  const hub = readFileSync(new URL("../town/pages/town/index.astro", import.meta.url), "utf8");
  assert.match(hub, /<a class="c-door" href="\/votes\/">Open the Ballot Box →<\/a>/, "the Ballot House panel stays the concise door to /votes/");
  assert.ok(!/fetch\([^)]*votes/.test(hub), "and is not a second tally poller");
});

test("the page: no static tallies, no Iris, no coming-soon; the live read, the sorting module and the how-to doors are what it holds", () => {
  const visible = page.replace(/\/\/[^\n]*/g, "");
  assert.ok(!/coming soon/i.test(visible), "no 'coming soon' on the page");
  assert.ok(!/illuminator|iris/i.test(visible.replace(/Iris\b(?=[^"]*")/g, "")), "no Iris-specific board or record link");
  assert.ok(!/RECORDS\s*=/.test(page), "the old per-topic record table is gone");
  assert.match(page, /import \{ readVotes \} from "@\/lib\/ballot-box\.mjs"/);
  assert.match(page, /fetch\(officeBase\(\) \+ "\/votes"/);
  assert.ok(!/innerHTML/.test(page.slice(page.indexOf("<script>"))), "the script builds text nodes, never markup");
  for (const door of ["stake-vote", "POST /api/votes/stake", "stake_topic", "stake_candidate", "stake_stamps", "/mail/compose/?to=postmaster"]) assert.ok(page.includes(door), `the how-to names ${door}`);
  assert.ok(!/every stamp returns when a vote\s+closes. Stakes land on/.test(page) && !/Stakes land on <span/.test(page), "the old claim that all stakes wait for crossings is gone");
  assert.match(page, /Straight away, through the office/);
  assert.match(page, /By mail, at the next crossing/);
  assert.match(page, /import \{ paint, tint, SPRITE_W, SPRITE_H \} from "@\/lib\/civic-art\.mjs"/, "the Ballot House's own art and tint");
});
