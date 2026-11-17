// pos-1086-doorstep-known.test.mjs — the refresh serves doorsteps from what changed (POS-1086, the site half).
//
// LAW (Darko, 2026-11-16 13:53 EST, POS-1086: "serving doorstep from snapshot is worth considering, and maybe
// just adding whatever could incrementally change"; 2026-11-17 09:52 EST: get through the planned list, merge,
// and come back with numbers). The office (w47.12) gives each REST doorstep a `rev`, the hash of its content
// without five town-wide leaves, and answers `/doorsteps?known=handle:rev` with `{ handle, unchanged: true }`.
//
// WHAT THESE HOLD, from the acceptance:
//   - after a one-letter change, a pass fetches only the residents it touched;
//   - the output is byte-identical to a full fetch of the same inputs, `doorstep_fetched_at` aside;
//   - a full pass still works, asked for and on the first run after a deploy;
//   - the site's own rows (not the office's) are composed again for every resident, carried over or not.
// The office here is a fake that computes its `rev` the way the office's src/doorstep-rev.mjs does (the five
// leaves out, keys sorted, sha-256, 16 hex); the prod measurement that fixed those leaves is on POS-1086.
//   node --test test/pos-1086-doorstep-known.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { composeDoorstep, renderDoorstepMarkdown, DOORSTEP_SITE_KEYS } from "../tools/lib/doorstep.mjs";
import { readDoorsteps } from "../tools/lib/doorstep-reads.mjs";
import { refreshDoorsteps, patchGlobal, officeBodyOf, builderFingerprint, loadState } from "../tools/lib/doorstep-refresh.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(readFileSync(join(HERE, "fixtures", n), "utf8"));
const OFFICE = fixture("doorstep-office-wright.json");
const STATIC = fixture("doorstep-static-wright.json");

// ── a fake office that answers the way w47.12 does ───────────────────────────

const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v);
function revOf(d) {
  const b = JSON.parse(JSON.stringify(d)); delete b.rev; delete b.as_of;
  delete b.copy.newest_change_at; delete b.copy.sentence;
  delete b.window.freshness.settled_as_of; delete b.pending_outbox_freshness.settled_as_of;
  return createHash("sha256").update(canonical(b)).digest("hex").slice(0, 16);
}

function fakeTown(n) {
  const handles = Array.from({ length: n }, (_, i) => `r${String(i).padStart(2, "0")}`);
  return { asOf: "a".repeat(40), newest: "2026-11-17T15:00:00.000Z", content: new Map(handles.map((h) => [h, 0])), handles };
}
function doorstepOf(t, h) {
  const d = structuredClone(OFFICE);
  d.handle = h;
  d.as_of = t.asOf;
  d.copy = { newest_change_at: t.newest, crossing: { crossing: 317 }, caught_up: true, sentence: `This page reads the office's copy at commit ${t.asOf.slice(0, 12)}; newest ${t.newest}.` };
  d.window.freshness.settled_as_of = t.asOf;
  d.pending_outbox_freshness.settled_as_of = t.asOf;
  d.mail = { ...d.mail, letters_seen: t.content.get(h) };
  d.rev = revOf(d);
  return d;
}
const globalOf = (t) => { const d = doorstepOf(t, t.handles[0]); return { as_of: d.as_of, copy: { newest_change_at: d.copy.newest_change_at, sentence: d.copy.sentence }, window_settled_as_of: t.asOf, outbox_settled_as_of: t.asOf }; };

function fakeOffice(t, { bulk = true, knownAware = true } = {}) {
  const log = { requests: [], whole: [] };
  const res = (status, body) => ({ ok: status === 200, status, json: async () => JSON.parse(JSON.stringify(body)) });
  const fetchImpl = async (url) => {
    const u = new URL(url), p = u.searchParams;
    log.requests.push(`${u.pathname}${u.search}`);
    if (u.pathname === "/doorsteps") {
      if (!bulk) return res(404, {});
      const handles = p.get("handles").split(",");
      const known = new Map((p.get("known") ?? "").split(",").filter(Boolean).map((e) => e.split(":")));
      const rows = handles.map((h) => {
        const d = doorstepOf(t, h);
        if (knownAware && known.get(h) === d.rev) return { handle: h, unchanged: true, rev: d.rev };
        log.whole.push(h);
        return { handle: h, doorstep: d };
      });
      return res(200, rows.some((r) => r.unchanged) ? { doorsteps: rows, global: globalOf(t) } : { doorsteps: rows });
    }
    const one = /^\/doorstep\/(.+)$/.exec(u.pathname);
    if (one) { log.whole.push(one[1]); return res(200, doorstepOf(t, one[1])); }
    return res(404, {});
  };
  return { fetchImpl, log };
}

