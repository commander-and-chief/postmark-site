// human-pill.test.mjs — the household human's chosen profile, as the sub-rail's pill and the owner's way into the office's form (CORE-115).
//
// Darko, 2026-11-18 11:14 EST: "I think the pill next to the residents is the way to go". 2026-10-19: a name the human goes by in the town, "never private
// information"; the form is "Human only, like likeness". The Office keeps the record and the only writer (office src/human-profile.mjs); the site reads the
// three public fields (`town_name`, `short_line`, `pronouns`) and links to /oauth/human. These pin: the fold carries only those, the pill says only those
// (escaped, with the honest generic for a missing town name), the form link uses the CANONICAL slug and only a declared house has one, and the pill is
// placed after the chips in the ONE rail both hosts use, with the owner entry hidden like the "+".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildHouses, housePath } from "../src/lib/houses.mjs";
import { publicHumanProfile, humanPill, humanEntry, humanProfileLink, HUMAN_PROFILE_CAPS } from "../src/lib/human-profile.mjs";

const read = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
const R = (h) => ({ handle: h });

test("the fold carries the three public fields and no more: nothing of the private human or the row", () => {
  const registry = { households: {
    "lantern-row": { name: "Lantern Row", human: "A. Realname", accounts: [{ id: 1, login: "private-login" }], email: "x@example.test",
      human_profile: { town_name: "Marlow", pronouns: "they/them", short_line: "Keeps the lamps.", login: "private-login", human: "A. Realname", email: "x@example.test" },
      residents: ["rei", "jetto"] },
  } };
  const { bySlug, houseOf } = buildHouses([R("rei"), R("jetto")], registry);
  const house = bySlug.get("lantern-row");
  assert.deepEqual(house.humanProfile, { town_name: "Marlow", short_line: "Keeps the lamps.", pronouns: "they/them" });
  assert.equal(houseOf.get("rei"), house);
  assert.ok(!("human" in house), "the private name still never enters the fold");
  const text = JSON.stringify(house);
  for (const leak of ["A. Realname", "private-login", "x@example.test"]) assert.ok(!text.includes(leak), `${leak} is not on the house`);
});

test("a house that chose nothing has no profile; a house of one with no declaration has none and no entry", () => {
  const { bySlug, houseOf } = buildHouses([R("rei"), R("solo")], { households: { quiet: { name: "Quiet", residents: ["rei"] } } });
  assert.equal(bySlug.get("quiet").humanProfile, null);
  assert.equal(humanPill(bySlug.get("quiet"), "Quiet"), null, "no pill for the public to see");
  const solo = houseOf.get("solo");
  assert.equal(solo.declared, false);
  assert.equal(humanPill(solo, ""), null);
  assert.equal(humanEntry(solo), null, "no guessed form target for a house with no canonical slug");
});

test("publicHumanProfile: only the three keys, one line of trimmed text, cut at the office's caps; anything else is nothing", () => {
  assert.equal(publicHumanProfile(null), null);
  assert.equal(publicHumanProfile("text"), null);
  assert.equal(publicHumanProfile([]), null);
  assert.equal(publicHumanProfile({}), null);
  assert.equal(publicHumanProfile({ town_name: "  ", pronouns: 3, login: "x" }), null);
  assert.deepEqual(publicHumanProfile({ pronouns: " she/her ", extra: "no" }), { pronouns: "she/her" });
  assert.deepEqual(publicHumanProfile({ short_line: "one\nline here‮" }), { short_line: "one line here" }, "a break or a direction control is a space, never kept");
  const out = publicHumanProfile({ town_name: "n".repeat(200), short_line: "s".repeat(500), pronouns: "p".repeat(100) });
  assert.deepEqual(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].length])), HUMAN_PROFILE_CAPS);
});

