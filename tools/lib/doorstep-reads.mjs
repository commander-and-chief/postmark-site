// doorstep-reads.mjs — every resident's doorstep from the office, in bulk where
// the office has the bulk read, one by one where it does not (2026-10-13).
//
// extract-town.mjs asked `GET /doorstep/<handle>` once per resident: 259
// requests a pass on the box. The office now answers `GET /doorsteps?handles=`
// with up to 25 at once, each exactly what the single door answers a keyless
// caller, and null where that door says 404. An older office has no such door
// (it answers 404, "no such door"), and then every doorstep is read singly, as
// before. A bulk read that fails any other way falls back to single reads for
// that chunk only.
//
// Each answer is returned with the moment it arrived: the clock is read once
// per response, immediately after the body parses. That is the only true
// answer-time the file can carry, because the office stamps its bundle with a
// commit sha rather than a time. A failed handle carries its reason instead,
// and the caller keeps that resident's previous file.

export const DOORSTEPS_PER_READ = 25;

/**
 * The version of the office's `global` part this reader can patch (office src/doorstep-rev.mjs § GLOBAL_VERSION): the five
 * as_of-derived leaves and the town-wide blocks (`global.town_wide`). Sent as `&global=2` beside `known`; an office that does not
 * know it ignores `known` or answers a `global` without this version, and neither is believed (see readDoorsteps).
 */
export const GLOBAL_VERSION = 2;

const HEADERS = { "user-agent": "starforge-atelier-extractor", accept: "application/json" };

/** One doorstep from the single door: `{ body, fetchedAt }`, or a throw naming why not. */
export async function readDoorstep(handle, { apiBase, fetchImpl = fetch, now = () => new Date().toISOString() }) {
  const res = await fetchImpl(`${apiBase}/doorstep/${handle}`, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body !== "object" || body.handle !== handle) {
    throw new Error(`the door answered for "${body?.handle}", not "${handle}"`);
  }
  return { body, fetchedAt: now() };
}

/**
 * Every named doorstep: `{ doorsteps: Map handle → { body, fetchedAt } | { error } | { unchanged, rev, global, fetchedAt }, inBulk }`,
 * where `inBulk` counts the handles the office's bulk read answered.
 *
 * `known` (POS-1086, office w47.12): a Map handle → rev the caller holds. The bulk read sends it as
 * `&known=handle:rev,…&global=2`, and the office answers `{ handle, unchanged: true, rev }` for a match instead of the
 * body, with the five town-wide leaves and the town-wide blocks (copy, next_crossing, bulletin, town_pulse, psa, town)
 * once as `global`. An unchanged row is `{ unchanged: true, rev, global, fetchedAt }` (the moment the office said so).
 * A chunk whose unchanged rows come without a `global` of version 2 holding `town_wide` is not trusted: it is asked
 * again without `known`, and so answered whole. `bulkBodies` names the handles whose whole body came through the bulk read, so a caller records
 * revs only from the bulk read. An office with no `known` ignores it and answers whole bodies.
 */
export async function readDoorsteps(handles, { apiBase, fetchImpl = fetch, now = () => new Date().toISOString(), per = DOORSTEPS_PER_READ, known = null } = {}) {
  const doorsteps = new Map();
  let bulk = true;
  let inBulk = 0;
  const bulkBodies = new Set(); // handles whose whole body came through the bulk read (the only reads a rev is kept from)
  const single = async (handle) => {
    try { doorsteps.set(handle, await readDoorstep(handle, { apiBase, fetchImpl, now })); }
    catch (e) { doorsteps.set(handle, { error: e.message }); }
  };
  for (let i = 0; i < handles.length; i += per) {
    const chunk = handles.slice(i, i + per);
    let answered = null;
    if (bulk) {
      const held = known ? chunk.filter((h) => known.has(h)).map((h) => `${h}:${known.get(h)}`) : [];
      // With a rev to claim, the chunk is asked with `known` first; an office whose `unchanged` rows cannot be trusted (an older
      // office: no `global.town_wide`) is asked again without it, so it answers whole bodies in one read, not 25 single ones.
      for (const claim of held.length ? [held, []] : [[]]) {
        if (answered || !bulk) break;
        try {
          const res = await fetchImpl(`${apiBase}/doorsteps?handles=${chunk.join(",")}${claim.length ? `&known=${claim.join(",")}&global=${GLOBAL_VERSION}` : ""}`, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
          if (res.status === 404) bulk = false; // an office with no bulk door
          else if (res.ok) {
            const body = await res.json();
            const at = now();
            const heldRev = (d) => (claim.length ? known?.get(d.handle) : undefined);
            const g = body?.global;
            // the town-wide blocks the office hands back once: believed only at the version this reader patches
            const patchable = g && typeof g === "object" && g.version === GLOBAL_VERSION && g.town_wide && typeof g.town_wide === "object";
            const whole = Array.isArray(body?.doorsteps) && body.doorsteps.length === chunk.length
              && body.doorsteps.every((d, j) => d?.handle === chunk[j])
              // an unchanged row is believed only for a rev this caller sent, and only with the town-wide leaves and blocks beside it
              && body.doorsteps.every((d) => d.unchanged !== true || (heldRev(d) !== undefined && d.rev === heldRev(d) && patchable));
            if (whole) answered = { rows: body.doorsteps, at, global: body.global ?? null };
          }
        } catch { break; /* this chunk is read singly */ }
      }
    }
    if (!answered) { for (const handle of chunk) await single(handle); continue; }
    inBulk += chunk.length;
    for (const { handle, doorstep, unchanged, rev } of answered.rows) {
      if (unchanged === true) doorsteps.set(handle, { unchanged: true, rev, global: answered.global, fetchedAt: answered.at });
      else if (!doorstep) doorsteps.set(handle, { error: "HTTP 404" });
      else if (doorstep.handle !== handle) doorsteps.set(handle, { error: `the door answered for "${doorstep.handle}", not "${handle}"` });
      else { doorsteps.set(handle, { body: doorstep, fetchedAt: answered.at }); bulkBodies.add(handle); }
    }
  }
  return { doorsteps, inBulk, bulkBodies };
}
