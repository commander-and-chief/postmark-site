// past-events-cache.mjs — THE PAST CALENDAR, KEPT BETWEEN BUILDS (CORE-180, was POS-1225).
//
// Darko, 2026-11-24 17:55 EST: "Incremental build. Past events never change. Isn't that just the simple solution here?" The deploy's keyless budget (the office's nginx
// shield) was being spent re-reading the whole past calendar, and the list grows with the town: PAST_PAGES_MAX list pages and EVIDENCE_MAX one-event reads every build.
// So a past event is read once and kept, and each build reads only what is new or still changing.
//
// WHERE IT IS KEPT. Not in the tree: the tracked src/data/postmark/events.json is the empty committed file on every clean checkout (Actions) and on every pass of the
// box's refresh (it force-checks-out and cleans before fetch-town.mjs). It is kept where the build ALREADY publishes it: the site's own last published file,
// `<town base>/data/events.json` (every pass writes it through writeDataFile, public/atelier/postmark/data). That file is the cache, it survives every checkout and
// reset by construction, it is refreshed by every publishing pass, and reading it is one static GET that costs the office's keyless API nothing. It is the site's own
// output, shape-checked here; it is a SEED, never a substitute for the reads below.
//
// WHAT IS NEVER FROZEN. This file decides only what is ASKED; it never edits a row or an evidence entry (what the office served is what is kept and published, as served).
//   - the NEWEST list page is read every build, and the list is followed back until a page whose events the build already holds AND whose ends are older than PAST_SETTLE_MS
//     (the calendar's own seven-day horizon). Newly ended events, and any the seed does not hold, are therefore always read.
//   - an event's evidence is read again whenever the calendar lists the event, it ended inside the settle window, or no good read of it is held (a refused read is
//     retried next build, never frozen as an answer).
//   - an event that ended long ago is NOT assumed immutable (its evidence carries what the office knew about the room, who was there, the sparks and, later, how people are
//     presented): PAST_REFRESH_MAX of the held, settled reads are read again every build, oldest read first (a read stamped `read_at` by this build; an unstamped read from an
//     older file counts as the oldest), a read the office marked `complete: false` first. Every held read is therefore re-asked in turn, and one that is gone from the office
//     is replaced by what the office now serves, not kept for ever.
//   - a one-event read that is refused or fails NEVER replaces a good read held: the held read stands (and is read again next build); with none held it is `unavailable`.
//
// PURE except readEventsSeed's one GET; no clock (the pass's own as_of is passed in), no rule about attendance, rooms, sparks or presentation.

/** How long after an event ends it is still treated as changing: the calendar's own `ended` horizon, seven days. */
export const PAST_SETTLE_MS = 7 * 24 * 60 * 60 * 1000;
/** How many settled, held one-event reads are asked again each build (oldest read first). */
export const PAST_REFRESH_MAX = 8;

const ID = /^[^/]+\/[^/]+$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const endsMs = (e) => { const t = Date.parse(e?.ends); return Number.isFinite(t) ? t : null; };

/** the events.json shape the site reads: `past.events` an array and `evidence` an object */
export const isEventsShape = (v) => isObj(v) && isObj(v.past) && Array.isArray(v.past.events) && isObj(v.evidence);

/** An event the build may ask the one-event read for: its doors have been open (not announced), it is not cancelled, and it has a <host>/<slug> id. */
export const wantsEvidence = (e) => !!e && typeof e.id === "string" && ID.test(e.id) && e.phase !== "announced" && !e.cancelled;

/** Ended long enough ago that nothing about it is still moving, on the pass's own clock. An unknown end or clock is never settled (it is read, not trusted). */
export const isSettled = (e, asOfMs) => { const t = endsMs(e); return t !== null && Number.isFinite(asOfMs) && t + PAST_SETTLE_MS <= asOfMs; };

const heldOk = (held, id) => held?.[id]?.read === "ok" && isObj(held[id].event);

/** True for a list page the build can stop at: it has events, every one of them already held, and every one settled. */
export function settledHeldPage(page, known, asOfMs) {
  return Array.isArray(page) && page.length > 0 && page.every((e) => isObj(e) && typeof e.id === "string" && known.has(e.id) && isSettled(e, asOfMs));
}

/**
 * The last published events file as the build's HELD state. `url` is `<town base>/data/events.json`; an absent file (404) is a first build ("none"); a file that cannot be
 * fetched, parsed or is not the events shape is "unreadable" (the caller then reads in full, as the build always did, and says so). One try: this is a static file, not the
 * office's keyless API, and a refusal here is answered by the full read, never by a stale publication.
 * @returns {Promise<{ state: "unset"|"none"|"ok"|"unreadable", events?: object, reason?: string }>}
 */
export async function readEventsSeed({ url = null, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  if (!url) return { state: "unset" };
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { state: "unreadable", reason: String(error?.message ?? error).slice(0, 160) };
  }
  if (res.status === 404) return { state: "none" };
  if (!res.ok) return { state: "unreadable", reason: `${res.status} ${res.statusText ?? ""}`.trim() };
  let body;
  try { body = await res.json(); } catch (error) { return { state: "unreadable", reason: `not JSON (${String(error?.message ?? error).slice(0, 100)})` }; }
  return isEventsShape(body) ? { state: "ok", events: body } : { state: "unreadable", reason: "it is not an events.json (past.events and evidence)" };
}

