// past-events-incremental.test.mjs — CORE-180 (was POS-1225): the deploy's keyless budget is not spent re-reading the whole past calendar. A past event is read once and kept in the
// site's own last PUBLISHED events.json; each build reads the newest list page and only the one-event reads that are new, changing or due.
//
//   node --test test/past-events-incremental.test.mjs
//
// PURE. It runs tools/lib/past-events-cache.mjs and the real ingest (tools/lib/fetch-town-data.mjs fetchEvents) against a stub office, counting the requests it is asked, with INVENTED
// events and a fixed clock (the pass's own as_of); the live office and the live site are never read. The page, the projection and the release guard are not touched here.
//
// FALSIFIERS: a warm build that reads as much as a cold one; a newly ended or still-changing event frozen at an old read; a refused read erasing a good one held; a seed that is
// corrupt or unreachable standing in for a read; a held event dropped for being beyond the page the build stopped at; the held rows or evidence edited; a list failure that no
// longer fails the build.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { EMPTY_CALENDAR, EMPTY_EVENTS, EVIDENCE_MAX, PAST_PAGES_MAX, fetchEvents, shortFetchPlan } from "../tools/lib/fetch-town-data.mjs";
import { PAST_REFRESH_MAX, PAST_SETTLE_MS, isSettled, joinHeld, mergeEvidence, mergePast, pickEvidenceWork, readEventsSeed, settledHeldPage } from "../tools/lib/past-events-cache.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OFFICE = "https://office.invalid";
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, statusText: String(status), headers: { get: () => null }, json: async () => body });
const DAY = 86_400_000;
const NOW = "2026-11-24T23:00:00.000Z";
const iso = (daysAgo) => new Date(Date.parse(NOW) - daysAgo * DAY).toISOString();
const ev = (n, daysAgo, extra = {}) => ({ id: `h/e${n}`, title: `e${n}`, host: "h", phase: "ended", ends: iso(daysAgo), ...extra });
const evidenceOf = (n, over = {}) => ({ id: `h/e${n}`, evidence: { rooms: [{ id: `r${n}` }], room_history: "complete", present: [`p${n}`], gallery: { rooms: [], sparks: [] }, complete: true, ...over } });

// the office's lasting list: newest first, 4 a page, a cursor per page
const PAGE = 4;
const listOf = (events) => {
  const pages = [];
  for (let i = 0; i * PAGE < events.length; i++) {
    const rows = events.slice(i * PAGE, (i + 1) * PAGE), last = (i + 1) * PAGE >= events.length;
    pages.push({ before: i ? events[i * PAGE - 1].ends : undefined, body: { as_of: NOW, past: rows, next: last ? null : { past: true, before: rows.at(-1).ends }, note: null } });
  }
  return pages;
};
/** a stub office that counts what it is asked: `refuse` ids answer 503, `listStatus` makes every list read answer that status */
const office = ({ events, reads = {}, refuse = new Set(), asked = [], listStatus = 200 }) => {
  const pages = listOf(events);
  return async (url) => {
    const u = new URL(url);
    asked.push(u.pathname + u.search);
    if (u.pathname === "/town/apex" && u.searchParams.get("read") === "calendar") {
      if (listStatus !== 200) return json(listStatus, { error: "x" });
      const args = JSON.parse(u.searchParams.get("args"));
      const page = pages.find((p) => p.before === (args.before ?? undefined));
      return page ? json(200, page.body) : json(422, { error: "bounce" });
    }
    const m = /^\/calendar\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const id = `${m[1]}/${m[2]}`;
      if (refuse.has(id)) return json(503, { error: "down" });
      return reads[id] ? json(200, { event: reads[id] }) : json(404, { error: "bounce", code: 404 });
    }
    return json(404, { error: "bounce", code: 404 });
  };
};
const lists = (asked) => asked.filter((a) => a.startsWith("/town/apex")).length;
const oneReads = (asked) => asked.filter((a) => a.startsWith("/calendar/")).map((a) => a.slice("/calendar/".length));

