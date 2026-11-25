// box-bulk-reads.test.mjs — the box refresh reads the office in tens of
// requests, not ~625, and publishes exactly what the single reads published
// (2026-10-13).
//
// The office grew bulk reads beside its single ones (postmark-office, the same
// train): `/residents?cards=1`, `/bulletin?full=1`, `/doorsteps?handles=`, and
// `/letters?digests=1` with `/letters?full=1&ids=`. Each is held there to equal
// the single reads element by element; here the site is held to two things:
//   1. against an office WITH the bulk reads it builds the same files as
//      against one WITHOUT them, in far fewer requests;
//   2. the letters since last pass: only the letters that are new or moved
//      are read whole, and the corpus is the whole read's corpus.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { buildOfficeData, fetchLettersSince, fetchLetterCorpus, jsonText, readLetterCache } from "../tools/lib/fetch-town-data.mjs";
import { readDoorsteps } from "../tools/lib/doorstep-reads.mjs";

const letter = (id, from, to, date, body, box = "inbox") => ({
  id, from, to, toList: [to], date, thread: null, body, box, attachments: [],
  path: `WHITE_PAGES/${box === "inbox" ? to : from}/${box}/${id}.md`, first_line: body.slice(0, 20), delivered_at: null,
});

// A small town, its office in two flavours: `bulk` has the new reads; without
// it the office answers them as an older office does (the parameter ignored,
// or 404 "no such door" for a path it lacks).
function town() {
  const handles = Array.from({ length: 30 }, (_, i) => `r${String(i).padStart(2, "0")}`);
  const letters = new Map();
  for (let i = 0; i < 12; i++) {
    const l = letter(`l${i}`, handles[i], handles[i + 1], `2026-10-${String(1 + i).padStart(2, "0")}`, `letter ${i} body`);
    letters.set(l.id, l);
  }
  return {
    handles,
    letters,
    cards: new Map(handles.map((h) => [h, { handle: h, address: { data: { handle: h, agent: h.toUpperCase() } }, inbox: [], outbox: [], is_office: false }])),
    bulletin: new Map([["notice-a", { slug: "notice-a", data: { posted: "2026-10-01" }, body: "# A" }], ["notice-b", { slug: "notice-b", data: {}, body: "# B" }]]),
    doorsteps: new Map(handles.map((h) => [h, { handle: h, mail: { total: 0 }, note: `office doorstep for ${h}` }])),
  };
}

const NEWEST = (a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id);
const digestOf = (l) => createHash("sha256").update(JSON.stringify(l)).digest("hex").slice(0, 32);

function office(t, { bulk = true, refuseIds = false } = {}) {
  const requests = [];
  const answer = (status, body) => ({
    ok: status === 200, status, statusText: String(status),
    headers: { get: (n) => n.toLowerCase() === "x-postmark-as-of" ? "abc123" : null },
    json: async () => JSON.parse(JSON.stringify(body)),
  });
  const page = (rows, p, cap) => {
    const limit = Math.min(Math.max(Number(p.get("limit")) || 50, 1), cap);
    const offset = Math.max(Number(p.get("offset")) || 0, 0);
    const slice = rows.slice(offset, offset + limit);
    return { total: rows.length, shown: slice.length, limit, offset, complete: offset + slice.length >= rows.length, rows: slice };
  };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const p = u.searchParams;
    requests.push(`${u.pathname}${u.search}`);
    const path = u.pathname;
    if (path === "/town") return answer(200, { as_of: "abc123", counts: {} });
    if (path === "/metrics/mail") return answer(200, { as_of: "2026-10-12", days: [], totals: {}, active_threads: 0 });
    if (path === "/residents") {
      const roll = t.handles.map((h) => ({ handle: h, is_office: false }));
      const { rows, ...env } = page(roll, p, 200);
      const out = { ...env, residents: rows };
      if (bulk && p.get("cards") === "1") out.cards = rows.map((r) => t.cards.get(r.handle) ?? null);
      return answer(200, out);
    }
    const card = /^\/residents\/(.+)$/.exec(path);
    if (card) return t.cards.has(card[1]) ? answer(200, t.cards.get(card[1])) : answer(404, {});
    if (path === "/bulletin") {
      const listing = [...t.bulletin.values()].map((e) => ({ slug: e.slug, title: e.slug }));
      return answer(200, bulk && p.get("full") === "1" ? [...t.bulletin.values()] : listing);
    }
    const entry = /^\/bulletin\/(.+)$/.exec(path);
    if (entry) return t.bulletin.has(entry[1]) ? answer(200, t.bulletin.get(entry[1])) : answer(404, {});
    if (path === "/letters") {
      let rows = [...t.letters.values()].sort(NEWEST);
      if (bulk && p.get("digests") === "1") {
        const { rows: slice, ...env } = page(rows, p, 1000);
        return answer(200, { ...env, digests: true, letters: slice.map((l) => ({ id: l.id, digest: digestOf(l) })) });
      }
      if (bulk && p.has("ids")) {
        if (refuseIds) return answer(400, { defect: "no" });
        const ids = new Set(p.get("ids").split(","));
        rows = rows.filter((l) => ids.has(l.id));
      }
      const { rows: slice, ...env } = page(rows, p, 200);
      return answer(200, { ...env, full: true, letters: slice });
    }
    if (path === "/doorsteps") {
      if (!bulk) return answer(404, { defect: "no such door" });
      const hs = p.get("handles").split(",");
      return answer(200, { doorsteps: hs.map((h) => ({ handle: h, doorstep: t.doorsteps.get(h) ?? null })) });
    }
    const ds = /^\/doorstep\/(.+)$/.exec(path);
    if (ds) return t.doorsteps.has(ds[1]) ? answer(200, t.doorsteps.get(ds[1])) : answer(404, {});
    return answer(404, {}); // ledger, docs, calendar, posts, households: doors this fixture lacks
  };
  return { fetchImpl, requests };
}

