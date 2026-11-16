// hearth-backing.test.mjs — "Back this design" beside the Hearth's dropdown, while the Hearth ballot is staking (POS-1066 B).
//
//   node --test test/hearth-backing.test.mjs
//
// Wright 01:03:33Z (Darko 2026-11-15 20:03 EST: "Yeah, I agree with hotfix"): "'Back this design' beside the Hearth's dropdown while the Hearth ballot is in
// staking, reusing `/votes/`'s signed-in stake form." The brief's falsifiers, each a case below: switching A→B after a preview cannot confirm A as B, nor
// forget an ambiguous send and permit a second one; the actor is the signed-in human's resident, never the viewed house's; an unknown or closed read cannot
// leave backing enabled. It drives the REAL stake form (ballot-stake.mjs § mountBallotStake, unchanged) on a hand-rolled document (the site carries no DOM
// library; test/ballot-stake.test.mjs is the precedent), with invented ballots and residents. The rendered page is test/hearth-backing-browser.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { backingFor, mountHearthBacking } from "../src/lib/hearth/backing.mjs";
import { readVotes } from "../src/lib/ballot-box.mjs";
import { HEARTH_BALLOT_TOPIC } from "../src/lib/hearth/ballot-links.mjs";

const T = HEARTH_BALLOT_TOPIC;
const hearth = (status, candidates = ["ember", "quill"]) => ({ topic: T, title: "The default Hearth", status, window: "Staking closes Sunday",
  candidates: candidates.map((c) => ({ candidate: c, staked: 3 })) });

test("the verdict: only a STAKING Hearth ballot that lists the design can be backed; every other answer says why, and none is 'can'", () => {
  const v = (reply, opts) => readVotes(reply, opts);
  assert.deepEqual(backingFor(v({ topics: [hearth("staking")] }), "ember"), { can: true, topic: T, title: "The default Hearth", window: "Staking closes Sunday" });
  const why = (view, design = "ember") => backingFor(view, design).why;
  assert.equal(why(null), "unread");
  assert.equal(why(v(null)), "unreadable");
  assert.equal(why(v({ topics: [hearth("staking")] }, { refusal: true })), "unreadable", "a refused read decides nothing");
  assert.equal(why(v({ topics: [] })), "absent");
  assert.equal(why(v({ topics: [{ ...hearth("staking"), topic: "harbor-lantern" }] })), "absent", "another ballot that lists the design is not the Hearth ballot");
  assert.equal(why(v({ topics: [hearth("submissions")] })), "submissions");
  assert.equal(why(v({ topics: [hearth("closed")] })), "closed");
  assert.equal(why(v({ topics: [hearth("paused")] })), "unrecognised", "a status this page does not know is never taken for staking");
  assert.equal(why(v({ topics: [hearth("staking")] }), "stray"), "not-listed");
  assert.equal(why(v({ topics: [{ ...hearth("staking"), candidates: null }] })), "not-listed", "an unreadable design list is not 'listed'");
});

// ── the mount, on a hand-rolled document ────────────────────────────────────
function fakeDocument() {
  const on = (o) => { o._on = {}; o.addEventListener = (t, f) => { (o._on[t] ??= []).push(f); }; o.dispatchEvent = (ev) => { for (const f of o._on[ev.type] ?? []) f(ev); return true; }; return o; };
  const make = (tag) => {
    const e = on({ tagName: tag.toUpperCase(), attrs: {}, children: [], hidden: false, disabled: false, open: false, className: "", dataset: {}, _text: "", _value: undefined });
    e.setAttribute = (k, v) => { e.attrs[k] = String(v); };
    e.getAttribute = (k) => e.attrs[k] ?? null;
    e.hasAttribute = (k) => k in e.attrs;
    e.append = (...kids) => { e.children.push(...kids); };
    e.replaceChildren = (...kids) => { e.children = [...kids]; };
    e.classList = { add: (c) => { e.className = `${e.className} ${c}`.trim(); } };
    e.querySelector = (sel) => { const a = /^\[([a-z-]+)\]$/.exec(sel)?.[1]; return a ? find(e, (x) => x !== e && x.attrs && a in x.attrs) : null; };
    Object.defineProperty(e, "textContent", { get: () => e._text + e.children.map((c) => c.textContent).join(" "), set: (v) => { e._text = String(v); e.children = []; } });
    Object.defineProperty(e, "value", {
      get: () => e._value ?? (e.tagName === "SELECT" ? e.children[0]?.attrs.value ?? "" : e.tagName === "OPTION" ? e.attrs.value : ""),
      set: (v) => { e._value = String(v); },
    });
    return e;
  };
  const doc = on({ head: make("head"), createElement: make, hidden: false, defaultView: { CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } } } });
  doc.signin = null;
  doc.querySelector = (sel) => (sel === "[data-auth-signin]" ? doc.signin : null);
  return doc;
}
const find = (root, pred) => { if (pred(root)) return root; for (const c of root.children ?? []) { const f = find(c, pred); if (f) return f; } return null; };
const byClass = (root, c) => find(root, (e) => (e.attrs?.class ?? e.className ?? "").split(" ").includes(c));
const byName = (root, n) => find(root, (e) => e.attrs?.name === n);
const settle = () => new Promise((r) => setTimeout(r, 0));