// the town: two events inside the last week (e0, e1) and ten older (e2..e11), none changing
const TOWN = [ev(0, 0.2), ev(1, 3), ...[...Array(10).keys()].map((i) => ev(i + 2, 10 + i * 4))];
const READS = Object.fromEntries(TOWN.map((e, i) => [e.id, evidenceOf(i)]));
const run = (o) => fetchEvents({ apiBase: OFFICE, retries: 1, calendar: EMPTY_CALENDAR, ...o });

test("COLD: with no seed the build reads the whole list and every event once, exactly as it always did", async () => {
  const asked = [];
  const r = await run({ fetchImpl: office({ events: TOWN, reads: READS, asked }) });
  assert.equal(lists(asked), 3, "12 events over 3 pages: every page");
  assert.equal(oneReads(asked).length, 12, "and one read per event");
  assert.deepEqual(r.events.past.events.map((e) => e.id), TOWN.map((e) => e.id));
  assert.equal(r.events.past.next, null);
  assert.equal(Object.keys(r.events.evidence).length, 12);
  assert.ok(Object.values(r.events.evidence).every((v) => v.read === "ok" && v.read_at === undefined), "the old path stamps nothing");
  assert.deepEqual(r.gaps, [], "and says nothing about a cache it did not use");
});

test("WARM (seeded): the list stops at the first page it already holds and that settled; only the unsettled and the oldest-read are asked; the file is the same file", async () => {
  const cold = await run({ fetchImpl: office({ events: TOWN, reads: READS }) });
  const asked = [];
  const warm = await run({ seed: cold.events, refreshMax: 2, fetchImpl: office({ events: TOWN, reads: READS, asked }) });
  assert.equal(lists(asked), 2, "page 1 holds e0 and e1, which have not settled, so page 2 is read; page 2 is all held and settled: stop (page 3 never asked)");
  assert.deepEqual(oneReads(asked).sort(), ["h/e0", "h/e1", "h/e2", "h/e3"], "the two unsettled events plus two held reads read again, not 12");
  assert.deepEqual(warm.events.past.events, cold.events.past.events, "the events are the same rows in the same order, the older ones kept as held");
  assert.equal(warm.events.past.next, null, "the held list's own cursor stands");
  for (const e of TOWN) assert.equal(warm.events.evidence[e.id].read, "ok", `${e.id} still has its evidence`);
  assert.deepEqual(warm.events.evidence["h/e11"], cold.events.evidence["h/e11"], "a read not asked stands exactly as it was held (not edited, not restamped)");
  assert.match(warm.gaps[0], /built from the last published file \(12 past events held\).*2 page\(s\), stopping at the first page.*4 one-event read\(s\) asked \(2 new, changing or not yet held, 2 held reads read again/);
});

test("WARM when nothing recent moved: the newest page alone, and only the rotation", async () => {
  const old = TOWN.slice(2);                                   // ten events that all ended more than a week ago
  const cold = await run({ fetchImpl: office({ events: old, reads: READS }) });
  const asked = [];
  const warm = await run({ seed: cold.events, fetchImpl: office({ events: old, reads: READS, asked }) });
  assert.equal(lists(asked), 1, "the newest page is all held and settled");
  assert.equal(oneReads(asked).length, PAST_REFRESH_MAX, "only the rotation is asked");
  assert.equal(warm.events.past.events.length, 10);
});

test("NEWLY ENDED and STILL CHANGING are read again and never frozen: an event that ended since the seed, one the calendar lists, one held while it was under way", async () => {
  const underway = { ...ev(20, 0.1), phase: "underway" };
  const seedEvents = { as_of: iso(1), past: { events: TOWN.slice(2), next: null, note: null, read: "office" },
    evidence: Object.fromEntries(TOWN.slice(2).map((e, i) => [e.id, { read: "ok", event: evidenceOf(i + 2) }])) };
  seedEvents.evidence["h/e5"] = { read: "ok", event: evidenceOf(5, { complete: false }) };      // held while its window was open; long ended now
  const grown = [ev(30, 0.05), ...TOWN.slice(2)];                                              // e30 ended since the seed was published
  const reads = { ...READS, "h/e30": evidenceOf(30), "h/e20": evidenceOf(20, { complete: false }), "h/e5": evidenceOf(5, { complete: true }) };
  const asked = [];
  const r = await run({ seed: seedEvents, refreshMax: 1, calendar: { as_of: NOW, now: [underway], coming: [], ended: [], total: 1 }, fetchImpl: office({ events: grown, reads, asked }) });
  const read = oneReads(asked);
  assert.ok(read.includes("h/e30"), "the newly ended event is read");
  assert.ok(read.includes("h/e20"), "the event the calendar lists (under way) is read");
  assert.ok(read.includes("h/e5"), "the settled event held as `complete: false` is first in the rotation");
  assert.equal(r.events.evidence["h/e5"].event.evidence.complete, true, "and what the office now says replaces the held read whole");
  assert.equal(r.events.evidence["h/e5"].read_at, NOW, "stamped with the pass's own time");
  assert.equal(read.length, 3, "nothing else");
  assert.equal(r.events.past.events[0].id, "h/e30", "the newest event leads the list");
});

test("ROTATION: every held read is asked again in turn, oldest read first, and an unstamped read counts as the oldest", async () => {
  const old = TOWN.slice(2);                                    // 10 settled events
  let seed = (await run({ fetchImpl: office({ events: old, reads: READS }) })).events;
  for (const id of Object.keys(seed.evidence)) delete seed.evidence[id].read_at;   // an older file that never stamped
  const everAsked = new Set(), batches = [];
  for (let build = 0; build < 5; build++) {                     // refreshMax 2: ten reads in five builds
    const asked = [];
    const stamp = new Date(Date.parse(NOW) + build * 1800_000).toISOString();
    const feed = office({ events: old, reads: READS, asked });
    const stub = async (url) => { const res = await feed(url); return url.includes("/town/apex") ? json(200, { ...(await res.json()), as_of: stamp }) : res; };
    const next = await run({ seed, refreshMax: 2, fetchImpl: stub });
    const batch = oneReads(asked);
    batches.push(batch);
    batch.forEach((id) => everAsked.add(id));
    seed = next.events;
  }
  assert.equal(everAsked.size, 10, `every held read was asked again within five builds: ${JSON.stringify(batches)}`);
  assert.equal(new Set(batches.flat()).size, 10, "and none twice before all were read once: the oldest read goes first");
});

test("a REFUSED or failed one-event read never replaces a good read held; with none held it is unavailable; both are said", async () => {
  const seed = (await run({ fetchImpl: office({ events: TOWN, reads: READS }) })).events;
  const grown = [ev(30, 0.05), ...TOWN];
  const asked = [];
  const r = await run({ seed, refreshMax: 0, fetchImpl: office({ events: grown, reads: { ...READS, "h/e30": evidenceOf(30) }, refuse: new Set(["h/e0", "h/e30"]), asked }) });
  assert.deepEqual(r.events.evidence["h/e0"], seed.evidence["h/e0"], "e0's good read stands exactly as held (asked, refused)");
  assert.deepEqual(r.events.evidence["h/e30"], { read: "unavailable" }, "e30 has none held: unavailable, never an empty answer");
  assert.ok(r.gaps.some((g) => /1 of 3 one-event reads were not served, so those events' pages say/.test(g)), JSON.stringify(r.gaps));
  assert.ok(r.gaps.some((g) => /1 one-event reads were not served and those events keep the good read the last build held/.test(g)));
  // and next build the refused ones are asked again, not frozen
  const again = [];
  const r2 = await run({ seed: r.events, refreshMax: 0, fetchImpl: office({ events: grown, reads: { ...READS, "h/e30": evidenceOf(30) }, asked: again }) });
  assert.ok(oneReads(again).includes("h/e30"), "the unavailable read is retried");
  assert.equal(r2.events.evidence["h/e30"].read, "ok");
});

test("PROJECTION: held rows and held evidence pass through byte-identical; a read adds only the pass's own read_at", async () => {
  const seed = (await run({ fetchImpl: office({ events: TOWN, reads: READS }) })).events;
  const before = JSON.stringify(seed);
  const r = await run({ seed, refreshMax: 0, fetchImpl: office({ events: TOWN, reads: READS }) });
  assert.equal(JSON.stringify(seed), before, "the seed object is not mutated");
  for (const e of TOWN.slice(2)) {
    assert.deepEqual(r.events.past.events.find((x) => x.id === e.id), e, `${e.id}: the row as served`);
    assert.deepEqual(r.events.evidence[e.id], seed.evidence[e.id], `${e.id}: the evidence as held`);
  }
  const fresh = r.events.evidence["h/e0"];
  assert.deepEqual(Object.keys(fresh).sort(), ["event", "read", "read_at"]);
  assert.deepEqual(fresh.event, READS["h/e0"], "the office's answer, whole and unedited");
  assert.deepEqual(Object.keys(r.events).sort(), ["as_of", "evidence", "past"], "events.json keeps its three keys");
});

test("RESTORED after a fresh checkout: the tracked events.json is the EMPTY committed one and the seed comes from the published file over HTTP", async () => {
  const published = (await run({ fetchImpl: office({ events: TOWN, reads: READS }) })).events;
  const urls = [];
  const web = async (url) => { urls.push(String(url)); return json(200, published); };
  const seed = await readEventsSeed({ url: "https://postmark.invalid/data/events.json", fetchImpl: web });
  assert.equal(seed.state, "ok");
  assert.deepEqual(urls, ["https://postmark.invalid/data/events.json"], "one static GET");
  const asked = [];
  const r = await run({ snapshot: EMPTY_EVENTS, seed: seed.events, refreshMax: 0, fetchImpl: office({ events: TOWN, reads: READS, asked }) });
  assert.equal(lists(asked), 2);
  assert.equal(r.events.past.events.length, 12, "all twelve events, from a tree that held none");
  assert.equal(oneReads(asked).length, 2, "and two one-event reads");
});

test("a seed that is absent, refused, corrupt or the wrong shape is never a read: the build falls back to the whole list", async () => {
  const states = [];
  for (const [name, fetchImpl] of [
    ["404", async () => json(404, {})], ["500", async () => json(500, {})], ["throw", async () => { throw new Error("socket hang up"); }],
    ["not json", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } })],
    ["wrong shape", async () => json(200, { hello: "world" })], ["no evidence", async () => json(200, { past: { events: [] } })],
    ["array", async () => json(200, [])],
  ]) states.push([name, (await readEventsSeed({ url: "https://x.invalid/data/events.json", fetchImpl })).state]);
  assert.deepEqual(states, [["404", "none"], ["500", "unreadable"], ["throw", "unreadable"], ["not json", "unreadable"], ["wrong shape", "unreadable"], ["no evidence", "unreadable"], ["array", "unreadable"]]);
  assert.equal((await readEventsSeed({ url: null })).state, "unset");
  // with no usable seed fetchEvents is the cold path: every page, every read
  const asked = [];
  await run({ seed: null, fetchImpl: office({ events: TOWN, reads: READS, asked }) });
  assert.equal(lists(asked), 3);
  assert.equal(oneReads(asked).length, 12);
});

