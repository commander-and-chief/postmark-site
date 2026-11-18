// reads.mjs — EVERY fetch the household page makes, behind one call (POS-260).
//
// The page asks `readHouse(handles, { key, token, mine, onProgress })` and nothing else. That is FOUR requests (CORE-113):
//
//   GET /household?read=house&household={key}&full=true
//                                 the whole house in one answer (POS-276, POS-1070, POS-1084): each resident's own mail
//                                 (inbox), awaiting, stamps, window.pane, own stance count, holds and, with the house's
//                                 own bearer, your_pending_letters; the house-scoped stakes and outcomes once; and every
//                                 declared member's public outbox and quest board
//   GET /world/walkers            where each one stands (one read for the town)
//   GET /world/conversations      what each one said (one read for the town)
//   GET /calendar                 the coming-up section — the office serves /calendar (POS-207)
//
// It used to be 3N more (a doorstep, an outbox and a quest board per resident): nine residents were 27 requests, and on a busy
// box each doorstep alone took seconds. The aggregate is projected back into the same shape (`projectHouse`), so nothing outside
// this file moves. That is why no other module on the page may call fetch.
//
// Every read fails soft: a door that does not answer is null, and the page
// leaves out what that door would have filled rather than guessing at it.

import { bundleUrl, bundleFrom } from "../hearth/bundle.mjs";

// The cockpit's resolution (WorldCockpit.astro): a postmark.town host talks to
// its own /api; any other host (a local build, a preview) reads the live office.
export function officeOrigin(loc = typeof location !== "undefined" ? location : null) {
  const host = loc?.hostname ?? "";
  return host === "postmark.town" || host.endsWith(".postmark.town")
    ? loc.origin + "/api"
    : "https://postmark.town/api";
}

