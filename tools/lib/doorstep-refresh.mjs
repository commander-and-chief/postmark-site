// doorstep-refresh.mjs — the refresh's doorstep phase, serving what changed (POS-1086).
//
// WHY. Every pass asked the office for every resident's doorstep (about 392) and
// rewrote every file, because each file's own `site.doorstep_fetched_at` moved.
// The office (release w47.12) now gives each REST doorstep a `rev`, the hash of
// its content without five town-wide leaves, and answers `/doorsteps?known=` with
// `{ handle, unchanged: true }` for a rev that still matches. Measured 2026-11-17
// (the finding on POS-1086): an idle resident's rev held across a move of the
// office's copy of the town record; a resident whose own content moved got a new one.
//
// THE REVISION IS THE CONTENT, so a carried-over doorstep cannot be stale: the
// office said its answer for this handle is the answer we already hold, except for
// the five leaves it hands back once (`global`), which are patched in.
//
// WHAT IS CARRIED, AND WHAT IS NOT. Only the OFFICE's part of the file. The site's
// own keys (PR states, gifts, stakes, Ferry's line, quests, letters on the water,
// fulltext postings, the crossing, the town commit) are not the office's answer
// and can move without it, so they are composed again for every resident, from
// this pass's inputs, by the same `build` a full pass uses. So a carried-over
// file is exactly what a full fetch of the same inputs would write.
//
// WHERE IT IS KEPT: OUTSIDE THE TREE. The box's site-refresh.sh runs
// `checkout -qf -B refresh-main` and `clean -qfd -e node_modules` on the extract
// tree before every pass: an untracked file there is gone, and the doorstep files
// the checkout restores are main's committed ones, which carry no current `rev`.
// So the state (`state.json`: the builder fingerprint and each handle's rev) and
// each resident's last office part (`<handle>.office.json`: `{ fetched_at, office }`)
// live in `stateDir`, a directory the caller takes from DOORSTEP_STATE_DIR. A
// carried-over file is built from that kept copy and never from the tree's files.
//
// THE STAMP. `site.doorstep_fetched_at` is when the office last answered for that
// handle. A carried-over file whose bytes do not move keeps its stamp and is not
// written; one whose bytes move (a patched leaf, a site-side row, a tree whose
// files were put back) takes the moment the office said "unchanged", which is a
// true answer-time for it.
//
// A FULL PASS comes when asked (`--full-doorsteps`, or DOORSTEPS_FULL=1), when there
// is no state, when the state names another builder (the first run after a deploy
// of any of the files this phase is made of), and for any handle whose kept copy
// is missing or is not the answer its rev names. Revs are kept only from the bulk read.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOORSTEP_SITE_KEYS } from "./doorstep.mjs";
import { readDoorsteps, readDoorstep } from "./doorstep-reads.mjs";
import { writeIfChanged } from "./mirror.mjs";

export const REV_RE = /^[0-9a-f]{16}$/;