test("the list's failures keep their meaning: a refused page fails the build (the release lane then refuses to publish); a list the office does not serve keeps the held events", async () => {
  const seed = (await run({ fetchImpl: office({ events: TOWN, reads: READS }) })).events;
  // a 429 / 5xx on the newest page throws, exactly as before (it is not an answer, and a seed does not stand in for it)
  for (const status of [429, 500, 503]) {
    await assert.rejects(run({ seed, fetchImpl: office({ events: TOWN, reads: READS, listStatus: status }) }), /failed after|refused|429|500|503/, `list ${status}`);
  }
  // 422 (the office does not know `past`): `unavailable`, and the held events stand, said
  const r = await run({ seed, fetchImpl: office({ events: TOWN, reads: READS, listStatus: 422 }) });
  assert.equal(r.events.past.read, "unavailable");
  assert.deepEqual(r.events.past.events.map((e) => e.id), TOWN.map((e) => e.id), "the held events are kept, not dropped");
  assert.equal(r.events.past.next, null);
  assert.ok(r.gaps.some((g) => /lasting list of past events is not served yet/.test(g)));
  // the release channel still refuses a short fetch
  assert.equal(shortFetchPlan({ channel: "release" }).exitCode, 1);
  assert.equal(shortFetchPlan({ channel: "snapshot" }).exitCode, 0);
});