/** The strip's <details> as Hearth.astro draws it. */
function strip(doc) {
  const root = doc.createElement("details");
  root.setAttribute("data-hearth-backing", "");
  root.hidden = true;
  const panel = doc.createElement("div");
  for (const a of ["data-hearth-backing-ballot", "data-hearth-backing-note", "data-hearth-backing-form", "data-hearth-backing-signin"]) {
    const e = doc.createElement(a.endsWith("signin") ? "button" : a.endsWith("form") ? "div" : "p");
    e.setAttribute(a, "");
    panel.append(e);
  }
  root.append(panel);
  return root;
}
const formIn = (root) => root.querySelector("[data-hearth-backing-form]");
const open = async (root) => { root.open = true; root.dispatchEvent({ type: "toggle" }); await settle(); };

/** An office double: the ballot read, /me, and the household door. `votes` and `confirm` can be changed by a step; every request is kept. */
function office({ me = { handles: ["vela", "rook"] } } = {}) {
  const o = { sent: [], votes: { status: 200, json: { topics: [hearth("staking")] } }, confirm: "ok" };
  o.fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    o.sent.push({ url, method: init.method ?? "GET", body });
    const reply = (status, json) => ({ ok: status < 300, status, json: async () => json });
    if (url.endsWith("/votes")) { const v = typeof o.votes === "function" ? await o.votes() : o.votes; return reply(v.status, v.json); }
    if (url.endsWith("/me")) return reply(200, me);
    if (url.endsWith(`/votes/${T}`)) return reply(200, { candidates: [{ candidate: body?.args?.candidate ?? "ember", staked: 5 }], your_household: { headroom: {} } });
    if (url.endsWith("/household")) {
      const a = body.args;
      const result = { preview: a.preview === true, handle: a.from, candidate: a.candidate, requested: a.stamps, applied: a.stamps, clipped: false,
        household_headroom_before: 20, household_headroom_after: 20 - a.stamps, balance_before: 9, balance_after: 9 - a.stamps, vote_minted: false };
      if (!a.preview && o.confirm === "silent") throw new Error("the line dropped");
      return reply(200, { result });
    }
    return reply(404, { error: "not here" });
  };
  o.posts = () => o.sent.filter((s) => s.method === "POST");
  o.confirms = () => o.posts().filter((s) => !s.body.args.preview);
  return o;
}
const signedIn = { getItem: (k) => (k === "pm.oauth.token" ? JSON.stringify({ access_token: "tok", obtained: Date.now(), expires_in: 3600 }) : null) };
const signedOut = { getItem: () => null };

async function mounted({ storage = signedIn, me, design = "ember" } = {}) {
  const doc = fakeDocument();
  const root = strip(doc);
  const o = office({ me });
  const b = mountHearthBacking(root, { doc, storage, fetchImpl: o.fetchImpl, base: "/api" });
  b.show(design);
  await b.ready; await settle();
  return { doc, root, o, b };
}
const preview = async (form, stamps = "2") => {
  byName(form, "stamps").value = stamps;
  byClass(form, "bs-form").dispatchEvent({ type: "submit", preventDefault() {} });
  await settle(); await settle();
};
const clickConfirm = async (form) => { byClass(form, "bs-confirm").dispatchEvent({ type: "click" }); await settle(); await settle(); };

test("it shows only while the read says staking and lists the design on screen; the form is /votes/'s, for this ONE design", async () => {
  const { root, o, b } = await mounted();
  assert.ok(o.sent.some((s) => s.url === "/api/votes" && s.method === "GET"), "the public ballot read");
  assert.equal(root.hidden, false);
  assert.equal(root.dataset.hearthBacking, "staking");
  await open(root);
  const form = formIn(root);
  const choices = byName(form, "candidate").children.map((c) => c.attrs.value);
  assert.deepEqual(choices, ["ember"], "the form's one choice is the design on screen");
  assert.equal(byClass(form, "bs-form").hidden, false, "signed in: the form shows");
  b.show("stray");
  assert.equal(root.hidden, true, "a design the ballot does not list: nothing to back");
  assert.deepEqual(formIn(root).children, []);
});