function snapshot() {
  const root = mkdtempSync(join(tmpdir(), "postmark-box-bulk-"));
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  for (const [name, value] of [["ledger.json", []], ["docs.json", {}], ["meeps.json", []], ["stats.json", {}], ["residents.json", []]])
    writeFileSync(join(data, name), jsonText(value));
  return { root, data };
}

test("against an office with the bulk reads, the site builds the same files in far fewer requests", async () => {
  const t = town();
  const before = office(t, { bulk: false });
  const after = office(t, { bulk: true });
  const a = await buildOfficeData({ apiBase: "https://office.test", dataDir: snapshot().data, fetchImpl: before.fetchImpl });
  const b = await buildOfficeData({ apiBase: "https://office.test", dataDir: snapshot().data, fetchImpl: after.fetchImpl });
  for (const name of Object.keys(a.files))
    assert.equal(jsonText(b.files[name]), jsonText(a.files[name]), `${name} must be byte-identical`);
  assert.deepEqual(b.problems, a.problems);
  assert.match(b.endpointGaps.join("\n"), /resident cards read in bulk beside the roll/);
  assert.match(b.endpointGaps.join("\n"), /bulletin entries read whole in one read/);
  assert.match(a.endpointGaps.join("\n"), /resident cards read one by one/);
  // 30 cards + 2 entries became one roll-and-cards page and one bulletin read
  assert.ok(after.requests.length + 30 <= before.requests.length, `before ${before.requests.length}, after ${after.requests.length}`);
  assert.equal(after.requests.filter((r) => r.startsWith("/residents/")).length, 0);
  assert.equal(after.requests.filter((r) => r.startsWith("/bulletin/")).length, 0);
});

test("a card the bulk read answers null is the single door's 404: the resident is held over, as before", async () => {
  const t = town();
  t.cards.delete("r07");
  const a = await buildOfficeData({ apiBase: "https://office.test", dataDir: snapshot().data, fetchImpl: office(t, { bulk: false }).fetchImpl });
  const b = await buildOfficeData({ apiBase: "https://office.test", dataDir: snapshot().data, fetchImpl: office(t, { bulk: true }).fetchImpl });
  assert.equal(jsonText(b.files["residents.json"]), jsonText(a.files["residents.json"]));
  assert.deepEqual(b.problems, a.problems);
  assert.match(b.problems.join("\n"), /"r07" and the card door answered 404/);
});