test("the held events older than the page the build stopped at are KEPT; a complete read stands alone; a capped one keeps the held tail and the cursor", async () => {
  const seedOf = (events, next = null) => ({ as_of: NOW, past: { events, next, note: null, read: "office" }, evidence: {} });
  // stopped: kept in order, and the seed's own cursor stands
  const cursor = { past: true, before: iso(200) };
  const held = TOWN.slice(2);
  const r = await run({ seed: seedOf(held, cursor), fetchImpl: office({ events: held, reads: READS }) });
  assert.deepEqual(r.events.past.events.map((e) => e.id), held.map((e) => e.id));
  assert.deepEqual(r.events.past.next, cursor, "completeness stays honest: the office had more beyond the held list, and the file still says so");
  // complete: an event the office no longer lists is not kept when the whole list was read (the old behaviour)
  const gone = [...held];
  const whole = await run({ seed: seedOf([ev(99, 400), ...held]), maxPages: 99, fetchImpl: office({ events: gone.slice(0, 3), reads: READS }) });
  assert.equal(whole.events.past.events.length, 3);
  // pure: mergePast
  assert.deepEqual(mergePast({ fresh: [ev(1, 1)], held: [ev(1, 1, { title: "old" }), ev(2, 9), ev(3, 0.5)], complete: false }).map((e) => e.id), ["h/e1", "h/e2"], "a held event NEWER than the oldest read one is not resurrected beside it; older ones follow");
  assert.equal(mergePast({ fresh: [], held: [ev(2, 9)], complete: false }).length, 1);
  assert.deepEqual(mergePast({ fresh: [ev(1, 1)], held: [ev(2, 9)], complete: true }).map((e) => e.id), ["h/e1"]);
});

