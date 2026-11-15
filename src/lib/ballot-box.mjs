// ballot-box.mjs — what the office's GET /api/votes says, sorted for the Ballot Box page (POS-1054).
//
// Pure: no fetch, no DOM. The page fetches, hands the parsed reply (or null) to `readVotes`, and renders what comes back. Kept out of
// the page's inline script so every branch can be falsified without a browser.
//
// THE OFFICE'S ANSWER (postmark-office src/votes.mjs voteList, Office main 48452f5d):
//   { topics: [{ topic, status, cap_per_household_per_candidate, window, candidates: [{ candidate, staked }] }],
//     note, awaiting_intake?: [topic], awaiting_intake_note? }
// and a ballot whose stakes the ledger holds but whose post the office has not taken in yet is a 503 REFUSAL naming it in
// `awaiting_intake` (the read refuses rather than show it as nothing staked). Lifecycle: submissions -> staking -> closed.
//
// THE RULES THIS FILE HOLDS (the brief's, and the reasons they exist):
//   · an UNREADABLE reply (no reply, a non-object, no `topics` array) is `unreadable`, never "no open ballots" and never zero;
//   · a ballot whose status is not one of the three is `unrecognised`, shown as such, NEVER filed under past ballots;
//   · only `closed` is past; `submissions` and `staking` are open, and kept apart (a submission has no stakes to back yet);
//   · every candidate the office publishes is kept, in the office's order, zero included; a `staked` that is not a number is
//     `null` (shown as "not readable"), never 0;
//   · `awaiting_intake` topics are INTAKE NOTES: they are not ballots, carry no tally, and are never rendered as zero-backed ones;
//   · the `window` is the office's own prose; it is shown as text and never parsed as a date or clock.

export const STATUS_SUBMISSIONS = "submissions";
export const STATUS_STAKING = "staking";
export const STATUS_CLOSED = "closed";

/** A staked figure as the office gave it: a finite non-negative number, else null (unreadable, never zero). */
export function stakedOf(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;                         // a long enough digit string converts to Infinity: unreadable, never a bar
  }
  return null;
}

/** A topic slug in a reader's words: dashes breathed out, nothing re-cased. Text only. */
export function topicWords(slug) {
  const s = String(slug ?? "");
  return s.replace(/-/g, " ").trim() || s;
}

function readCandidates(list) {
  // a list that is missing, null or not an array is UNREADABLE, which is not the office saying a ballot has no designs (a real [])
  if (!Array.isArray(list)) return { rows: [], malformed: false, unreadable: true };
  const rows = [];
  let malformed = false;
  for (const c of list) {
    if (c == null || typeof c !== "object" || typeof c.candidate !== "string" || c.candidate === "") { malformed = true; continue; }
    rows.push({ candidate: c.candidate, staked: stakedOf(c.staked) });
  }
  return { rows, malformed, unreadable: false };
}

function readTopic(t) {
  if (t == null || typeof t !== "object" || typeof t.topic !== "string" || t.topic === "") return null;
  const { rows, malformed, unreadable } = readCandidates(t.candidates);
  const readable = rows.filter((r) => r.staked != null);
  const max = readable.reduce((m, r) => Math.max(m, r.staked), 0);
  return {
    topic: t.topic,
    words: topicWords(t.topic),
    status: typeof t.status === "string" ? t.status : null,
    window: typeof t.window === "string" && t.window.trim() !== "" ? t.window : null,   // the office's prose; shown, never parsed
    cap: Number.isFinite(Number(t.cap_per_household_per_candidate)) && Number(t.cap_per_household_per_candidate) > 0 ? Number(t.cap_per_household_per_candidate) : null,
    candidates: rows.map((r) => ({ ...r, pct: r.staked != null && max > 0 && r.staked > 0 ? Math.max(1.5, (r.staked / max) * 100) : 0 })),
    candidatesMalformed: malformed,
    candidatesUnreadable: unreadable,
    total: readable.length === rows.length ? rows.reduce((n, r) => n + r.staked, 0) : null,
  };
}

function intakeOf(reply) {
  const list = reply && typeof reply === "object" && Array.isArray(reply.awaiting_intake) ? reply.awaiting_intake : [];
  return list.filter((x) => typeof x === "string" && x !== "").map((topic) => ({ topic, words: topicWords(topic) }));
}

/**
 * Sort the office's reply for the page.
 *
 * `reply` is the parsed JSON body, or null when there was none (a failed or non-OK read, a body that was not JSON). `refusal` is
 * true when the reply came on a non-OK status: its body is then used ONLY for its `awaiting_intake` note, never for a board.
 *
 * Returns { state, open: {submissions, staking}, past, unrecognised, intake, note }:
 *   state "unreadable" — nothing to draw but that the box could not be read (plus any intake note a refusal carried);
 *   state "empty"      — a readable reply with no ballots at all (the only case that says "no ballots");
 *   state "ok"         — at least one ballot, sorted.
 */
export function readVotes(reply, { refusal = false } = {}) {
  const intake = intakeOf(reply);
  const unreadable = { state: "unreadable", submissions: [], staking: [], past: [], unrecognised: [], intake, note: null };
  if (refusal || reply == null || typeof reply !== "object" || Array.isArray(reply) || !Array.isArray(reply.topics)) return unreadable;
  const out = { state: "ok", submissions: [], staking: [], past: [], unrecognised: [], intake, note: typeof reply.note === "string" ? reply.note : null };
  let dropped = 0;
  for (const raw of reply.topics) {
    const t = readTopic(raw);
    if (!t) { dropped += 1; continue; }
    if (t.status === STATUS_SUBMISSIONS) out.submissions.push(t);
    else if (t.status === STATUS_STAKING) out.staking.push(t);
    else if (t.status === STATUS_CLOSED) out.past.push(t);
    else out.unrecognised.push(t);
  }
  out.droppedTopics = dropped;                                  // a topic with no name cannot be drawn; the page says some could not be read
  if (reply.topics.length === 0) out.state = "empty";
  else if (!out.submissions.length && !out.staking.length && !out.past.length && !out.unrecognised.length) out.state = "unreadable";
  return out;
}
