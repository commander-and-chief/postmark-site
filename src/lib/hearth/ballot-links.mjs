// ballot-links.mjs — where a Hearth ballot's choice is SEEN: its live preview on its author's own house (POS-1066 A).
//
// Darko, 2026-11-15 19:59 EST, on the friction of seeing a design on a Hearth and leaving to stake: direct design links, and backing from
// the Hearth, "por qué no los dos". Wright 01:03:33Z (Darko 20:03 EST: "Yeah, I agree with hotfix"): "the 'See it' links on every Hearth
// ballot choice (the civic panel and `/votes/`)".
//
// WHAT A LINK IS. `/households/<the author's house>/?entry=<design>`: the design, drawn live on the house that made it (a preview: nothing is
// saved, which-design.mjs). It is built HERE, at build, from two things this build already holds and nothing a reader or the office sends:
//   · the registered entries (registry.mjs), so a link is drawn only for a design this build can draw: a design the site does not know
//     would preview as the default under a note, which is not "the named design", so it gets no preview link;
//   · the households (household.mjs), so the house is the author's own and its address is the route's (houses.mjs § houseHref: a key over
//     96 bytes is a hashed path, so a link is never rebuilt from the key).
// WHOSE HOUSE. An entry's `author` (hearth.md) is "your handle, or your household's slug" (the town's PROJECTS/household-hearths/README.md).
// So: a declared household's key is that house; a resident's handle is the declared house they live in; Postmark's own designs (author
// `postmark`, the six on the ballot) are the founders' house, Starforge. Anything else (an undeclared house of one, a name nobody holds)
// has NO link: never the house the reader happens to be on, never a guess.
//
// WHICH BALLOT. Only the Hearth ballot's choices are designs: its topic is `hearth-default` (the town's WHITE_PAGES/ballot-hearth-default.json,
// "Postmark's default Hearth: which design should every new house open in?"). A choice on any other ballot that happens to share a design's
// name ("default") is not a design and gets nothing from here.

import { houseHref } from "../houses.mjs";
import { ENTRY_ID } from "./slots.mjs";

/** The Hearth ballot's topic, as the office and the town's ballot file name it. */
export const HEARTH_BALLOT_TOPIC = "hearth-default";
/** The author Postmark's own designs carry (hearth.md `author: postmark`). */
export const POSTMARK_AUTHOR = "postmark";
/** The founders' household (the town's release notes w46: "Starforge gives like any household. The founders' household ..."; the office's
 *  arrival-invite.mjs once held FOUNDERS = ["starforge", "the-town"], and the-town is not a house). Postmark's designs are seen there. */
export const FOUNDERS_HOUSE = "starforge";


/**
 * The declared house an entry's author names, or null. `houses` is every declared house (household.mjs § declaredHouses: `{ slug, path,
 * declared }`, slug being the registry key); `houseOf(handle)` is household.mjs § houseOf.
 */
export function authorHouse(author, { houses = [], houseOf = () => null } = {}) {
  const a = typeof author === "string" ? author.trim() : "";
  if (!a) return null;
  const key = a === POSTMARK_AUTHOR ? FOUNDERS_HOUSE : a;
  const declared = houses.find((h) => h?.declared && h.slug === key);
  if (declared) return declared;
  if (a === POSTMARK_AUTHOR) return null;                        // the founders' house is not in this build: no link, not a guess
  const lives = houseOf(a);
  return lives?.declared && lives.slug ? lives : null;
}

/** `{ [design]: href }` for every registered entry whose author has a declared house. Built at build; nothing here is a reader's. */
export function previewHrefs(entries, lookups) {
  const out = {};
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !ENTRY_ID.test(String(e.id ?? ""))) continue;
    const href = houseHref(authorHouse(e.author, lookups));
    if (href) out[e.id] = `${href}?entry=${encodeURIComponent(e.id)}`;
  }
  return out;
}

// the only shape a preview link may have when it is read back in the browser: a house page on this site, one design
const PREVIEW_HREF = /^\/households\/[A-Za-z0-9._~-]+\/\?entry=[a-z0-9][a-z0-9-]{0,39}$/;

/** The map as the page carries it (a data attribute's JSON), read back: only well-formed own-design links survive, own keys only. */
export function readPreviews(text) {
  let raw = null;
  try { raw = JSON.parse(String(text ?? "")); } catch { return {}; }
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, href] of Object.entries(raw)) {
    if (ENTRY_ID.test(id) && typeof href === "string" && PREVIEW_HREF.test(href) && href.endsWith(`?entry=${id}`)) out[id] = href;
  }
  return out;
}

/** The live preview to link a ballot's choice to, or null: only on the Hearth ballot, only for a design this build registers. */
export function seeItHref(previews, topic, candidate) {
  if (topic !== HEARTH_BALLOT_TOPIC || typeof candidate !== "string") return null;
  return previews && Object.hasOwn(previews, candidate) ? previews[candidate] : null;
}
