// conversations-pins-order.test.mjs — the human speaking box sits BELOW the pinned notices (POS-1047, ask 1).
//
//   node --test test/conversations-pins-order.test.mjs
//
// THE COMPLAINT (Erin at La Cave, relayed by Darko): on the Conversations page, when there are pinned notices she wants "the human chat
// … below them", because "when I want to speak, I can't see the conversation i was following before responding since, I am slow compared
// to the AI." WRIGHT'S GO, 2026-11-14 22:34Z: "Build ask 1 only: on the conversations page, the human chat sits below the pinned notices so
// the pins never push it out of view. Ask 2 (a view of one conversation) waits for the circles build (POS-1035)."
//
// TWO HALVES. The first reads the page source for what a browser cannot say (there is one speaking box, one pins container, and the order
// they are written in). The second RENDERS the built page (dist-town/, the same one `npm run build` makes; the built-pages CI job builds it
// first) in headless Chrome over CDP (Node's global WebSocket; throwaway profile, no sync, no extensions), with the office answered by
// invented fixtures through CDP's Fetch domain: /api/world/conversations (several long pins, two live threads), /api/me (a dry, invented
// signed-in identity with a token made up in localStorage) and /api/world/say, which is NEVER answered: any call to it fails the test (no
// resident act). It then measures the rects, types a draft, lets the page poll, and checks the draft, the focus, the selection and the
// form node itself survived the pins repaint.
//
// WITHOUT dist-town the browser half SKIPS and says so (a plain `npm test` has no build). WITH built pages and no browser it FAILS, so the
// built-pages job cannot turn a skip into a pass.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist-town");
const PAGE = readFileSync(new URL("../town/pages/conversations/index.astro", import.meta.url), "utf8");

// ── the source half ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const markup = PAGE.slice(0, PAGE.indexOf("<script"));
test("POS-1047: in the page's markup the pins come first, then ONE speaking box, then the live conversations", () => {
  const pins = markup.indexOf("<div data-pinned hidden></div>");
  const say = markup.indexOf("<section class=\"c-say\" data-say>");
  const live = markup.indexOf("<section class=\"c-live\"");
  assert.ok(pins > -1 && say > -1 && live > -1, "all three are in the markup");
  assert.ok(pins < say, "the pinned notices come before the speaking box");
  assert.ok(say < live, "and the speaking box comes before the live conversations, nothing between it and them");
  assert.equal(markup.split("data-say-form").length - 1, 1, "one speaking form: the existing box was moved, not copied");
  assert.equal(markup.split("data-pinned").length - 1, 1, "and one pins container");
  assert.equal(markup.split("data-say-text").length - 1, 1, "one textarea");
});

test("POS-1047: the form's own states, labels and keyboard path are the existing ones", () => {
  for (const hook of ["data-say-signedout", "data-say-visitor", "data-say-form", "data-say-as", "data-say-text", "data-say-send"]) assert.ok(markup.includes(hook), `${hook} is still there`);
  assert.match(markup, /<label class="c-say-as-label" for="c-say-as">speaking as<\/label>/, "the label is unchanged");
  assert.match(markup, /placeholder="Say something to whoever is standing near you\."/, "the placeholder is unchanged");
  // the select, then the textarea, then Speak: the tab order is the source order
  assert.ok(markup.indexOf("data-say-as") < markup.indexOf("data-say-text") && markup.indexOf("data-say-text") < markup.indexOf("data-say-send"));
});

test("POS-1047: the pins repaint writes only the pins container, never the speaking box", () => {
  const paint = PAGE.slice(PAGE.indexOf("function paintPinned"), PAGE.indexOf("// Arriving from the world map"));
  assert.ok(paint.length > 100, "found paintPinned");
  assert.ok(!/data-say|c-say|\[data-say/.test(paint), "it never reaches the speaking box");
  assert.match(paint, /pinnedBox\.textContent = ""/, "it rebuilds only its own container");
});

// ── the browser half ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const builtPages = existsSync(join(DIST, "conversations", "index.html"));
const SKIP = builtPages ? false : "no built pages (dist-town/): nothing to render";

function findChrome() {
  const named = [process.env.CHROME_BIN, ...["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"].map((n) => {
    const r = spawnSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  })].filter(Boolean);
  if (named.length) return named[0];
  try {
    const cache = join(homedir(), ".cache", "ms-playwright");
    for (const d of readdirSync(cache).filter((n) => n.startsWith("chromium-")).sort().reverse()) {
      const bin = join(cache, d, "chrome-linux64", "chrome");
      if (existsSync(bin)) return bin;
    }
  } catch { /* none */ }
  return null;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".txt": "text/plain" };
function serveDist() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url || "/").split("?")[0]);
    let file = normalize(join(DIST, p));
    if (!file.startsWith(DIST + sep) && file !== DIST) { res.writeHead(403); return res.end(); }
    try { if (statSync(file).isDirectory()) file = join(file, "index.html"); } catch { /* maybe a file */ }
    if (!existsSync(file)) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