async function getJSON(url, token) {
  try {
    const headers = { accept: "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    const r = await fetch(url, { headers });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** The one aggregate read's URL: the house by its canonical key (the registry's slug, never the page's display name), whole. */
export const houseUrl = (api, key) => `${api}/household?read=house&household=${encodeURIComponent(key)}&full=true`;

/**
 * The house aggregate, projected into the per-resident maps the page folds (fold.mjs reads `reads.doorsteps?.[h]`, `outboxes`, `quests`).
 * PURE. `handles` is the page's house order; `agg` is the parsed answer, or null when the office did not answer, refused, or answered with
 * something that is not a house.
 *
 *   doorsteps[h]  that resident's own segments as the aggregate carries them under `residents[h]` (mail, awaiting, stamps, window, own stance
 *                 count, holds, and — only when the office's own owner gate gave them — your_pending_letters), plus the clock every doorstep
 *                 carried. null for a declared member the office holds no resident for (not ashore) and for every resident when the aggregate
 *                 did not answer: "did not answer", never a guessed zero.
 *   outboxes[h], quests[h]  the public companions, keyed by every DECLARED member (ashore or not); null when the aggregate did not answer.
 *
 * THE HOUSE-SCOPED BLOCKS ARE CARRIED ONCE, NEVER AS EACH RESIDENT'S OWN. The aggregate's `stakes` (the house's at-risk count and the settlement
 * clock) and `outcomes` (the crossings' decisions about the house's marks) are asked for the whole house, so a house total copied onto every resident would be
 * summed N times by the folds that add resident figures (fold.mjs § clocksOf, needsOf). They ride the first resident the office holds, in house order,
 * under the doorstep's own names, and keep their own `scope` list, which says they are the house's. A resident's own figures (stances, holds,
 * stamps, mail) are never the house's.
 */
export function projectHouse(handles, agg) {
  const ok = agg && typeof agg === "object" && agg.residents && typeof agg.residents === "object";
  const doorsteps = {}, outboxes = {}, quests = {};
  let carrier = null; // the first resident the office holds
  for (const h of handles) {
    const r = ok ? agg.residents[h] : null;
    if (r && typeof r === "object") {
      doorsteps[h] = { ...r, ...(agg.next_crossing ? { next_crossing: agg.next_crossing } : {}) };
      carrier ??= h;
    } else doorsteps[h] = null;
    outboxes[h] = ok ? (agg.outboxes?.[h] ?? null) : null;
    quests[h] = ok ? (agg.quests?.[h] ?? null) : null;
  }
  if (carrier) {
    if (agg.stakes && typeof agg.stakes === "object") doorsteps[carrier].stakes = agg.stakes;
    if (agg.outcomes && typeof agg.outcomes === "object") doorsteps[carrier].outcomes = agg.outcomes;
  }
  return { doorsteps, outboxes, quests };
}

// WHAT HAS ANSWERED SO FAR (POS-984). Every read starts at once and none waits on another, but the page need not wait for the
// slowest: the house-wide reads (walkers, conversations, calendar) and the house aggregate land on their own, so the answer is
// handed out as it grows. A snapshot is the same shape as the finished answer plus two lists that say what is still out:
//   pending   the residents the aggregate has not answered for yet, in the house's own order (all of them until it settles, none after)
//   waiting   the house-wide reads not landed yet ("walkers", "conversations", "calendar")
// If the aggregate settled and failed, nobody is pending: every doorstep is null, the same "did not answer" as ever. A pending
// resident has no entry yet; both read as "nothing from them" to a consumer that indexes `reads.doorsteps?.[h]`, and `pending` is
// how a painter tells "still coming" from "did not answer".

/**
 * @param {string[]} handles   the house's residents
 * @param {{ key?: string|null, token?: string|null, mine?: string[], onProgress?: ((snapshot: object) => void)|null }} opts
 *        key: the house's CANONICAL key (the registry's slug; Hearth's data-hearth-key), distinct from the page's display slug. With none,
 *        the aggregate cannot be asked and the house reads as did-not-answer: there is no per-resident fallback.
 *        token: the reader's bearer, sent only on the ONE aggregate and only when the reader's own sign-in holds a resident of this house
 *        (`mine`); never on the town-wide reads. The office's own owner gate stays what decides which residents' private segments come back.
 *        onProgress: told with a fresh snapshot each time the aggregate settles or a house-wide read lands
 * @returns {Promise<{ doorsteps, outboxes, quests, walkers, conversations, calendar, pending, waiting }>}
 *          the finished answer: `pending` and `waiting` are empty
 */
export async function readHouse(handles, { key = null, token = null, mine = [], onProgress = null } = {}) {
  const api = officeOrigin();
  const state = { doorsteps: {}, outboxes: {}, quests: {}, walkers: null, conversations: null, calendar: null };
  const pending = new Set(handles);
  const waiting = new Set(["walkers", "conversations", "calendar"]);
  // the maps are rebuilt in the house's own order, so what a snapshot holds never depends on who answered first
  const snapshot = () => {
    const done = handles.filter((h) => !pending.has(h));
    const of = (map) => Object.fromEntries(done.map((h) => [h, map[h]]));
    return {
      ...state,
      doorsteps: of(state.doorsteps), outboxes: of(state.outboxes), quests: of(state.quests),
      pending: handles.filter((h) => pending.has(h)),
      waiting: [...waiting],
    };
  };
  // a painter that throws on a partial answer must not take the rest of the reads down with it
  const tell = () => {
    if (!onProgress) return;
    try { onProgress(snapshot()); } catch (err) { console.error("readHouse: onProgress threw", err); }
  };
  // THE ONE HOUSE READ. The bearer rides it only for a reader whose sign-in holds one of this house's residents; for everyone else it is the
  // public aggregate, which the office answers without any owner-only segment.
  const house = async () => {
    const agg = key ? await getJSON(houseUrl(api, key), token && mine.length ? token : null) : null;
    Object.assign(state, projectHouse(handles, agg));
    pending.clear();
    tell();
  };
  const wide = async (name, url) => {
    state[name] = await getJSON(url);
    waiting.delete(name);
    tell();
  };
  await Promise.all([
    house(),
    wide("walkers", `${api}/world/walkers`),
    wide("conversations", `${api}/world/conversations`),
    wide("calendar", `${api}/calendar`),
  ]);
  return snapshot();
}


/**
 * The office's public Hearth bundle for a named house (POS-1027; lib/hearth/bundle.mjs holds its shape). PUBLIC AND KEYLESS: no bearer is
 * ever sent, whoever is signed in, so what comes back is exactly what a signed-out visitor may read, and it is what a house's own script is
 * handed. null when the office did not answer, refused (the read is not shipped yet), or answered with something that is not a bundle.
 */
export async function readHearthBundle(key) {
  if (!key) return null;
  return bundleFrom(await getJSON(bundleUrl(officeOrigin(), key)));
}

/** The panes origin's live list of hung windows (the same answer the resident page reads): the handles with a window, or null when it did not answer. */
export const PANES_ORIGIN = "https://panes.postmark.town";
export async function readHungWindows(handles) {
  const m = await getJSON(`${PANES_ORIGIN}/windows.json`);
  if (!m || typeof m !== "object") return null;
  const have = m.windows && typeof m.windows === "object" ? m.windows : {};
  return handles.filter((h) => !!have[h]);
}

/**
 * What the Hearth reads beyond the dashboard's reads (POS-959): the town's
 * public posts by class, which the `posts` slot filters to the house's own.
 * Public and keyless, like every read above; a door that does not answer is
 * null, and the slot says it could not read, never that there is nothing.
 */
export async function readHearthExtras() {
  const api = officeOrigin();
  const [idea, bug] = await Promise.all(["idea", "bug"].map((c) => getJSON(`${api}/posts?class=${c}&limit=100`)));
  return { posts: { idea, bug } };
}