/**
 * Two held snapshots as one: the seed's (`primary`, the last published file) over the committed file's (`secondary`, empty on a clean checkout but not on a developer's tree).
 * Events: the primary's in its order, then any only the secondary holds. Evidence: the primary's entry wins an id both hold. The cursor is the primary's.
 */
export function joinHeld(primary, secondary) {
  const p = isObj(primary) ? primary : {}, s = isObj(secondary) ? secondary : {};
  const seen = new Set();
  const events = [...(Array.isArray(p.past?.events) ? p.past.events : []), ...(Array.isArray(s.past?.events) ? s.past.events : [])]
    .filter((e) => isObj(e) && typeof e.id === "string" && ID.test(e.id) && !seen.has(e.id) && seen.add(e.id));
  return {
    past: { events, next: p.past?.next ?? s.past?.next ?? null },
    evidence: { ...(isObj(s.evidence) ? s.evidence : {}), ...(isObj(p.evidence) ? p.evidence : {}) },
  };
}

/**
 * The list for the next events.json. `fresh` is what this build read (newest end first). When the read reached the END of the lasting list (`complete`) it is the whole list and
 * stands alone, exactly as before (an event the office no longer lists leaves). Otherwise (the build stopped at a page it already held, or was capped or refused) the held events
 * OLDER than the oldest read one follow it, in their own order; nothing is dropped for being beyond a page the build did not need to read. A read row wins over a held one.
 */
export function mergePast({ fresh = [], held = [], complete = false } = {}) {
  if (complete) return fresh;
  const have = new Set(fresh.map((e) => e?.id));
  const ends = fresh.map((e) => e?.ends).filter((t) => typeof t === "string");
  const oldest = ends.length ? ends.reduce((a, b) => (b < a ? b : a)) : null;
  return [...fresh, ...held.filter((e) => !have.has(e.id) && (oldest === null || (typeof e.ends === "string" && e.ends <= oldest)))];
}

const readAtOf = (held, id) => (typeof held?.[id]?.read_at === "string" ? held[id].read_at : "");
const incomplete = (held, id) => held?.[id]?.event?.evidence?.complete === false;
const newestEndFirst = (a, b) => String(b.ends).localeCompare(String(a.ends));

/**
 * Which events' one-event reads to ask this build. The candidates are the SAME as ever (the `window` newest ends that wantsEvidence); of those, asked are
 *   NEEDED   the calendar lists it, it has not settled, or no good read of it is held;
 *   ROTATION up to `refreshMax` of the rest (settled, a good read held), a read marked incomplete first, then the oldest `read_at` (none = oldest), newest end, id.
 * @returns {{ work: object[], needed: number, rotated: number, candidates: number }}
 */
export function pickEvidenceWork({ events = [], calendarIds = new Set(), held = {}, asOfMs = NaN, window = Infinity, refreshMax = PAST_REFRESH_MAX } = {}) {
  const candidates = events.filter(wantsEvidence).sort(newestEndFirst).slice(0, window);
  const needed = [], rest = [];
  for (const e of candidates) (!heldOk(held, e.id) || calendarIds.has(e.id) || !isSettled(e, asOfMs) ? needed : rest).push(e);
  rest.sort((a, b) => (incomplete(held, b.id) ? 1 : 0) - (incomplete(held, a.id) ? 1 : 0)
    || readAtOf(held, a.id).localeCompare(readAtOf(held, b.id)) || newestEndFirst(a, b) || a.id.localeCompare(b.id));
  const rotation = rest.slice(0, Math.max(0, refreshMax));
  return { work: [...needed, ...rotation], needed: needed.length, rotated: rotation.length, candidates: candidates.length };
}

/**
 * The evidence map for the next events.json, over the events being published (`events`).
 *   asked, answered ok      the fresh read, stamped `read_at` (this build's as_of), replaces the held one whole
 *   asked, refused/failed   a good read held STANDS (counted `kept`); none held: `{ read: "unavailable" }` (counted `failed`)
 *   not asked this build    a good read held stands; none held: no entry (the page reads that as never asked), as before
 * Only events that still wantsEvidence carry an entry. Nothing held is edited.
 */
export function mergeEvidence({ events = [], held = {}, fresh = {}, readAt = null } = {}) {
  const out = {};
  let refreshed = 0, kept = 0, failed = 0;
  for (const e of events) {
    if (!wantsEvidence(e)) continue;
    const got = fresh[e.id], had = heldOk(held, e.id);
    if (got?.read === "ok") { out[e.id] = { read: "ok", event: got.event, ...(typeof readAt === "string" && readAt ? { read_at: readAt } : {}) }; refreshed++; }
    else if (had) { out[e.id] = held[e.id]; if (got) kept++; }
    else if (got) { out[e.id] = { read: "unavailable" }; failed++; }
  }
  return { evidence: out, refreshed, kept, failed };
}