async function launch(chrome) {
  const profile = mkdtempSync(join(tmpdir(), "pos1047-profile-"));
  // DETACHED: the whole browser is one process group that `close` kills as one (a helper that outlived the main process held a run open
  // for ever in the settlement-notice test's first CI run).
  const child = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-sync", "--disable-extensions", "--hide-scrollbars",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  child.unref();
  const wsUrl = await new Promise((ok, no) => {
    let buf = "";
    const t = setTimeout(() => no(new Error("no DevTools url within 20 s")), 20_000);
    child.stderr.on("data", (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) { clearTimeout(t); ok(m[1]); } });
    child.on("exit", (c) => no(new Error(`the browser exited early (${c})`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const pending = new Map(), listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else listeners.forEach((l) => l(m));
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? no(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (pending.delete(i)) no(new Error(`${method}: no answer in 30 s`)); }, 30_000);
  });
  return {
    send, listeners,
    close: () => {
      try { ws.close(); } catch { /* gone */ }
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
      try { child.stderr.destroy(); } catch { /* gone */ }
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

// ── the invented office ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Invented names and words throughout: nothing here is a real record, and nothing here is sent anywhere.
const LONG = "A long notice, hung where everyone passing the square can read it: the ferry sails when the bell has rung twice, the lantern walk starts at the old well, and anyone carrying a parcel for the far bank should leave it at the boathouse before the second bell so it crosses with the rest. ";
const pin = (n, text = LONG.repeat(2)) => ({ title: `Notice ${n} of the harbour`, place: `the harbour, stall ${n}`, text, announcements: [{ at: "2026-11-14T09:30:00Z", text: `Host's note ${n}: the second bell is at nine.` }] });
const thread = (id, who) => ({
  id, live: true, place: `the square (${id})`, at: { x: 10, y: 20 }, started: "2026-11-14T09:00:00Z", latest: new Date().toISOString(), voice_count: 2, participants: who,
  voices: who.map((h, i) => ({ handle: h, said: `${h} says something about the ferry (${i}).`, at_ms: Date.now() - 60_000 * (i + 1) })),
});
const office = { pins: [pin(1), pin(2), pin(3), pin(4)], threads: [thread("sq-1", ["fox", "heron"]), thread("sq-2", ["owl", "wren"])], conversationReads: 0, sayCalls: 0 };
const conversationsBody = () => JSON.stringify({ pinned: office.pins, live: office.threads, closed: [], earshot_m: 30, settlement_since: null });
const meBody = JSON.stringify({ handles: ["fox"], household: "invented-house", households: { fox: { slug: "invented-hearth" } } });

let chrome = null, server = null, browser = null, base = null;
async function boot() {
  if (browser) return;
  chrome = findChrome();
  assert.ok(chrome, "built pages exist but no Chrome/Chromium was found: set CHROME_BIN. (This fails rather than skips: a skipped render is not a passed one.)");
  server = await serveDist();
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launch(chrome);
}
test.after(async () => {
  browser?.close();
  if (server) {
    server.closeAllConnections?.();
    await Promise.race([new Promise((ok) => server.close(ok)), new Promise((ok) => setTimeout(ok, 3000).unref())]);
  }
});

async function openPage({ width, height = 900, signedIn = true }) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => browser.send(m, p, sessionId);
  await S("Page.enable");
  await S("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  // a dry identity: a made-up token in localStorage, read by the page's own boot(); /api/me is answered below. Nothing real signs in.
  const seed = `try { localStorage.setItem("pm.office.base", "/api"); ${signedIn ? `localStorage.setItem("pm.oauth.token", JSON.stringify({ access_token: "invented-token", obtained: Date.now(), expires_in: 3600 }));` : ""} } catch (e) {}`;
  await S("Page.addScriptToEvaluateOnNewDocument", { source: seed });
  await S("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" }] });
  const fulfil = (requestId, code, body) => S("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "cache-control", value: "no-store" }], body: Buffer.from(body).toString("base64") }).catch(() => {});
  const listener = (m) => {
    if (m.sessionId !== sessionId || m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const url = request?.url ?? "";
    if (/\/api\/world\/say/.test(url)) { office.sayCalls += 1; return fulfil(requestId, 418, JSON.stringify({ error: "the test never lets a word be spoken" })); }
    if (/\/api\/world\/conversations/.test(url)) { office.conversationReads += 1; return fulfil(requestId, 200, conversationsBody()); }
    if (/\/api\/me(\?|$)/.test(url)) return fulfil(requestId, 200, meBody);
    return fulfil(requestId, 404, JSON.stringify({ error: "not part of this fixture" }));
  };
  browser.listeners.push(listener);
  await S("Page.navigate", { url: base + "/conversations/" });
  const evalJs = async (expression) => {
    const r = await S("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (predicateJs, what, ms = 20_000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await evalJs(predicateJs)) return; await new Promise((ok) => setTimeout(ok, 100)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const key = async (k, code, vk) => {
    await S("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
    await S("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
    await new Promise((ok) => setTimeout(ok, 150));
  };
  return { evalJs, until, key, send: S, close: async () => { browser.listeners.splice(browser.listeners.indexOf(listener), 1); await browser.send("Target.closeTarget", { targetId }).catch(() => {}); } };
}

// the rects of the four things whose order matters, and what is visible
const LAYOUT = `(() => {
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right, height: r.height, width: r.width, shown: !e.hidden && cs.display !== "none" && r.height > 0 }; };
  return { head: rect(document.querySelector(".c-head")), pins: rect(document.querySelector("[data-pinned]")), say: rect(document.querySelector("[data-say]")), form: rect(document.querySelector("[data-say-form]")), live: rect(document.querySelector(".c-live")),
    pinCards: document.querySelectorAll("[data-pinned] .c-pin").length, forms: document.querySelectorAll("[data-say-form]").length, scrollWidth: document.documentElement.scrollWidth };
})()`;

for (const [label, width] of [["desktop 1280", 1280], ["phone 390", 390]]) {
  test(`POS-1047 (${label}): with several long pins, the speaking box is after the pins and before the live conversations, and visible`, { skip: SKIP, timeout: 120_000 }, async () => {
    await boot();
    office.pins = [pin(1), pin(2), pin(3), pin(4)];
    const p = await openPage({ width });
    try {
      await p.until(`document.querySelectorAll("[data-pinned] .c-pin").length === 4 && !document.querySelector("[data-say-form]").hidden && document.querySelectorAll(".c-thread").length >= 2`, "the pins, the form and the threads to paint");
      const L = await p.evalJs(LAYOUT);
      assert.equal(L.pinCards, 4);
      assert.equal(L.forms, 1, "one speaking form on the page (not duplicated)");
      assert.ok(L.pins.shown && L.form.shown && L.live.shown);
      assert.ok(L.pins.bottom <= L.say.top + 1, `the pins end (${Math.round(L.pins.bottom)}) before the speaking box begins (${Math.round(L.say.top)})`);
      assert.ok(L.say.bottom <= L.live.top + 1, `and the box ends (${Math.round(L.say.bottom)}) before the live conversations begin (${Math.round(L.live.top)}): the pins do not sit between the box and the chat`);
      assert.ok(L.pins.height > 300, `the pins are long enough to matter here (${Math.round(L.pins.height)} px)`);
      assert.ok(L.scrollWidth <= width, `the page is no wider than the view (${L.scrollWidth} > ${width})`);
    } finally { await p.close(); }
  });
}

test("POS-1047: with NO pins the container is hidden and leaves no dead space; the box sits where it always sat, just under the header", { skip: SKIP, timeout: 120_000 }, async () => {
  await boot();
  office.pins = [];
  const p = await openPage({ width: 1280 });
  try {
    await p.until(`!document.querySelector("[data-say-form]").hidden && document.querySelectorAll(".c-thread").length >= 2`, "the form and the threads to paint");
    await new Promise((ok) => setTimeout(ok, 500));
    const L = await p.evalJs(LAYOUT);
    assert.equal(L.pinCards, 0);
    assert.equal(L.pins.shown, false, "the empty pins container is not shown");
    assert.equal(L.pins.height, 0, "and takes no height");
    // the gap between the header and the box is the box's own 1.6 rem margin and nothing more: nothing is left standing between them
    assert.ok(L.say.top - L.head.bottom <= 1.7 * 16 + 2, `no dead space above the box (${Math.round(L.say.top - L.head.bottom)} px under the header)`);
  } finally { await p.close(); }
});

test("POS-1047: a poll that repaints the pins does NOT replace the form, nor lose its draft, focus or selection", { skip: SKIP, timeout: 180_000 }, async () => {
  await boot();
  office.pins = [pin(1), pin(2), pin(3), pin(4)];
  const p = await openPage({ width: 1280 });
  try {
    await p.until(`document.querySelectorAll("[data-pinned] .c-pin").length === 4 && !document.querySelector("[data-say-form]").hidden`, "the pins and the form to paint");
    // the draft: typed text, the textarea focused, a selection inside it, and the form node marked so a REPLACED node is caught
    const draft = "I was following the ferry thread, and I want to answer the heron.";
    await p.evalJs(`(() => { const f = document.querySelector("[data-say-form]"), t = document.querySelector("[data-say-text]"); f.__mark = "same-node"; t.__mark = "same-node"; t.focus(); t.value = ${JSON.stringify(draft)}; t.dispatchEvent(new Event("input", { bubbles: true })); t.setSelectionRange(9, 20); return true; })()`);
    const before = await p.evalJs(`(() => { const t = document.querySelector("[data-say-text]"); return { active: document.activeElement === t, start: t.selectionStart, end: t.selectionEnd, value: t.value }; })()`);
    assert.deepEqual(before, { active: true, start: 9, end: 20, value: draft }, "the draft is set up");
    // a poll that CHANGES the pins (and the chat): the pins must visibly repaint while the form stays put
    const reads0 = office.conversationReads;
    office.pins = [pin(1, "The first notice, REWORDED by the next poll."), pin(2), pin(3), pin(4), pin(5)];
    office.threads = [thread("sq-1", ["fox", "heron", "wren"]), thread("sq-2", ["owl", "wren"])];
    await p.until(`document.querySelectorAll("[data-pinned] .c-pin").length === 5 && document.querySelector("[data-pinned] .c-pin-text").textContent.includes("REWORDED")`, "the next poll to repaint the pins (every 7 s)", 40_000);
    assert.ok(office.conversationReads > reads0, "the page polled again");
    const after = await p.evalJs(`(() => { const f = document.querySelector("[data-say-form]"), t = document.querySelector("[data-say-text]"); return { formSame: f.__mark === "same-node", textSame: t.__mark === "same-node", active: document.activeElement === t, start: t.selectionStart, end: t.selectionEnd, value: t.value, forms: document.querySelectorAll("[data-say-form]").length, formShown: !f.hidden }; })()`);
    assert.deepEqual(after, { formSame: true, textSame: true, active: true, start: 9, end: 20, value: draft, forms: 1, formShown: true }, "after the poll: the same form node, the same draft, the focus and the selection");
    assert.equal(office.sayCalls, 0, "and nothing was spoken: no resident act");
  } finally { await p.close(); }
});

test("POS-1047: the keyboard path through the box is unchanged: the voice select, then the text, then Speak; and the form is reachable on a phone", { skip: SKIP, timeout: 120_000 }, async () => {
  await boot();
  office.pins = [pin(1), pin(2), pin(3), pin(4)];
  const p = await openPage({ width: 390 });
  try {
    await p.until(`document.querySelectorAll("[data-pinned] .c-pin").length === 4 && !document.querySelector("[data-say-form]").hidden`, "the page to paint");
    await p.evalJs(`document.querySelector("[data-say-as]").focus(); true`);
    await p.key("Tab", "Tab", 9);
    assert.equal(await p.evalJs(`document.activeElement === document.querySelector("[data-say-text]")`), true, "Tab goes from the voice select to the text");
    await p.key("Tab", "Tab", 9);
    assert.equal(await p.evalJs(`document.activeElement === document.querySelector("[data-say-send]")`), true, "and then to Speak");
    // the box can be brought into view and clicked by a finger: its centre is the topmost thing at that point
    const hit = await p.evalJs(`(() => { const t = document.querySelector("[data-say-text]"); t.scrollIntoView({ block: "center" }); const r = t.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e === t; })()`);
    assert.equal(hit, true, "nothing covers the text box once it is scrolled to");
    assert.equal(office.sayCalls, 0, "no resident act");
  } finally { await p.close(); }
});

test("POS-1047: the signed-out and visitor states are untouched by the move (the gate still shows where the box would be)", { skip: SKIP, timeout: 120_000 }, async () => {
  await boot();
  office.pins = [pin(1), pin(2)];
  const p = await openPage({ width: 1280, signedIn: false });
  try {
    await p.until(`document.querySelectorAll("[data-pinned] .c-pin").length === 2 && !document.querySelector("[data-say-signedout]").hidden`, "the signed-out gate");
    const L = await p.evalJs(`(() => { const g = document.querySelector("[data-say-signedout]").getBoundingClientRect(), p = document.querySelector("[data-pinned]").getBoundingClientRect(), l = document.querySelector(".c-live").getBoundingClientRect(); return { afterPins: g.top >= p.bottom - 1, beforeLive: g.bottom <= l.top + 1, formHidden: document.querySelector("[data-say-form]").hidden }; })()`);
    assert.deepEqual(L, { afterPins: true, beforeLive: true, formHidden: true }, "the sign-in gate takes the box's place: after the pins, before the chat");
  } finally { await p.close(); }
});