test("the pure pieces: settling, the stop page, the join, the work list, the merge", () => {
  const asOf = Date.parse(NOW);
  assert.equal(isSettled(ev(1, 7.01), asOf), true);
  assert.equal(isSettled(ev(1, 6.9), asOf), false);
  assert.equal(isSettled({ id: "h/x", ends: "not a date" }, asOf), false, "an unknown end is read, not trusted");
  assert.equal(isSettled(ev(1, 30), NaN), false, "an unknown clock settles nothing");
  assert.equal(PAST_SETTLE_MS, 7 * DAY);
  const known = new Map([["h/e1", ev(1, 30)], ["h/e2", ev(2, 31)]]);
  assert.equal(settledHeldPage([ev(1, 30), ev(2, 31)], known, asOf), true);
  assert.equal(settledHeldPage([ev(1, 30), ev(3, 32)], known, asOf), false, "an event not held");
  assert.equal(settledHeldPage([ev(1, 30), ev(2, 2)], known, asOf), false, "an event not settled");
  assert.equal(settledHeldPage([], known, asOf), false);
  const j = joinHeld({ past: { events: [ev(1, 1), { id: "bad id" }], next: { past: true, before: "b" } }, evidence: { "h/e1": { read: "ok", event: { a: 1 } } } },
    { past: { events: [ev(1, 1, { title: "tracked" }), ev(2, 2)], next: null }, evidence: { "h/e1": { read: "ok", event: { a: 2 } }, "h/e2": { read: "unavailable" } } });
  assert.deepEqual(j.past.events.map((e) => e.id), ["h/e1", "h/e2"]);
  assert.equal(j.past.events[0].title, "e1", "the seed's row wins");
  assert.deepEqual(j.past.next, { past: true, before: "b" });
  assert.equal(j.evidence["h/e1"].event.a, 1);
  const heldEv = { "h/e1": { read: "ok", read_at: "2026-11-01T00:00:00.000Z", event: {} }, "h/e2": { read: "ok", event: {} }, "h/e3": { read: "ok", read_at: "2026-10-01T00:00:00.000Z", event: {} } };
  const p = pickEvidenceWork({ events: [ev(1, 20), ev(2, 21), ev(3, 22), ev(4, 23), ev(5, 0.1, { phase: "announced" }), ev(6, 1, { cancelled: true })], calendarIds: new Set(), held: heldEv, asOfMs: asOf, refreshMax: 2 });
  assert.deepEqual(p.work.map((e) => e.id), ["h/e4", "h/e2", "h/e3"], "e4 is not held (needed), then the rotation: the unstamped e2 oldest, then e3's October stamp; e1 waits; announced and cancelled are never asked");
  assert.deepEqual([p.needed, p.rotated, p.candidates], [1, 2, 4]);
  assert.equal(pickEvidenceWork({ events: [ev(1, 20), ev(2, 21)], held: heldEv, asOfMs: asOf, window: 1, refreshMax: 5 }).candidates, 1, "the candidate window is the newest ends, as before");
  const m = mergeEvidence({ events: [ev(1, 20), ev(2, 21), ev(3, 22), ev(4, 23)], held: heldEv, fresh: { "h/e1": { read: "unavailable" }, "h/e4": { read: "unavailable" }, "h/e3": { read: "ok", event: { fresh: true } } }, readAt: NOW });
  assert.deepEqual(m.evidence["h/e1"], heldEv["h/e1"]);
  assert.deepEqual(m.evidence["h/e4"], { read: "unavailable" });
  assert.deepEqual(m.evidence["h/e3"], { read: "ok", event: { fresh: true }, read_at: NOW });
  assert.deepEqual(m.evidence["h/e2"], heldEv["h/e2"], "not asked: held stands");
  assert.deepEqual([m.refreshed, m.kept, m.failed], [1, 1, 1]);
  assert.equal(mergeEvidence({ events: [ev(9, 5)], held: {}, fresh: {}, readAt: NOW }).evidence["h/e9"], undefined, "never asked and none held: no entry (the page reads that as never asked)");
});