test("the letters since last pass: the first pass reads whole and keeps them; the next reads only what moved", async () => {
  const t = town();
  const { root } = snapshot();
  const cachePath = join(root, "cache", "letters.json");
  const whole = (await fetchLetterCorpus({ apiBase: "https://office.test", fetchImpl: office(t).fetchImpl })).letters;

  const first = office(t);
  const one = await fetchLettersSince({ apiBase: "https://office.test", fetchImpl: first.fetchImpl, cachePath });
  assert.deepEqual(one.letters, whole);
  assert.equal(one.since, undefined, "no cache: the whole read");
  assert.ok(existsSync(cachePath));
  assert.equal(Object.keys(readLetterCache(cachePath).letters).length, 12);

  // Nothing moved: the digests and nothing else.
  const quiet = office(t);
  const two = await fetchLettersSince({ apiBase: "https://office.test", fetchImpl: quiet.fetchImpl, cachePath });
  assert.deepEqual(two.letters, whole);
  assert.deepEqual(quiet.requests, ["/letters?digests=1&limit=5000&offset=0"]);

  // The ferry moves l3 outbox → inbox (same date, new path, delivered_at), a new
  // letter lands with an OLDER date than most, and l9 leaves the town.
  t.letters.set("l3", { ...t.letters.get("l3"), box: "inbox", path: "WHITE_PAGES/r04/inbox/l3.md", delivered_at: "2026-10-12T12:00:00Z" });
  t.letters.set("late", letter("late", "r20", "r21", "2026-09-01", "merged late"));
  t.letters.delete("l9");
  const moved = office(t);
  const three = await fetchLettersSince({ apiBase: "https://office.test", fetchImpl: moved.fetchImpl, cachePath });
  const wholeNow = (await fetchLetterCorpus({ apiBase: "https://office.test", fetchImpl: office(t).fetchImpl })).letters;
  assert.deepEqual(three.letters, wholeNow, "the corpus is the whole read's corpus");
  assert.equal(three.since.fetched, 2);
  const asked = moved.requests.find((r) => r.includes("ids="));
  assert.deepEqual(new URL(`https://x${asked}`).searchParams.get("ids").split(",").sort(), ["l3", "late"]);
  assert.equal(moved.requests.length, 2, "one digest read, one ids read");
  assert.equal(three.letters.find((l) => l.id === "l3").box, "inbox");
});

test("the whole read is the fallback: an older office, refused ids, or a cache that does not parse", async () => {
  const t = town();
  const { root } = snapshot();
  const cachePath = join(root, "letters.json");
  const whole = (await fetchLetterCorpus({ apiBase: "https://office.test", fetchImpl: office(t).fetchImpl })).letters;

  // an older office: the digests parameter is ignored, the answer has no `digests`
  const old = office(t, { bulk: false });
  assert.deepEqual((await fetchLettersSince({ apiBase: "https://office.test", fetchImpl: old.fetchImpl, cachePath })).letters, whole);
  assert.equal(existsSync(cachePath), false, "no digests, nothing to keep");

  await fetchLettersSince({ apiBase: "https://office.test", fetchImpl: office(t).fetchImpl, cachePath });
  t.letters.set("l1", { ...t.letters.get("l1"), body: "edited" });
  const refused = office(t, { refuseIds: true });
  const r = await fetchLettersSince({ apiBase: "https://office.test", fetchImpl: refused.fetchImpl, cachePath, retries: 1 });
  assert.equal(r.letters.find((l) => l.id === "l1").body, "edited");
  assert.equal(r.since, undefined, "refused ids: the whole read");

  writeFileSync(cachePath, "{ not json");
  const torn = office(t);
  assert.equal((await fetchLettersSince({ apiBase: "https://office.test", fetchImpl: torn.fetchImpl, cachePath })).letters.length, 12);
  assert.ok(torn.requests.some((r) => r.startsWith("/letters?full=1&limit=200")), "a torn cache reads whole");
  assert.equal(readLetterCache(cachePath).version, 1, "and is rewritten");
});

test("doorsteps: 25 a request where the office has the bulk read, one by one where it does not, the same answers", async () => {
  const t = town();
  t.doorsteps.delete("r05");
  const bulk = office(t);
  const single = office(t, { bulk: false });
  const now = () => "2026-10-13T15:00:00.000Z";
  const a = await readDoorsteps(t.handles, { apiBase: "https://office.test", fetchImpl: bulk.fetchImpl, now });
  const b = await readDoorsteps(t.handles, { apiBase: "https://office.test", fetchImpl: single.fetchImpl, now });
  assert.deepEqual([...a.doorsteps], [...b.doorsteps]);
  assert.deepEqual(a.doorsteps.get("r05"), { error: "HTTP 404" }, "a null is the single door's 404, and the file is kept");
  assert.equal(a.inBulk, 30);
  assert.equal(bulk.requests.length, 2, "30 doorsteps in two reads");
  assert.equal(b.inBulk, 0);
  assert.equal(single.requests.length, 31, "one refused bulk read, then thirty single reads");

  // THE ANSWER'S CLOCK: one reading per answer, so two bulk answers carry two
  // stamps, and every doorstep in one answer carries that answer's.
  let tick = 0;
  const clock = () => `2026-10-13T15:00:0${tick++}.000Z`;
  const c = await readDoorsteps(t.handles, { apiBase: "https://office.test", fetchImpl: office(t).fetchImpl, now: clock });
  assert.equal(c.doorsteps.get("r00").fetchedAt, c.doorsteps.get("r24").fetchedAt);
  assert.notEqual(c.doorsteps.get("r24").fetchedAt, c.doorsteps.get("r25").fetchedAt);
  assert.equal(tick, 2);
});