// ── the site's side: the real composition and the real markdown, over invented rows ─────────────

function builder(site) {
  return (handle, office, fetchedAt) => {
    const rows = Object.fromEntries(DOORSTEP_SITE_KEYS.map((k) => [k, STATIC[k]]));
    const bundle = composeDoorstep(office, { ...rows, note: site.note, site: { ...STATIC.site, doorstep_fetched_at: fetchedAt, crossing: site.crossing } });
    return { json: JSON.stringify(bundle, null, 1) + "\n", md: renderDoorstepMarkdown(bundle, { townBase: "https://postmark.town" }) };
  };
}

const scratch = () => mkdtempSync(join(tmpdir(), "pos1086-site-"));
const stamp = (s) => s.replace(/"doorstep_fetched_at": "[^"]*"/g, '"doorstep_fetched_at": "S"').replace(/`fetched`: [^\s]+/g, "`fetched`: S");
const snapshot = (dir) => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const normalised = (dir) => Object.fromEntries(Object.entries(snapshot(dir)).map(([f, s]) => [f, stamp(s)]));

let clock = 0;
const pass = async (t, dir, state, { site = { note: "n", crossing: 317 }, full = false, office = {}, builderId = "b1" } = {}) => {
  const o = fakeOffice(t, office);
  const nowIso = () => `2026-11-17T15:${String(10 + clock++).padStart(2, "0")}:00.000Z`;
  const r = await refreshDoorsteps(t.handles, { apiBase: "https://office.test", dir, state, builder: builderId, full, build: builder(site), fetchImpl: o.fetchImpl, now: nowIso });
  return { ...r, log: o.log, state: { builder: builderId, revs: r.revs } };
};

test("a first pass with no state reads every doorstep whole and keeps each bulk rev", async () => {
  const dir = scratch(), t = fakeTown(30);
  const a = await pass(t, dir, null);
  assert.equal(a.stats.mode, "no state");
  assert.equal(a.stats.fetched, 30);
  assert.equal(a.stats.carried, 0);
  assert.equal(a.log.whole.length, 30);
  assert.equal(readdirSync(dir).length, 60, "a json and a markdown for each");
  assert.deepEqual(Object.keys(a.revs).length, 30);
  for (const h of t.handles) assert.equal(a.revs[h], doorstepOf(t, h).rev);
  assert.ok(a.log.requests.every((r) => !r.includes("known=")), "nothing is known yet, so nothing is claimed");
  rmSync(dir, { recursive: true, force: true });
});

test("ACCEPTANCE: a quiet pass fetches no doorstep body and writes nothing", async () => {
  const dir = scratch(), t = fakeTown(60);
  const a = await pass(t, dir, null);
  const before = snapshot(dir);
  const b = await pass(t, dir, a.state);
  assert.equal(b.stats.mode, "incremental");
  assert.deepEqual(b.log.whole, [], "no whole body came from the office");
  assert.equal(b.stats.carried, 60);
  assert.equal(b.stats.wrote, 0);
  assert.equal(b.log.requests.length, 3, "60 residents in 3 bulk reads of at most 25");
  assert.ok(b.log.requests.every((r) => r.includes("&known=")));
  assert.deepEqual(snapshot(dir), before, "not one byte moved, the stamps included");
  assert.deepEqual(b.revs, a.revs, "the revs are kept");
  rmSync(dir, { recursive: true, force: true });
});

test("ACCEPTANCE: after a one-letter change a pass fetches only the resident it touched, and the output equals a full fetch", async () => {
  const dir = scratch(), t = fakeTown(60);
  const a = await pass(t, dir, null);
  t.content.set("r07", 1); // one letter lands for r07
  const b = await pass(t, dir, a.state);
  assert.deepEqual(b.log.whole, ["r07"], "the office sent one body");
  assert.equal(b.stats.fetched, 1);
  assert.equal(b.stats.carried, 59);
  assert.equal(b.stats.wrote, 2, "only r07's json and markdown were written");
  assert.notEqual(b.revs.r07, a.revs.r07);
  // the control: a full fetch of the same inputs, into a directory of its own
  const full = scratch();
  await pass(t, full, null);
  assert.deepEqual(normalised(dir), normalised(full), "byte for byte the full fetch's files, `doorstep_fetched_at` aside");
  assert.notDeepEqual(snapshot(dir)["r07.json"], undefined);
  rmSync(dir, { recursive: true, force: true }); rmSync(full, { recursive: true, force: true });
});

