// hearth-ballot-links.test.mjs — a Hearth ballot's "see it" is the design's live preview on its author's own house (POS-1066 A).
//
//   node --test test/hearth-ballot-links.test.mjs
//
// Wright 01:03:33Z (Darko 2026-11-15 20:03 EST: "Yeah, I agree with hotfix"): "Build A and B as written above: the 'See it' links on every Hearth ballot
// choice (the civic panel and `/votes/`)". The brief's falsifier: links show the named design on the RIGHT house: the author's canonical house (the founders'
// house for Postmark's own designs), never the house being visited, an arbitrary address or a guessed owner; a route's slug can differ from its key.
// Invented houses and entries throughout (TEST-DESIGN: real records change under you). The rendered page, and that the link draws the named design, is
// test/hearth-backing-browser.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { authorHouse, previewHrefs, readPreviews, seeItHref, HEARTH_BALLOT_TOPIC, FOUNDERS_HOUSE, POSTMARK_AUTHOR } from "../src/lib/hearth/ballot-links.mjs";
import { buildHouses, housePath } from "../src/lib/houses.mjs";
import { panelHtml } from "../src/lib/ballot-panel.mjs";

// invented: the founders' house, a shared house, a house of one, and a key long enough that its route is a hashed path
const LONG = "the-very-long-household-key-that-runs-past-the-route-limit-of-ninety-six-bytes-and-keeps-going-on";
const RESIDENTS = ["wren", "pell", "moss", "oriel", "tamsin", "loner"].map((handle) => ({ handle }));
const REGISTRY = { households: {
  [FOUNDERS_HOUSE]: { residents: ["wren"] },
  "lantern-row": { name: "Lantern Row", residents: ["pell", "moss"] },
  [LONG]: { residents: ["oriel"] },
  "empty-house": { residents: ["nobody-ashore"] },
} };
const { houseOf, bySlug } = buildHouses(RESIDENTS, REGISTRY);
const lookups = { houses: [...bySlug.values()], houseOf: (h) => houseOf.get(h) };
const entry = (id, author) => ({ id, author });

test("whose house: a household key is that house, a handle is the house it lives in, Postmark's own designs are the founders' house", () => {
  assert.equal(POSTMARK_AUTHOR, "postmark");
  assert.equal(FOUNDERS_HOUSE, "starforge", "the founders' household, as the town's release notes name it");
  assert.equal(authorHouse("postmark", lookups)?.slug, FOUNDERS_HOUSE);
  assert.equal(authorHouse("lantern-row", lookups)?.slug, "lantern-row", "an author that is a household key");
  assert.equal(authorHouse("moss", lookups)?.slug, "lantern-row", "an author that is a resident's handle: the house they live in");
  assert.equal(authorHouse("oriel", lookups)?.slug, LONG);
  // and NOTHING is guessed: an undeclared house of one, a name nobody holds, a declared house with nobody ashore, an empty author
  for (const nobody of ["tamsin", "loner", "a-stranger", "empty-house", "", null, undefined, 7]) assert.equal(authorHouse(nobody, lookups), null, String(nobody));
  // without the founders' house in the build, Postmark's designs get no house: never another house standing in for it
  assert.equal(authorHouse("postmark", { houses: lookups.houses.filter((h) => h.slug !== FOUNDERS_HOUSE), houseOf: lookups.houseOf }), null);
});

test("a preview link is the ROUTE's address for the author's house, plus the design: a long key's hashed path, never the key", () => {
  const map = previewHrefs([entry("ember", "postmark"), entry("quill", "moss"), entry("vellum", "oriel"), entry("stray", "a-stranger"), entry("Bad Id", "postmark")], lookups);
  assert.deepEqual(Object.keys(map).sort(), ["ember", "quill", "vellum"], "a design whose author has no declared house, or whose id is not an entry id, gets no link");
  assert.equal(map.ember, "/households/starforge/?entry=ember");
  assert.equal(map.quill, "/households/lantern-row/?entry=quill");
  assert.notEqual(housePath(LONG), LONG, "the fixture's long key really has a hashed route");
  assert.equal(map.vellum, `/households/${housePath(LONG)}/?entry=vellum`);
  assert.ok(!map.vellum.includes(LONG), "never the key itself, which 404s");
});

test("read back in the browser, only the build's own shape survives: a house page on this site and one design", () => {
  const good = { ember: "/households/starforge/?entry=ember", quill: "/households/lantern-row/?entry=quill" };
  assert.deepEqual(readPreviews(JSON.stringify(good)), good);
  const bad = {
    a: "https://elsewhere.example/households/x/?entry=a", b: "javascript:alert(1)", c: "/households/x/?entry=other", d: "//evil/households/x/?entry=d",
    e: "/households/x/?entry=e&next=/", f: "/households/x\"><b>/?entry=f", "Not-An-Id": "/households/x/?entry=Not-An-Id", g: 7,
  };
  assert.deepEqual(readPreviews(JSON.stringify(bad)), {}, "every other address is dropped");
  for (const junk of ["", "null", "[]", "not json", undefined, '{"__proto__": "/households/x/?entry=__proto__"}']) assert.deepEqual(readPreviews(junk), {}, String(junk));
});

test("only the Hearth ballot's choices link, and only to a design the map holds", () => {
  const previews = { default: "/households/starforge/?entry=default" };
  assert.equal(HEARTH_BALLOT_TOPIC, "hearth-default", "the town's WHITE_PAGES/ballot-hearth-default.json");
  assert.equal(seeItHref(previews, "hearth-default", "default"), previews.default);
  assert.equal(seeItHref(previews, "harbor-lantern", "default"), null, "a choice on another ballot that shares a design's name is not a design");
  assert.equal(seeItHref(previews, "hearth-default", "unregistered"), null, "a design this build cannot draw would preview as the default: no link");
  assert.equal(seeItHref(previews, "hearth-default", "toString"), null, "own keys only");
  assert.equal(seeItHref(null, "hearth-default", "default"), null);
});

test("the civic panel: a Hearth ballot design links to its preview beside its name; other ballots and unknown designs keep no link", () => {
  const previews = { ember: "/households/starforge/?entry=ember", quill: "/households/lantern-row/?entry=quill" };
  const data = { topics: [
    { topic: "hearth-default", title: "The default Hearth", status: "staking", candidates: [{ candidate: "ember", staked: 4, link: "https://github.com/x" }, { candidate: "quill", staked: 2 }, { candidate: "fresh", staked: 0 }] },
    { topic: "harbor-lantern", title: "Pick the lantern", status: "staking", candidates: [{ candidate: "ember", staked: 1 }] },
  ] };
  const html = panelHtml(data, { previews });
  const links = [...html.matchAll(/<a class="bp-see" href="([^"]*)" data-hearth-preview="([^"]*)">see it →<\/a>/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(links, [["ember", previews.ember], ["quill", previews.quill]], "exactly the Hearth ballot's registered designs");
  const lantern = html.slice(html.indexOf('data-ballot="harbor-lantern"'));
  assert.doesNotMatch(lantern, /<a /, "the other ballot's 'ember' is not a design");
  assert.doesNotMatch(html, /github\.com/, "the office's own link is still never drawn on the panel");
  assert.doesNotMatch(panelHtml(data), /<a /, "no map, no links: the panel as #435 drew it");
});