// ── THE LETTERS SINCE THE LAST PUBLISHED SNAPSHOT (CORE-180) ────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// The release lane on Actions has no letter cache and a clean checkout has no letters, so it read the whole corpus every build (118 of the 182 office requests in the counted pass at
// cf319245). The held state is the site's own last PUBLISHED letters.json, read as one static GET; the office's inventory (/letters?digests=1) is read every pass, and only letters the
// snapshot does not hold, or that are still in transit (not yet in the inbox), are read whole. These run the real buildOfficeData (the consumer) over this file's office, which counts
// every request, and a seed served from a stubbed address; the live office and the live site are never read.
const SEED_URL = "https://seed.invalid/data/letters.json";
const OFFICE = "https://office.test";
const withSeed = (o, answer) => ({ requests: o.requests, fetchImpl: async (url, init) => { if (String(url).startsWith("https://seed.invalid")) { o.requests.push("seed"); return answer(); } return o.fetchImpl(url, init); } });
const served = (body, status = 200) => ({ ok: status === 200, status, statusText: String(status), headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(body)) });
const build = (h, extra = {}) => buildOfficeData({ apiBase: OFFICE, dataDir: snapshot().data, fetchImpl: h.fetchImpl, ...extra });
const lettersAsked = (o) => o.requests.filter((r) => r.startsWith("/letters"));
const publishedOf = async (t) => (await build(office(t))).files["letters.json"];             // what a build wrote and was published