test("the pill: the chosen town name and pronouns, the short line its tooltip; a missing town name reads the honest generic, never a login", () => {
  const house = (humanProfile) => ({ declared: true, slug: "lantern-row", humanProfile });
  assert.deepEqual(humanPill(house({ town_name: "Marlow", pronouns: "they/them", short_line: "Keeps the lamps." }), "Lantern Row"),
    { name: "Marlow", pronouns: "they/them", tip: "Keeps the lamps." });
  assert.deepEqual(humanPill(house({ town_name: "Marlow" }), "Lantern Row"), { name: "Marlow", pronouns: null, tip: "Lantern Row's human" });
  assert.deepEqual(humanPill(house({ pronouns: "she/her" }), "Lantern Row"), { name: "Lantern Row's human", pronouns: "she/her", tip: "Lantern Row's human" });
});

test("the owner's entry: the office's own form, by the canonical registry slug (not the display path), even before a profile is set", () => {
  const slug = "x".repeat(120);   // a long key: its page path is hashed, its registry key is not
  assert.notEqual(housePath(slug), slug);
  const { bySlug } = buildHouses([R("rei")], { households: { [slug]: { name: "Long", residents: ["rei"] } } });
  const house = bySlug.get(housePath(slug));
  assert.equal(house.slug, slug);
  const entry = humanEntry(house);
  assert.equal(entry.href, `https://postmark.town/api/oauth/human?household=${slug}`);
  assert.equal(entry.set, false, "reachable before a profile is set");
  assert.ok(!entry.href.includes(housePath(slug)));
  assert.equal(humanProfileLink("a b&c"), "https://postmark.town/api/oauth/human?household=a%20b%26c", "the slug is encoded, never trusted as a URL part");
  assert.equal(humanEntry({ ...house, humanProfile: { pronouns: "he/him" } }).set, true);
});

test("one rail, both hosts: the pill sits after the resident chips and the entry ships hidden, shown by each host's own owner check", () => {
  const rail = read("src/components/HouseRail.astro");
  const at = (s) => { const i = rail.indexOf(s); assert.ok(i > 0, `HouseRail has ${s}`); return i; };
  assert.ok(at("{faces.map(") < at("{arriving.map("), "the chips come first");
  assert.ok(at("{arriving.map(") < at("<span class=\"pm-human\" data-house-human"), "the pill comes after the resident chips");
  assert.ok(at("<span class=\"pm-human\" data-house-human") < at("data-house-human-edit href"), "then the owner's entry");
  assert.ok(at("data-house-human-edit href") < at("<a class=\"pm-subrail-add\""), "before the + ");
  assert.match(rail, /<a class="pm-subrail-human" data-house-human-edit href=\{entry\.href\} hidden/, "shipped hidden");
  assert.match(rail, /\{pill && \(/, "no pill for a house that chose nothing");
  assert.match(rail, /\{entry && \(/, "no entry without a canonical slug");
  assert.ok(!/set:html|innerHTML/.test(rail), "the chosen words are escaped as text");
  for (const host of ["src/components/hearth/Hearth.astro", "town/components/Household.astro"]) assert.match(read(host), /<HouseRail /, `${host} draws the one rail`);
  assert.match(read("src/lib/hearth/stage.mjs"), /\[data-hearth-own\], \[data-house-add\], \[data-house-human-edit\]/, "household page: the owner check shows it");
  assert.match(read("town/components/Household.astro"), /querySelectorAll\("\[data-house-add\], \[data-house-human-edit\]"\)/, "resident page: the owner check shows it");
});

test("the site writes nothing: no POST, key or token reaches the profile, and the link is the office's form", () => {
  const files = ["src/components/HouseRail.astro", "src/lib/human-profile.mjs"].map(read).join("\n");
  assert.ok(!/fetch\(|method:\s*["']P|authorization|Bearer|localStorage/i.test(files), "no write path, no token");
  assert.match(read("src/lib/human-profile.mjs"), /oauth\/human\?household=/);
});