/** A short fingerprint of the files this phase is made of; another value means a deploy changed them. */
export function builderFingerprint(paths) {
  const h = createHash("sha256");
  for (const p of paths) h.update(p.replace(/^.*[\\/]/, "")).update("\0").update(readFileSync(p)).update("\0");
  return h.digest("hex").slice(0, 16);
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

/** The state file in `stateDir`: `{ builder, revs: { handle: rev } }`, or null when absent or unreadable. */
export function loadState(stateDir) {
  const s = readJson(join(stateDir, "state.json"));
  return s && typeof s.builder === "string" && s.revs && typeof s.revs === "object" ? s : null;
}

/** One resident's kept office part: `{ fetched_at, office }`, or null. */
export const keptPath = (stateDir, handle) => join(stateDir, `${handle}.office.json`);

/** The office's part of a composed doorstep: every key the site did not add, in the office's order. */
export function officeBodyOf(bundle) {
  return Object.fromEntries(Object.entries(bundle).filter(([k]) => !DOORSTEP_SITE_KEYS.includes(k)));
}

/**
 * The office body with the five town-wide leaves taken from `global` (office `src/doorstep-rev.mjs`):
 * `as_of`, `copy.newest_change_at`, `copy.sentence`, `window.freshness.settled_as_of`, `pending_outbox_freshness.settled_as_of`.
 * Key order is kept. Null when a leaf the body holds is one `global` does not carry: the caller reads that handle whole.
 */
export function patchGlobal(office, global) {
  const out = { ...office };
  const set = (obj, key, v) => (v === null || v === undefined ? false : ((obj[key] = v), true));
  if ("as_of" in out && !set(out, "as_of", global?.as_of)) return null;
  if (out.copy && typeof out.copy === "object") {
    out.copy = { ...out.copy };
    if ("newest_change_at" in out.copy && !set(out.copy, "newest_change_at", global?.copy?.newest_change_at)) return null;
    if ("sentence" in out.copy && !set(out.copy, "sentence", global?.copy?.sentence)) return null;
  }
  if (out.window?.freshness && typeof out.window.freshness === "object" && "settled_as_of" in out.window.freshness) {
    out.window = { ...out.window, freshness: { ...out.window.freshness } };
    if (!set(out.window.freshness, "settled_as_of", global?.window_settled_as_of)) return null;
  }
  if (out.pending_outbox_freshness && typeof out.pending_outbox_freshness === "object" && "settled_as_of" in out.pending_outbox_freshness) {
    out.pending_outbox_freshness = { ...out.pending_outbox_freshness };
    if (!set(out.pending_outbox_freshness, "settled_as_of", global?.outbox_settled_as_of)) return null;
  }
  return out;
}

/**
 * One pass over every doorstep. `build(handle, office, fetchedAt)` is the site's composition: `{ json, md }` texts.
 * `stateDir` holds the state and the kept office parts (see the head of this file); it is read and written here,
 * and it is the only place besides `dir` this writes. Returns `{ revs, stats }`.
 */
export async function refreshDoorsteps(handles, { apiBase, dir, stateDir, builder, full = false, build, fetchImpl = fetch, now, log = () => {}, warn = () => {} }) {
  const state = loadState(stateDir);
  const kept = new Map(); // handle -> { fetched_at, office }, only for a copy the state's rev names
  const known = new Map();
  const mode = full ? "full pass asked for" : !state ? "no state" : state.builder !== builder ? "a deploy changed the builder" : "incremental";
  if (mode === "incremental") {
    for (const h of handles) {
      const rev = state.revs[h];
      const copy = REV_RE.test(rev ?? "") ? readJson(keptPath(stateDir, h)) : null;
      // the kept copy must be the answer the rev names: the office's own `rev` key rides in it
      if (copy?.office && copy.office.rev === rev) { kept.set(h, copy); known.set(h, rev); }
    }
  }
  const { doorsteps, inBulk, bulkBodies } = await readDoorsteps(handles, { apiBase, fetchImpl, now, known: known.size ? known : null });
  const revs = {};
  const stats = { mode, residents: handles.length, asked_known: known.size, carried: 0, fetched: 0, wrote: 0, kept: 0, stale: 0, inBulk };
  const keep = (handle, fetchedAt, office) => writeIfChanged(keptPath(stateDir, handle), JSON.stringify({ fetched_at: fetchedAt, office }) + "\n");
  for (const handle of handles) {
    let row = doorsteps.get(handle);
    if (row.error) {
      // the previous files stay, and so does their rev: the kept copy is still the answer it names
      if (known.has(handle)) revs[handle] = known.get(handle);
      stats.stale++;
      warn(`WARN doorstep: ${handle} — office unreachable (${row.error}); previous file kept, its own stamp discloses its age`);
      continue;
    }
    const jsonPath = join(dir, `${handle}.json`), mdPath = join(dir, `${handle}.md`);
    let office = null, fetchedAt = row.fetchedAt, carried = false;
    if (row.unchanged) {
      office = patchGlobal(kept.get(handle).office, row.global);
      if (office) carried = true;
      else {
        // the kept body can't take the leaves it was handed: read this one whole
        try { row = await readDoorstep(handle, { apiBase, fetchImpl, now }); office = row.body; fetchedAt = row.fetchedAt; }
        catch (e) { stats.stale++; if (known.has(handle)) revs[handle] = known.get(handle); warn(`WARN doorstep: ${handle} — office unreachable (${e.message}); previous file kept, its own stamp discloses its age`); continue; }
      }
    } else office = row.body;

    if (carried) {
      // the stamp it already had: if nothing else moved, nothing is written
      const held = build(handle, office, kept.get(handle).fetched_at ?? fetchedAt);
      if (held.json === readText(jsonPath) && held.md === readText(mdPath)) {
        stats.kept += 2; stats.carried++; revs[handle] = row.rev;
        keep(handle, kept.get(handle).fetched_at ?? fetchedAt, office);
        continue;
      }
    }
    const files = build(handle, office, fetchedAt);
    for (const [path, text] of [[jsonPath, files.json], [mdPath, files.md]]) writeIfChanged(path, text) === "wrote" ? stats.wrote++ : stats.kept++;
    if (carried) { stats.carried++; revs[handle] = row.rev; keep(handle, fetchedAt, office); }
    else {
      stats.fetched++;
      if (bulkBodies.has(handle) && REV_RE.test(office.rev ?? "")) { revs[handle] = office.rev; keep(handle, fetchedAt, office); }
    }
  }
  writeIfChanged(join(stateDir, "state.json"), JSON.stringify({ builder, revs: Object.fromEntries(Object.entries(revs).sort(([a], [b]) => a.localeCompare(b))) }, null, 1) + "\n");
  log(`doorstep: ${stats.mode}: ${stats.carried} carried over, ${stats.fetched} fetched whole, ${stats.stale} kept stale; ${stats.wrote} files written, ${stats.kept} unchanged`);
  return { revs, stats, doorsteps, bulkBodies };
}