test("switching A→B after a preview cannot confirm A as B: each design has its own form, and A's preview never travels", async () => {
  const { root, o, b } = await mounted({ design: "ember" });
  await open(root);
  const formA = formIn(root).children[0];
  byName(formA, "from").value = "rook";
  await preview(formA, "3");
  assert.equal(byClass(formA, "bs-confirm").hidden, false, "A previewed: A's confirm is offered");

  b.show("quill");                                                     // the reader switches the dropdown to B
  const formB = formIn(root).children[0];
  assert.notEqual(formB, formA, "B gets its own form; A's is not re-labelled");
  assert.deepEqual(byName(formB, "candidate").children.map((c) => c.attrs.value), ["quill"]);
  assert.equal(byClass(formB, "bs-confirm").hidden, true, "B has no preview, so no confirm");
  await clickConfirm(formB);
  assert.equal(o.confirms().length, 0, "a confirm on B before B is previewed sends nothing");
  assert.ok(!formIn(root).children.includes(formA), "A's form is off the page while B is shown");

  b.show("ember");                                                     // back to A: its preview is still A's, and confirms as A
  assert.equal(formIn(root).children[0], formA, "A's own form comes back, as it was");
  await clickConfirm(formA);
  assert.equal(o.confirms().length, 1);
  assert.deepEqual(o.confirms()[0].body.args, { from: "rook", topic: T, candidate: "ember", stamps: 3 }, "the confirm is exactly A's previewed stake");
  assert.equal(o.posts().filter((p) => p.body.args.candidate === "quill").length, 0, "nothing was ever sent for B");
});

test("an ambiguous confirm is not forgotten by switching away and back: no second send until checked and previewed again", async () => {
  const { root, o, b } = await mounted({ design: "ember" });
  await open(root);
  const formA = formIn(root).children[0];
  await preview(formA);
  o.confirm = "silent";                                                // the office never answers the confirm
  await clickConfirm(formA);
  assert.equal(o.confirms().length, 1);
  assert.match(byClass(formA, "bs-out").className, /ambiguous/);

  b.show("quill"); b.show("ember");                                    // away and back
  await settle(); await settle();                                      // (a form mounted afresh would have read /me by now)
  const shown = formIn(root).children[0];                              // whatever form the reader now sees for A
  await preview(shown);
  await clickConfirm(shown);
  assert.equal(o.confirms().length, 1, "back on A, a preview and a confirm send NOTHING: the unanswered stake is not forgotten");
  assert.equal(shown, formA, "it is A's own form, kept");
  assert.equal(byClass(formA, "bs-confirm").hidden, true, "the confirm is still held");
  assert.equal(byClass(formA, "bs-check").hidden, false, "and the check is still offered");

  // nor is it forgotten by closing and reopening the panel, or by a read that FAILS (the form is held out of the page, not dropped)
  o.votes = { status: 503, json: { error: "down" } };
  await open(root);
  assert.equal(root.hidden, true, "an unreadable read leaves nothing to act on");
  o.votes = { status: 200, json: { topics: [hearth("staking")] } };
  await b.read(); await settle(); await settle();
  const again = formIn(root).children[0];
  await preview(again);
  await clickConfirm(again);
  assert.equal(o.confirms().length, 1, "readable again: a preview and a confirm still send nothing");
  assert.equal(again, formA, "the same form, still held");
});

test("an unknown or closed read cannot leave backing enabled, and opening the panel waits for a fresh answer", async () => {
  const { root, o, b } = await mounted({ design: "ember" });
  await open(root);
  const formA = formIn(root).children[0];
  await preview(formA);
  assert.equal(byClass(formA, "bs-confirm").hidden, false);

  // the ballot closes while the page is open; the reader opens the panel again: the form is gone before any confirm can be pressed
  let release;
  o.votes = () => new Promise((ok) => { release = () => ok({ status: 200, json: { topics: [hearth("closed")] } }); });
  root.open = false; await open(root);
  assert.deepEqual(formIn(root).children, [], "while the fresh read is out, no form is on the page");
  assert.match(root.querySelector("[data-hearth-backing-note]").textContent, /Checking the ballot/);
  release(); await settle(); await settle();
  assert.equal(root.hidden, true);
  assert.equal(root.open, false);
  assert.equal(root.dataset.hearthBacking, "closed");

  // read as staking again later: the closed read DROPPED the old forms (POS-1054's rule), so A starts afresh and offers no stale confirm
  o.votes = { status: 200, json: { topics: [hearth("staking")] } };
  await b.read(); await settle();
  assert.notEqual(formIn(root).children[0], formA);
  assert.equal(byClass(formIn(root).children[0], "bs-confirm").hidden, true);

  for (const [name, reply, why] of [["a status it does not know", { topics: [hearth("paused")] }, "unrecognised"], ["no topics list", { note: "?" }, "unreadable"],
    ["taking designs", { topics: [hearth("submissions")] }, "submissions"], ["no Hearth ballot", { topics: [] }, "absent"]]) {
    o.votes = { status: 200, json: reply };
    await b.read(); await settle();
    assert.equal(root.hidden, true, name);
    assert.equal(root.dataset.hearthBacking, why, name);
    assert.deepEqual(formIn(root).children, [], name);
  }
  assert.equal(o.confirms().length, 0, "nothing was ever confirmed");
});