test("a move of the office's copy of the record alone: every doorstep carried over, five leaves patched, equal to a full fetch", async () => {
  const dir = scratch(), t = fakeTown(30);
  const a = await pass(t, dir, null);
  const before = snapshot(dir);
  t.asOf = "b".repeat(40); t.newest = "2026-11-17T15:05:18.000Z";
  const b = await pass(t, dir, a.state);
  assert.deepEqual(b.log.whole, [], "the rev ignores the five leaves, so nothing is fetched");
  assert.equal(b.stats.carried, 30);
  assert.equal(b.stats.wrote, 60, "each file moved, by its patched leaves");
  const first = JSON.parse(readFileSync(join(dir, "r00.json"), "utf8"));
  assert.equal(first.as_of, "b".repeat(40));
  assert.equal(first.copy.newest_change_at, "2026-11-17T15:05:18.000Z");
  assert.equal(first.window.freshness.settled_as_of, "b".repeat(40));
  assert.equal(first.pending_outbox_freshness.settled_as_of, "b".repeat(40));
  assert.notEqual(first.site.doorstep_fetched_at, JSON.parse(before["r00.json"]).site.doorstep_fetched_at, "a moved file takes the moment the office said unchanged");
  const full = scratch();
  await pass(t, full, null);
  assert.deepEqual(normalised(dir), normalised(full));
  rmSync(dir, { recursive: true, force: true }); rmSync(full, { recursive: true, force: true });
});

test("the site's own rows are composed again for a carried-over resident: a changed site row reaches every file", async () => {
  const dir = scratch(), t = fakeTown(12);
  const a = await pass(t, dir, null, { site: { note: "one", crossing: 317 } });
  const b = await pass(t, dir, a.state, { site: { note: "two", crossing: 318 } });
  assert.deepEqual(b.log.whole, []);
  for (const h of t.handles) {
    const f = JSON.parse(readFileSync(join(dir, `${h}.json`), "utf8"));
    assert.equal(f.note, "two", `${h}: the site's own row moved without the office`);
    assert.equal(f.site.crossing, 318);
  }
  const full = scratch();
  await pass(t, full, null, { site: { note: "two", crossing: 318 } });
  assert.deepEqual(normalised(dir), normalised(full));
  rmSync(dir, { recursive: true, force: true }); rmSync(full, { recursive: true, force: true });
});

test("ACCEPTANCE: a full pass is still available: asked for, with no state, after a deploy, and for a file whose rev does not match", async () => {
  const dir = scratch(), t = fakeTown(30);
  const a = await pass(t, dir, null);
  const flagged = await pass(t, dir, a.state, { full: true });
  assert.equal(flagged.stats.mode, "full pass asked for");
  assert.equal(flagged.log.whole.length, 30);
  assert.ok(flagged.log.requests.every((r) => !r.includes("known=")));
  const deployed = await pass(t, dir, a.state, { builderId: "b2" });
  assert.equal(deployed.stats.mode, "a deploy changed the builder");
  assert.equal(deployed.log.whole.length, 30, "the first run after a deploy reads everything");
  // a file on disk that is not the answer the state's rev names is read whole, alone
  const b = await pass(t, dir, deployed.state, { builderId: "b2" });
  assert.deepEqual(b.log.whole, [], "the pass after that deploy is incremental again");
  const bad = JSON.parse(readFileSync(join(dir, "r03.json"), "utf8")); bad.rev = "0".repeat(16);
  writeFileSync(join(dir, "r03.json"), JSON.stringify(bad));
  const c = await pass(t, dir, b.state, { builderId: "b2" });
  assert.deepEqual(c.log.whole, ["r03"]);
  rmSync(dir, { recursive: true, force: true });
});

test("revs are kept only from the bulk read: an office with no bulk door leaves none, and the next pass is whole", async () => {
  const dir = scratch(), t = fakeTown(8);
  const a = await pass(t, dir, null, { office: { bulk: false } });
  assert.equal(a.stats.fetched, 8);
  assert.deepEqual(a.revs, {}, "a single read's rev is not recorded");
  const b = await pass(t, dir, a.state);
  assert.equal(b.log.whole.length, 8);
  assert.equal(Object.keys(b.revs).length, 8, "and the bulk read records them");
  rmSync(dir, { recursive: true, force: true });
});

test("an office that ignores known= answers whole bodies and the pass still works", async () => {
  const dir = scratch(), t = fakeTown(10);
  const a = await pass(t, dir, null);
  const b = await pass(t, dir, a.state, { office: { knownAware: false } });
  assert.equal(b.log.whole.length, 10);
  assert.equal(b.stats.fetched, 10);
  assert.equal(b.stats.wrote, 20, "today's behaviour: every body is new to this pass, so every stamp moves");
  assert.equal(Object.keys(b.revs).length, 10, "each whole bulk body carries its rev, which is kept");
  rmSync(dir, { recursive: true, force: true });
});