test("LETTERS, SEEDED WARM: nothing moved is the inventory and nothing else; the file is the cold build's, byte for byte; no raw or private field is added", async () => {
  const t = town();
  const seed = await publishedOf(t);
  const cold = await build(office(t));
  const o = office(t);
  const warm = await build(withSeed(o, () => served(seed)), { lettersSeedUrl: SEED_URL });
  assert.deepEqual(lettersAsked(o), ["/letters?digests=1&limit=5000&offset=0"], "the office's inventory only: no full page, no ids read");
  assert.equal(o.requests.filter((r) => r === "seed").length, 1, "one static GET");
  assert.equal(jsonText(warm.files["letters.json"]), jsonText(cold.files["letters.json"]), "the same published corpus");
  assert.deepEqual(Object.keys(warm.files["letters.json"][0]).sort(), ["attachments", "body", "box", "date", "from", "id", "path", "thread", "to", "toList"], "mapLetter's projection, nothing added (no digest, no row, no delivered_at)");
  assert.match(warm.endpointGaps.join("\n"), /letters\.json built from the last published file and the office's inventory \(\/letters\?digests=1\): 12 letters, 12 held as published, 0 read whole/);
  // COLD, no seed named: the whole corpus, as every build without one always has
  const c = office(t);
  await build(c);
  assert.ok(lettersAsked(c).some((r) => r.startsWith("/letters?full=1&limit=200&offset=0")));
  assert.equal(c.requests.includes("seed"), false);
});

test("LETTERS, NEW DELIVERIES: a letter new to the snapshot is found by its id whatever its authored date (backdated, tied), a letter in transit is read as it is now, a withdrawn one leaves", async () => {
  const t = town();
  t.letters.set("transit", letter("transit", "r20", "r21", "2026-10-05", "not yet delivered", "outbox"));
  const seed = await publishedOf(t);
  // the ferry delivers it, a backdated letter and one TIED with l5's date are merged late, and l9 leaves the town
  t.letters.set("transit", letter("transit", "r20", "r21", "2026-10-05", "not yet delivered", "inbox"));
  t.letters.set("late", letter("late", "r22", "r23", "2026-09-01", "merged late, backdated"));
  t.letters.set("tie", letter("tie", "r24", "r25", t.letters.get("l5").date, "same date as l5"));
  t.letters.delete("l9");
  const o = office(t);
  const warm = await build(withSeed(o, () => served(seed)), { lettersSeedUrl: SEED_URL });
  const cold = await build(office(t));
  assert.equal(jsonText(warm.files["letters.json"]), jsonText(cold.files["letters.json"]), "the corpus is the whole read's corpus: complete, deduplicated, ordered");
  const ids = lettersAsked(o).filter((r) => r.includes("ids=")).map((r) => new URL(`https://x${r}`).searchParams.get("ids").split(",")).flat().sort();
  assert.deepEqual(ids, ["late", "tie", "transit"], "only what the snapshot did not hold or still had in transit");
  assert.equal(lettersAsked(o).length, 2, "one inventory read, one ids read");
  assert.equal(warm.files["letters.json"].find((l) => l.id === "transit").box, "inbox", "delivered now");
  assert.equal(warm.files["letters.json"].some((l) => l.id === "l9"), false, "withdrawn: gone from the corpus");
  assert.ok(warm.files["letters.json"].some((l) => l.id === "late"));
  assert.match(warm.endpointGaps.join("\n"), /11 held as published, 3 read whole|10 held as published, 3 read whole/);
});

test("LETTERS: a held letter that was delivered is not read again and is kept exactly as published; one still in the outbox is read every pass until it is delivered", async () => {
  const t = town();
  t.letters.set("transit", letter("transit", "r20", "r21", "2026-10-05", "in the outbox", "outbox"));
  const seed = await publishedOf(t);
  const o = office(t);
  await build(withSeed(o, () => served(seed)), { lettersSeedUrl: SEED_URL });
  const asked = lettersAsked(o).filter((r) => r.includes("ids=")).map((r) => new URL(`https://x${r}`).searchParams.get("ids")).join(",");
  assert.equal(asked, "transit", "the delivered ones are held, the one in transit is read");
  // the held, delivered letter is the published one even if the office's copy differs (a delivered letter never changes: Wright, 2026-11-25)
  const kept = seed.map((l) => (l.id === "l2" ? { ...l, body: "as published" } : l));
  const o2 = office(t);
  const r = await build(withSeed(o2, () => served(kept)), { lettersSeedUrl: SEED_URL });
  assert.equal(r.files["letters.json"].find((l) => l.id === "l2").body, "as published");
});

test("LETTERS, A SEED THAT CANNOT BE TRUSTED IS NO SEED: absent, refused, corrupt, not an array, a row that is no letter, incomplete or foreign reads the whole corpus, said", async () => {
  const t = town();
  const seed = await publishedOf(t);
  const cases = [
    ["404", () => served({}, 404), /no published file at .* yet \(a first build\)/],
    ["503", () => served({}, 503), /could not be read \(503/],
    ["not JSON", () => ({ ok: true, status: 200, statusText: "OK", headers: { get: () => null }, json: async () => { throw new SyntaxError("Unexpected token <"); } }), /could not be read \(not JSON/],
    ["not an array", () => served({ letters: seed }), /could not be read \(it is not an array of letters/],
    ["a row that is no letter", () => served([...seed.slice(0, 3), { id: "x" }]), /could not be read \(a row is not a letter/],
    ["no body key", () => served(seed.map(({ body, ...rest }) => rest)), /could not be read \(a row is not a letter/],
  ];
  for (const [name, answer, said] of cases) {
    const o = office(t);
    const r = await build(withSeed(o, answer), { lettersSeedUrl: SEED_URL });
    assert.ok(lettersAsked(o).some((q) => q.startsWith("/letters?full=1&limit=200&offset=0")), `${name}: the whole corpus is read`);
    assert.equal(lettersAsked(o).some((q) => q.includes("ids=")), false, `${name}: no ids read`);
    assert.match(r.endpointGaps.join("\n"), said, `${name}: said`);
    assert.equal(r.files["letters.json"].length, 12);
  }
  // INCOMPLETE (two letters) and FOREIGN (another office's ids) seeds are valid files that, on a town of this size, would cost more reads than the whole corpus: the whole corpus is read,
  // and the corpus is right, exactly the office's letters, none of the seed's
  for (let i = 12; i < 450; i++) t.letters.set(`l${i}`, letter(`l${i}`, t.handles[i % 30], t.handles[(i + 1) % 30], `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`, `letter ${i} body`));
  const big = await publishedOf(t);
  for (const [name, rows] of [["incomplete", big.slice(0, 2)], ["foreign", big.map((l) => ({ ...l, id: `other-${l.id}` }))]]) {
    const o = office(t);
    const r = await build(withSeed(o, () => served(rows)), { lettersSeedUrl: SEED_URL });
    assert.ok(lettersAsked(o).some((q) => q.startsWith("/letters?full=1&limit=200&offset=0")), `${name}: the whole corpus`);
    assert.equal(lettersAsked(o).some((q) => q.includes("ids=")), false, `${name}: no ids reads`);
    assert.equal(jsonText(r.files["letters.json"]), jsonText(big), `${name}: and exactly the office's letters, none of the seed's`);
  }
  // a seed that is only a little behind reads the few it lacks (the same big town, ten letters newer than the seed)
  const o = office(t);
  const behind = await build(withSeed(o, () => served(big.filter((l) => !["l440", "l441", "l442"].includes(l.id)))), { lettersSeedUrl: SEED_URL });
  assert.equal(lettersAsked(o).filter((q) => q.includes("ids=")).length, 1, "one ids read for the three it lacked");
  assert.equal(jsonText(behind.files["letters.json"]), jsonText(big));
});

test("LETTERS: no stale publication on failure, and no seed where there is a cache or no opt-in", async () => {
  const t = town();
  const seed = await publishedOf(t);
  t.letters.set("late", letter("late", "r22", "r23", "2026-09-01", "merged late"));
  // the ids read fails: the build does not publish the seed's letters as if they were current (the bulk door did not answer, the existing fallback speaks), and says so
  const o = office(t, { refuseIds: false });
  const failing = { requests: o.requests, fetchImpl: async (url, init) => { if (String(url).includes("ids=")) throw new Error("socket hang up"); if (String(url).startsWith("https://seed.invalid")) return served(seed); return o.fetchImpl(url, init); } };
  const r = await build(failing, { lettersSeedUrl: SEED_URL, retries: 1 });
  assert.match(r.problems.join("\n"), /letters: the bulk door did not answer \(.*socket hang up.*\); built from the resident cards instead/);
  assert.notEqual(jsonText(r.files["letters.json"]), jsonText(seed), "the seed's letters were not published in its place");
  // a letter cache wins over a seed: the seed is not even asked
  const { root } = snapshot();
  const c = office(t);
  await build(withSeed(c, () => served(seed)), { lettersSeedUrl: SEED_URL, letterCachePath: join(root, "cache", "letters.json") });
  assert.equal(c.requests.includes("seed"), false);
  // no seed named: nothing is asked of the site
  const n = office(t);
  await build(withSeed(n, () => served(seed)));
  assert.equal(n.requests.includes("seed"), false);
});

test("LETTERS: the default seed is production's published file for the production API only; the production entry passes it through", async () => {
  const { defaultLettersSeedUrl, readLettersSeed } = await import("../tools/lib/letters-seed.mjs");
  const prod = { api: "https://postmark.town/api", defaultApi: "https://postmark.town/api", townBase: "https://postmark.town" };
  assert.equal(defaultLettersSeedUrl({ env: {}, ...prod }), "https://postmark.town/data/letters.json");
  assert.equal(defaultLettersSeedUrl({ env: {}, ...prod, api: "https://office.example/api" }), null, "another office: no production seed");
  assert.equal(defaultLettersSeedUrl({ env: {}, ...prod, api: "http://127.0.0.1:4380/api" }), null, "the box's loopback office reads as ever");
  assert.equal(defaultLettersSeedUrl({ env: { POSTMARK_LETTERS_SEED_URL: "https://other.example/letters.json" }, ...prod, api: "https://office.example/api" }), "https://other.example/letters.json");
  assert.equal(defaultLettersSeedUrl({ env: { POSTMARK_LETTERS_SEED_URL: "" }, ...prod }), null);
  assert.equal((await readLettersSeed({ url: null })).state, "unset");
  assert.equal((await readLettersSeed({ url: "x", fetchImpl: async () => { throw new Error("offline"); } })).state, "unreadable");
  const { readFileSync } = await import("node:fs");
  const entry = readFileSync(new URL("../tools/fetch-town.mjs", import.meta.url), "utf8");
  assert.match(entry, /const LETTERS_SEED_URL = defaultLettersSeedUrl\(\{ env: process\.env, api: API, defaultApi: DEFAULT_API, townBase: TOWN_BASE \}\);/);
  assert.match(entry, /lettersSeedUrl: LETTERS_SEED_URL \}\)/);
});