test("only the LATEST read decides: a slow older 'staking' cannot reopen backing after a newer 'closed'", async () => {
  const { root, o, b } = await mounted({ design: "ember" });
  let slow;
  o.votes = () => new Promise((ok) => { slow = () => ok({ status: 200, json: { topics: [hearth("staking")] } }); });
  const older = b.read();
  o.votes = { status: 200, json: { topics: [hearth("closed")] } };
  await b.read(); await settle();
  assert.equal(root.hidden, true);
  slow(); await older; await settle();
  assert.equal(root.hidden, true, "the older answer is dropped");
});

test("the actor is the signed-in human's resident (from /me), never the viewed house's: the mount is given no house at all", async () => {
  const { root, o } = await mounted({ me: { handles: ["far-away-resident"] } });
  await open(root);
  const form = formIn(root).children[0];
  assert.deepEqual(byName(form, "from").children.map((c) => c.attrs.value), ["far-away-resident"], "the human's own residents, as /me answers");
  await preview(form);
  await clickConfirm(form);
  assert.equal(o.confirms()[0].body.args.from, "far-away-resident");
  assert.ok(o.sent.some((s) => s.url === "/api/me"), "who may stake is /me's answer");
  // and the module itself never reads a house: no handles, no save gate, no house key
  const src = readFileSync(new URL("../src/lib/hearth/backing.mjs", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /handles|signedIn|mine\(|hearthKey|data-hearth-faces|saveHearth/, "nothing of the viewed house reaches the stake");
});

test("signed out: the form says to sign in, and the panel offers the layout's own sign-in; a visitor with no resident is told to move in", async () => {
  const { doc, root } = await mounted({ storage: signedOut });
  let clicked = 0;
  doc.signin = { click: () => { clicked += 1; } };
  doc.dispatchEvent({ type: "pm:lens" });
  await open(root);
  const form = formIn(root).children[0];
  assert.equal(byClass(form, "bs-form").hidden, true, "no form without a sign-in");
  assert.match(byClass(form, "bs-gate").textContent, /Sign in to stake/);
  const signin = root.querySelector("[data-hearth-backing-signin]");
  assert.equal(signin.hidden, false);
  signin.dispatchEvent({ type: "click" });
  assert.equal(clicked, 1, "the layout's sign-in, not a door of its own");

  const visitor = await mounted({ me: { visitor: true } });
  await open(visitor.root);
  const vf = formIn(visitor.root).children[0];
  assert.equal(byClass(vf, "bs-form").hidden, true);
  assert.match(byClass(vf, "bs-gate").textContent, /Move in first/);
  assert.equal(visitor.root.querySelector("[data-hearth-backing-signin]").hidden, true, "signed in: no sign-in offered");
});

test("the page wires it: the strip's details ships hidden beside the dropdown, outside the design's region, and the stage tells it each design it draws", () => {
  const astro = readFileSync(new URL("../src/components/hearth/Hearth.astro", import.meta.url), "utf8");
  const stage = readFileSync(new URL("../src/lib/hearth/stage.mjs", import.meta.url), "utf8");
  const at = astro.indexOf("data-hearth-backing hidden");
  assert.ok(at > astro.indexOf("<HearthPicker") && at < astro.indexOf("<!--hearth-entry-->"), "in the strip's corner, after the dropdown, before the design's region");
  assert.match(astro, /<summary class="hearth-backing-sum">Back this design<\/summary>/);
  assert.match(stage, /mountHearthBacking\(backingRoot\)/, "mounted with nothing of the house's");
  assert.equal((stage.match(/backing\?\.show\((entry|first)\.id\)/g) ?? []).length, 2, "both places the stage names the design on screen");
  assert.doesNotMatch(stage.slice(stage.indexOf("hearthApi({")).split("\n")[0], /backing/, "the design's script is handed nothing of it");
});
