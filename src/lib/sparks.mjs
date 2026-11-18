// sparks.mjs — the Sparks catalogue and detail routes (CORE-121, Darko's look 2026-11-18: "sparks layout looks good ... each card could be clicked to get the full info").
//
// A Spark is the producer's common view (POS-1035 v1 / World LOGOS/classes.md § The spark): `{ id, credit, body, accepted, recounting?, picture?, experienced_*,
// rooms?, event?, circle?… }`. This module only COLLECTS the ones the site has been served and names where each one lives; it never decides what is
// accepted (a view with `accepted === false` is a pending/refused/withdrawn REFERENCE and is not a Spark here), never derives membership from rooms or
// the clock, and never invents an id, an event or a place.
//
// WHERE THE CATALOGUE COMES FROM, today: every accepted Spark the event reads carry (the public completion collection and the accepted gallery), de-duplicated
// by id in the order the producer served them. That is NOT a complete eventless catalogue: no anonymous read of every accepted Spark exists yet, so the page
// says exactly that (`CATALOGUE_WORDS.partial`) instead of presenting this list as all of them. `extra` is the one place a named producer source plugs in
// later (an array of accepted common views, producer order, read first); nothing in the browser stands in for it.

import { allEventViews, eventHref, eventParams, eventForPage, evidenceRead, pictureOf } from "./calendar.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isId = (v) => typeof v === "string" && v.trim() !== "";

/** The canonical detail address of a Spark, from its producer id (any non-empty string; each `/`-separated part encoded), or null. */
export function sparkHref(id) {
  if (!isId(id)) return null;
  return `/sparks/${id.split("/").map(encodeURIComponent).join("/")}/`;
}

/** The static-path parameter for a Spark's detail page (a rest route: the id as served, `/`-joined), or null for an id that cannot be a path. */
export function sparkParam(id) {
  if (!isId(id)) return null;
  const parts = id.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join("/");
}

/** Accepted common views only (a reference `{ id, accepted:false, status }` is not a Spark to open). */
const accepted = (x) => isObj(x) && isId(x.id) && x.accepted !== false;

/**
 * Every Spark the site has been served, once each, in the producer's order: `extra` first (a named catalogue source, when there is one), then each event's
 * completion collection and gallery as the event reads carry them.
 *
 * Each entry: `{ id, spark, eventId, seenIn, href, origin }` where `eventId` is the Spark's own `event` field as served (never worked out from a room), `seenIn` the event read that served it, `href` its
 * canonical detail address, and `origin` where this build learned of it ("catalogue" | "completion" | "gallery").
 */
export function collectSparks(calendar, events, extra = []) {
  const seen = new Map();
  const add = (spark, origin, eventId = null) => {
    if (!accepted(spark) || seen.has(spark.id) || !sparkParam(spark.id)) return;
    const own = isId(spark.event) ? spark.event : null;
    // `eventId` is the Spark's OWN tie (its `event` field); `seenIn` is only the event read that served it (a gallery Spark is a room's, not necessarily the event's)
    seen.set(spark.id, { id: spark.id, spark, eventId: own, seenIn: eventId, href: sparkHref(spark.id), origin });
  };
  for (const s of Array.isArray(extra) ? extra : []) add(s, "catalogue");
  for (const e of allEventViews(calendar, events)) {
    const ev = eventForPage(e, events)?.evidence;
    if (!isObj(ev)) continue;
    for (const s of Array.isArray(ev.sparks) ? ev.sparks : []) add(s, "completion", e.id);
    for (const s of Array.isArray(ev.gallery?.sparks) ? ev.gallery.sparks : []) add(s, "gallery", e.id);
  }
  return [...seen.values()];
}

/** The drawn filters, as predicates over an entry (the page's buttons and its tests read this one table). */
export const SPARK_FILTERS = Object.freeze([
  { key: "all", label: "All accepted", test: () => true },
  { key: "events", label: "From events", test: (e) => e.eventId !== null },
  { key: "none", label: "Without an event", test: (e) => e.eventId === null },
  { key: "picture", label: "With a picture", test: (e) => pictureOf(e.spark) !== null },
]);

/** The event a Spark names, as a page the site builds (null when it names none, or names one this build has no page for). */
export function eventOfSpark(entry, calendar, events) {
  if (!entry?.eventId || !eventParams(entry.eventId)) return null;
  const e = allEventViews(calendar, events).find((x) => x.id === entry.eventId);
  return e ? { event: eventForPage(e, events), href: eventHref(e.id), read: evidenceRead(e, events) } : null;
}

export const CATALOGUE_WORDS = Object.freeze({
  title: "Sparks",
  lead: "Moments the town kept. Every accepted Spark appears here, whether it came from an event, from a room, or from no event at all.",
  partial: "This list is the accepted Sparks the town's event pages carry. A complete list of every accepted Spark, including those with no event, cannot be read yet, so Sparks made outside an event may be missing here.",
  none: "No accepted Sparks are listed here yet.",
  noMatch: "No Spark here matches this filter.",
  flares: "Flares from this spark",
  flaresNone: "None yet. When someone posts a flare from this Spark, it will be linked here.",
});