test("the production entry names the seed: tools/fetch-town.mjs reads POSTMARK_EVENTS_SEED_URL (default the site's own /data/events.json) and buildOfficeData reads it before the past calendar", () => {
  const entry = readFileSync(join(ROOT, "tools/fetch-town.mjs"), "utf8");
  assert.match(entry, /const EVENTS_SEED_URL = process\.env\.POSTMARK_EVENTS_SEED_URL !== undefined \? \(process\.env\.POSTMARK_EVENTS_SEED_URL \|\| null\) : `\$\{TOWN_BASE\}\/data\/events\.json`;/);
  assert.match(entry, /letterCachePath: LETTER_CACHE, eventsSeedUrl: EVENTS_SEED_URL \}\)/);
  const data = readFileSync(join(ROOT, "tools/lib/fetch-town-data.mjs"), "utf8");
  assert.match(data, /eventsSeedUrl = null,\n\} = \{\}\) \{/, "an option with a null default: unset, the bare call is unchanged");
  assert.match(data, /const seedRead = await readEventsSeed\(\{ url: eventsSeedUrl, fetchImpl \}\);/);
  assert.match(data, /snapshot: readSnapshot\("events\.json", EMPTY_EVENTS\), seed: seedRead\.state === "ok" \? seedRead\.events : null \}\)/);
  assert.equal(PAST_PAGES_MAX, 25, "the full-read budgets are what they were");
  assert.equal(EVIDENCE_MAX, 400);
});
