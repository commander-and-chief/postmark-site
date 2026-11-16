// backing.mjs — "Back this design", beside the Hearth's dropdown, while the Hearth ballot is staking (POS-1066 B).
//
// Darko, 2026-11-15 19:59 EST, on the friction of seeing a design on a Hearth and leaving to stake: "por qué no los dos". Wright 01:03:33Z
// (Darko 20:03 EST: "Yeah, I agree with hotfix"): "'Back this design' beside the Hearth's dropdown while the Hearth ballot is in staking,
// reusing `/votes/`'s signed-in stake form."
//
// WHAT IT IS. A small control in the site's own strip (Hearth.astro), outside the design's region: a <details> whose summary is "Back this
// design" and whose panel holds `/votes/`'s stake form (ballot-stake.mjs § mountBallotStake, UNCHANGED) for the Hearth ballot, with the
// design on screen as its one choice. Everything about a stake is that form's and the office's: the signed-in human picks one of THEIR OWN
// residents (the form reads /me; never the house being looked at), previews, confirms; the office judges. Signed out, the form says so and
// this panel offers the layout's own sign-in.
//
// WHO SEES IT. Any reader, on any house: backing a design is not the house's save. The dropdown's save is the house's own human's
// (picker.mjs: `signedIn` = the read answered AND the sign-in holds a resident of THIS house); that gate has nothing to do with who may back a
// design, so it is never read here.
//
// WHEN IT SHOWS (backingFor): only when the office's ballot read (GET /votes, public; ballot-box.mjs § readVotes sorts it) says the Hearth
// ballot is STAKING and lists the design on screen. An unreadable read, a ballot taking designs, closed, of a status this page does not know,
// absent, or a design it does not list: the control is hidden and nothing can be sent from here. The read is made when the page opens, again
// when the reader opens the panel (the form waits for that fresh answer, so a ballot that closed meanwhile is never offered), and when the
// reader comes back to the tab. Never on a clock.
//
// ONE FORM PER DESIGN, KEPT (the falsifiers). Switching designs never re-labels a form: each design's form names only that design, so a
// preview of A cannot be confirmed as B, and A's form (its preview, its "sending", its held "check what landed" after an unanswered confirm)
// is kept, detached, and comes back as it was when A is shown again: a held confirm is never forgotten by switching away and back. A read
// that FAILS keeps the forms (held out of the page, not forgotten); a read that SAYS the ballot is no longer staking drops them, as /votes/
// does (POS-1054's lifecycle fix).

import { mountBallotStake, freshToken } from "../ballot-stake.mjs";
import { readVotes } from "../ballot-box.mjs";
import { officeBase } from "../auth.mjs";
import { HEARTH_BALLOT_TOPIC } from "./ballot-links.mjs";

/**
 * Whether `design` can be backed, from a readVotes() answer: `{ can: true, topic, title, window }`, else `{ can: false, why }` with why one of
 * "unread" (no answer yet), "unreadable", "absent" (no Hearth ballot), "submissions", "closed", "unrecognised", "not-listed".
 */
export function backingFor(view, design, topic = HEARTH_BALLOT_TOPIC) {
  if (!view) return { can: false, why: "unread" };
  if (view.state === "unreadable") return { can: false, why: "unreadable" };
  const find = (list) => (Array.isArray(list) ? list : []).find((t) => t?.topic === topic) ?? null;
  const staking = find(view.staking);
  if (!staking) {
    if (find(view.submissions)) return { can: false, why: "submissions" };
    if (find(view.past)) return { can: false, why: "closed" };
    if (find(view.unrecognised)) return { can: false, why: "unrecognised" };
    return { can: false, why: "absent" };
  }
  // a list that could not be read is not "the design is listed": nothing is offered on a guess
  if (staking.candidatesUnreadable || !staking.candidates.some((c) => c.candidate === design)) return { can: false, why: "not-listed" };
  return { can: true, topic, title: staking.words, window: staking.window };
}

/**
 * Bind a `[data-hearth-backing]` <details> (Hearth.astro). Returns `{ show(id), read(), ready }`: `show` names the design on screen (the stage
 * calls it whenever it draws one); `read` asks the office again; `ready` settles once the first read has painted.
 */
export function mountHearthBacking(root, { doc = globalThis.document, storage, fetchImpl = globalThis.fetch, base, mount = mountBallotStake, topic = HEARTH_BALLOT_TOPIC } = {}) {
  if (!root || !doc) return { show: () => {}, read: async () => {}, ready: Promise.resolve() };
  let store = storage;
  if (store === undefined) { try { store = globalThis.localStorage; } catch { store = null; } }
  const office = () => base ?? officeBase(store ?? undefined);
  const q = (sel) => root.querySelector(sel);
  const $ = { ballot: q("[data-hearth-backing-ballot]"), signin: q("[data-hearth-backing-signin]"), form: q("[data-hearth-backing-form]"), note: q("[data-hearth-backing-note]") };
  const forms = new Map();    // design -> the slot its form is mounted in (kept across switches and failed reads)
  let design = null, view = null, checking = false, seq = 0;

  function slotFor(id) {
    let slot = forms.get(id);
    if (!slot) {
      slot = doc.createElement("div");
      slot.setAttribute("data-hearth-backing-for", id);
      forms.set(id, slot);
      // the stake form, unchanged: this ballot, this ONE design; the human, their residents and the office's judgement are all the form's
      try { mount(slot, { topic, choices: [{ candidate: id }], doc, storage: store, fetchImpl, base }); } catch { /* the form stood down: nothing is offered */ }
    }
    return slot;
  }

  function paint() {
    const v = backingFor(view, design, topic);
    root.hidden = !v.can;
    if (!v.can) root.open = false;
    root.dataset.hearthBacking = v.can ? "staking" : v.why;
    if ($.form) $.form.replaceChildren(...(v.can && !checking && design ? [slotFor(design)] : []));
    if ($.note) { $.note.textContent = v.can && checking ? "Checking the ballot as it stands…" : ""; $.note.hidden = !(v.can && checking); }
    if ($.ballot) $.ballot.textContent = v.can ? [v.title, v.window].filter(Boolean).join(" · ") : "";
    if ($.signin) $.signin.hidden = !v.can || checking || !!freshToken(store) || !doc.querySelector?.("[data-auth-signin]");
  }

  async function read() {
    const mine = ++seq;
    let reply = null, refused = false;
    try {
      const res = await fetchImpl(`${office()}/votes`, { headers: { accept: "application/json" }, cache: "no-store" });
      refused = !res.ok;
      reply = await res.json().catch(() => null);
    } catch { reply = null; }
    if (mine !== seq) return;           // a newer read has taken over: only the latest answer decides
    view = readVotes(reply, { refusal: refused });
    // READ, and the ballot is not staking: its forms go (a staking ballot keeps them, and an unreadable read decides nothing)
    if (view.state !== "unreadable" && !(view.staking ?? []).some((t) => t.topic === topic)) forms.clear();
    checking = false;
    paint();
  }

  root.addEventListener?.("toggle", () => {
    if (!root.open) return;
    checking = true;                    // the form waits for a fresh answer: a ballot that closed since the page opened is never offered
    paint();
    read();
  });
  $.signin?.addEventListener?.("click", () => doc.querySelector?.("[data-auth-signin]")?.click());
  doc.addEventListener?.("pm:lens", () => paint());
  doc.addEventListener?.("visibilitychange", () => { if (!doc.hidden) read(); });

  const ready = read();
  return {
    show(id) { design = typeof id === "string" && id ? id : null; paint(); },
    read,
    ready,
  };
}