test("readDoorsteps believes an unchanged row only for a rev it sent, and only with the global leaves beside it", async () => {
  const t = fakeTown(3);
  const row = (h, extra) => ({ handle: h, ...extra });
  const mk = (rows, global) => async () => ({ ok: true, status: 200, json: async () => ({ doorsteps: rows, ...(global ? { global } : {}) }) });
  const singles = [];
  const wrap = (bulkImpl) => async (url) => {
    if (String(url).includes("/doorsteps?")) return bulkImpl(url);
    singles.push(String(url)); const h = String(url).split("/").pop();
    return { ok: true, status: 200, json: async () => doorstepOf(t, h) };
  };
  const known = new Map(t.handles.map((h) => [h, doorstepOf(t, h).rev]));
  const good = t.handles.map((h) => row(h, { unchanged: true, rev: known.get(h) }));
  const ok = await readDoorsteps(t.handles, { apiBase: "x", fetchImpl: wrap(mk(good, globalOf(t))), known });
  assert.ok([...ok.doorsteps.values()].every((r) => r.unchanged === true && r.global), "believed");
  assert.deepEqual(singles, []);
  const noGlobal = await readDoorsteps(t.handles, { apiBase: "x", fetchImpl: wrap(mk(good, null)), known });
  assert.ok([...noGlobal.doorsteps.values()].every((r) => r.body), "unchanged without global: read singly, whole");
  assert.equal(singles.length, 3);
  singles.length = 0;
  const wrongRev = t.handles.map((h) => row(h, { unchanged: true, rev: "f".repeat(16) }));
  const lied = await readDoorsteps(t.handles, { apiBase: "x", fetchImpl: wrap(mk(wrongRev, globalOf(t))), known });
  assert.ok([...lied.doorsteps.values()].every((r) => r.body), "a rev that is not the one sent is not believed");
  singles.length = 0;
  const unsent = await readDoorsteps(t.handles, { apiBase: "x", fetchImpl: wrap(mk(good, globalOf(t))), known: null });
  assert.ok([...unsent.doorsteps.values()].every((r) => r.body), "unchanged when nothing was claimed is not believed");
});

test("patchGlobal is the inverse of the office's strip: the leaves at one record, patched to another, equal a body composed at that other", () => {
  const t = fakeTown(1);
  const at1 = doorstepOf(t, "r00");
  t.asOf = "c".repeat(40); t.newest = "2026-11-17T16:00:00.000Z";
  const at2 = doorstepOf(t, "r00");
  assert.notEqual(JSON.stringify(at1), JSON.stringify(at2));
  const patched = patchGlobal(at1, globalOf(t));
  assert.equal(JSON.stringify(patched), JSON.stringify(at2), "key order and every value");
  assert.equal(patchGlobal(at1, { ...globalOf(t), as_of: null }), null, "a leaf the global does not carry: the caller reads whole");
  assert.deepEqual(officeBodyOf(composeDoorstep(at1, Object.fromEntries(DOORSTEP_SITE_KEYS.map((k) => [k, STATIC[k]])))), at1, "the office's part comes back out of a composed file");
});

test("builderFingerprint moves with any file's bytes, and loadState refuses what is not state", () => {
  const dir = scratch();
  const a = join(dir, "a.mjs"), b = join(dir, "b.mjs");
  writeFileSync(a, "1"); writeFileSync(b, "2");
  const f1 = builderFingerprint([a, b]);
  assert.equal(builderFingerprint([a, b]), f1);
  writeFileSync(b, "3");
  assert.notEqual(builderFingerprint([a, b]), f1);
  assert.equal(loadState(join(dir, "missing.json")), null);
  writeFileSync(join(dir, "bad.json"), "{");
  assert.equal(loadState(join(dir, "bad.json")), null);
  writeFileSync(join(dir, "ok.json"), JSON.stringify({ builder: "x", revs: { a: "b" } }));
  assert.deepEqual(loadState(join(dir, "ok.json")), { builder: "x", revs: { a: "b" } });
  rmSync(dir, { recursive: true, force: true });
});

// WIRING, a text pin and labelled one: extract-town.mjs imports no pass of its own any more. It reaches the office only through
// refreshDoorsteps, which is exercised above, and it passes the flag, the state path and the builder fingerprint.
test("WIRING (text pin): the extractor's doorstep phase is refreshDoorsteps, with the full flag and the state", () => {
  const src = readFileSync(join(HERE, "..", "tools", "extract-town.mjs"), "utf8").replace(/\/\/.*$/gm, "");
  assert.match(src, /await refreshDoorsteps\(/);
  assert.match(src, /--full-doorsteps/);
  assert.match(src, /DOORSTEPS_FULL/);
  assert.match(src, /builderFingerprint\(/);
  assert.match(src, /doorstep-state\.json/);
  assert.equal(/\breadDoorsteps\(/.test(src), false, "the phase no longer reads the office by itself");
});
