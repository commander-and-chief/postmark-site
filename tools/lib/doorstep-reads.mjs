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
 * `&known=handle:rev,…`, and the office answers `{ handle, unchanged: true, rev }` for a match instead of the
 * body, with the five town-wide leaves once as `global`. An unchanged row is `{ unchanged: true, rev, global, fetchedAt }`
 * (the moment the office said so). A chunk whose unchanged rows come without a `global` is not trusted: it is read
 * singly, whole. `bulkBodies` names the handles whose whole body came through the bulk read, so a caller records
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
      try {
        const held = known ? chunk.filter((h) => known.has(h)).map((h) => `${h}:${known.get(h)}`) : [];
        const res = await fetchImpl(`${apiBase}/doorsteps?handles=${chunk.join(",")}${held.length ? `&known=${held.join(",")}` : ""}`, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
        if (res.status === 404) bulk = false; // an office with no bulk door
        else if (res.ok) {
          const body = await res.json();
          const at = now();
          const heldRev = (d) => known?.get(d.handle);
          const whole = Array.isArray(body?.doorsteps) && body.doorsteps.length === chunk.length
            && body.doorsteps.every((d, j) => d?.handle === chunk[j])
            // an unchanged row is believed only for a rev this caller sent, and only with the town-wide leaves beside it
            && body.doorsteps.every((d) => d.unchanged !== true || (heldRev(d) !== undefined && d.rev === heldRev(d) && body.global && typeof body.global === "object"));
          if (whole) answered = { rows: body.doorsteps, at, global: body.global ?? null };
        }
      } catch { /* this chunk is read singly */ }
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
