// hearth-backing-browser.test.mjs — POS-1066 RENDERED on the built pages: see a Hearth ballot's design live, and back it from the Hearth.
//
//   node --test test/hearth-backing-browser.test.mjs
//
// Wright 01:03:33Z (Darko 2026-11-15 20:03 EST: "Yeah, I agree with hotfix"): "the 'See it' links on every Hearth ballot choice (the civic panel and
// `/votes/`), and 'Back this design' beside the Hearth's dropdown while the Hearth ballot is in staking, reusing `/votes/`'s signed-in stake form."
//
// It serves the built site (dist-town/; the built-pages CI job builds it first), drives headless Chrome over CDP (Node's global WebSocket; a throwaway
// profile, no sync, no extensions) and answers the office ITSELF through CDP's Fetch domain with INVENTED replies: the ballot read, /me and the household
// door. Every other office call is refused. The live office is never touched, nobody really signs in (a made-up token is put in the page's storage), and
// nothing is staked. The houses and the registered designs are the build's own (a design's page is the build's), named only through the build's map.
//
// WHAT IT PROVES that the node tests cannot: on /votes/ and the civic panel a Hearth design's "see it", clicked with a real mouse, opens THAT design on its
// author's house (the brief's first falsifier), and nothing else links; on another house's page a signed-in visitor (not of that house) has "Back this
// design" beside the dropdown while the save stays the house's; previewing one design and switching the dropdown cannot confirm it as the other; the
// confirm that goes is the one previewed, as the signed-in human's own resident; a ballot that closes takes the control away when the panel is reopened;
// signed out it offers the sign-in; it fits a phone; and its words read against the panel they sit on.
//
// WITHOUT dist-town the test SKIPS and says so; WITH built pages and no browser it FAILS (so the built-pages job cannot turn a skip into a pass).

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HEARTH_BALLOT_TOPIC } from "../src/lib/hearth/ballot-links.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist-town");
const SKIP = existsSync(join(DIST, "votes", "index.html")) ? false : "no built pages (dist-town/): nothing to render";

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

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2" };
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

// DETACHED, so the whole browser is one process group that `close` kills as one
async function launch(chrome) {
  const profile = mkdtempSync(join(tmpdir(), "pos1066-profile-"));
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
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else listeners.forEach((l) => l(m)); };
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? no(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (pending.delete(i)) no(new Error(`${method}: no answer in 30 s`)); }, 30_000);
  });
  return { send, listeners, close: () => {
    try { ws.close(); } catch { /* gone */ }
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    try { child.stderr.destroy(); } catch { /* gone */ }
    rmSync(profile, { recursive: true, force: true });
  } };
}

/**
 * One page with the office answered by `office` (read at request time, so a step can change it): GET …/votes, GET …/me and POST …/household; every
 * other office call (here or at postmark.town/api) is refused. `signedIn` puts an invented token in the page's storage before any script runs.
 */
async function openPage(b, base, path, { width, height = 900, office, signedIn = false }) {
  const { targetId } = await b.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => b.send(m, p, sessionId);
  await S("Page.enable"); await S("Runtime.enable");
  await S("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  // one browser profile serves every test, so a signed-out page clears what an earlier signed-in page put in storage
  await S("Page.addScriptToEvaluateOnNewDocument", { source: signedIn
    ? `try { localStorage.setItem("pm.oauth.token", JSON.stringify({ access_token: "invented-token", obtained: Date.now(), expires_in: 3600 })); } catch {}`
    : `try { localStorage.removeItem("pm.oauth.token"); localStorage.removeItem("pm.oauth.handles.cache"); sessionStorage.removeItem("pm.oauth.handles"); } catch {}` });
  await S("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" }] });
  b.listeners.push((m) => {
    if (m.sessionId !== sessionId || m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const u = new URL(request.url);
    const said = (r) => S("Fetch.fulfillRequest", { requestId, responseCode: r.status, responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "cache-control", value: "no-store" }],
      body: Buffer.from(JSON.stringify(r.json)).toString("base64") }).catch(() => {});
    const local = u.origin === base;
    office.asked.push(`${request.method} ${local ? "" : u.origin}${u.pathname}`);
    if (local && request.method === "GET" && u.pathname === "/api/votes") return said(office.votes());
    if (local && request.method === "GET" && u.pathname === "/api/me") return said({ status: 200, json: office.me });
    if (local && request.method === "POST" && u.pathname === "/api/household") {
      const body = JSON.parse(request.postData ?? "null");
      office.posts.push({ body, auth: request.headers.Authorization ?? request.headers.authorization ?? null });
      return said(office.stake(body));
    }
    S("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
  });
  await S("Page.navigate", { url: base + path });
  const evalJs = async (expression) => {
    const r = await S("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (expr, what, ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) { if (await evalJs(expr)) return; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); }
  };
  // a REAL click: a coordinate mouse event at the element's centre (a synthetic element.click() ignores layout and pointer-events)
  const click = async (selector) => {
    const pt = await evalJs(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "center", behavior: "instant" }); const b = e.getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, hit: !!hit && (hit === e || e.contains(hit)), covered: hit ? (hit.tagName + "." + hit.className + "#" + hit.id) : null, rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] }; })()`);
    assert.ok(pt, `no element ${selector}`);
    assert.ok(pt.hit, `${selector}'s centre is covered by ${pt.covered} (rect ${pt.rect}, point ${Math.round(pt.x)},${Math.round(pt.y)})`);
    for (const type of ["mousePressed", "mouseReleased"]) await S("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
  };
  const type = async (selector, text) => {
    await evalJs(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.select?.(); return true; })()`);
    await S("Input.insertText", { text });
  };
  return { evalJs, until, click, type, S, close: () => S("Target.closeTarget", { targetId }).catch(() => {}) };
}

// THE BUILD'S OWN DESIGNS AND HOUSES. The map is the one the build wrote (the /votes/ page carries it); two designs are needed to switch between, and a
// house other than the founders' to back them from as a visitor.
const MAP = (() => {
  if (SKIP) return {};
  const html = readFileSync(join(DIST, "votes", "index.html"), "utf8");
  const raw = /data-hearth-previews="([^"]*)"/.exec(html)?.[1] ?? "{}";
  return JSON.parse(raw.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, "&"));
})();
const DESIGNS = Object.keys(MAP);
const [A, B] = DESIGNS;
const VISITED = SKIP ? null : readdirSync(join(DIST, "households"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(DIST, "households", d.name, "index.html")) && !Object.values(MAP).some((h) => h.startsWith(`/households/${d.name}/`)))
  .map((d) => d.name).sort()[0] ?? null;

const hearthBallot = (status, designs = DESIGNS) => ({ topic: HEARTH_BALLOT_TOPIC, title: "Postmark's default Hearth (invented)", status, window: "Staking closes on the invented Sunday",
  cap_per_household_per_candidate: 20, candidates: [...designs.map((d, i) => ({ candidate: d, staked: 10 - i, backing_households: 3, credit: "Postmark", link: `https://github.com/invented/${d}` })),
    { candidate: "not-registered-here", staked: 1, backing_households: 1, link: "https://github.com/invented/elsewhere" }] });
const OTHER = { topic: "harbor-lantern", title: "Pick the harbor lantern (invented)", status: "staking", candidates: DESIGNS.slice(0, 1).map((d) => ({ candidate: d, staked: 4, link: "https://github.com/invented/lantern" })) };
const ok = (json) => ({ status: 200, json });
function office({ votes = ok({ topics: [hearthBallot("staking"), OTHER] }), me = { handles: ["far-res"] } } = {}) {
  const o = { asked: [], posts: [], me, votesAnswer: votes };
  o.votes = () => o.votesAnswer;
  o.stake = (body) => {
    const a = body.args;
    return ok({ result: { preview: a.preview === true, handle: a.from, candidate: a.candidate, requested: a.stamps, applied: a.stamps, clipped: false, household_headroom_before: 20,
      household_headroom_after: 20 - a.stamps, balance_before: 12, balance_after: 12 - a.stamps, vote_minted: false } });
  };
  return o;
}

let server = null, browser = null, base = null;
const chrome = SKIP ? null : findChrome();
async function setup() {
  if (browser) return;
  assert.ok(chrome, "built pages exist but no Chrome was found (set CHROME_BIN): this must fail, not skip");
  assert.ok(DESIGNS.length >= 2, `the build's map holds ${DESIGNS.length} design(s); two are needed (registered entries with a declared author house)`);
  assert.ok(VISITED, "the build has a house that is not a design's author house");
  server = await serveDist(); base = `http://127.0.0.1:${server.address().port}`;
  browser = await launch(chrome);
}
after(() => { browser?.close(); server?.close(); });

const LINKS = (scope) => `[...document.querySelectorAll(${JSON.stringify(scope)} + " a")].filter((a) => /see it/.test(a.textContent)).map((a) => ({ design: a.getAttribute("data-hearth-preview"), href: a.getAttribute("href"), topic: a.closest("[data-topic], [data-ballot]")?.getAttribute("data-topic") ?? a.closest("[data-ballot]")?.getAttribute("data-ballot") }))`;

test("A on /votes/: each registered Hearth design's 'see it' is its live preview; the office's own link stays for the rest; clicked, it opens THAT design on its author's house", { skip: SKIP }, async () => {
  await setup();
  const o = office();
  const p = await openPage(browser, base, "/votes/", { width: 1280, office: o });
  await p.until(`document.querySelector("[data-topic='${HEARTH_BALLOT_TOPIC}'] .v-cand") !== null`, "the Hearth ballot");
  const links = await p.evalJs(LINKS("[data-votes]"));
  const hearth = links.filter((l) => l.topic === HEARTH_BALLOT_TOPIC);
  assert.deepEqual(hearth.filter((l) => l.design).map((l) => [l.design, l.href]), DESIGNS.map((d) => [d, MAP[d]]), "every registered design, to the build's own preview");
  assert.deepEqual(hearth.filter((l) => !l.design).map((l) => l.href), ["https://github.com/invented/elsewhere"], "a design this build cannot draw keeps the office's link");
  assert.deepEqual(links.filter((l) => l.topic === "harbor-lantern").map((l) => l.href), ["https://github.com/invented/lantern"], "another ballot's choice of the same name is not a design");
  await p.click(`[data-topic='${HEARTH_BALLOT_TOPIC}'] a[data-hearth-preview='${B}']`);
  await p.until(`location.pathname.startsWith("/households/") && document.querySelector("[data-hearth-stage]")?.dataset.hearthEntry === ${JSON.stringify(B)}`, `the ${B} preview`);
  const at = await p.evalJs(`({ path: location.pathname, entry: new URL(location.href).searchParams.get("entry"), drawn: document.querySelector("[data-hearth-stage]").dataset.hearthEntry, key: document.querySelector("[data-hearth]").dataset.hearthKey })`);
  assert.equal(at.path + "?entry=" + at.entry, MAP[B], "the address the link named");
  assert.equal(at.drawn, B, "and the named design is the one drawn");
  assert.equal(new URL(MAP[B], base).pathname, `/households/${at.key}/`, "on the author's house (its key and its route agree here)");
  await p.close();
});

test("A on the civic panel: the Hearth ballot's registered designs link to their previews; nothing else on the panel links", { skip: SKIP }, async () => {
  await setup();
  const p = await openPage(browser, base, "/town/#ballot-house", { width: 1280, office: office() });
  await p.until(`document.querySelector("[data-ballot-state='open']") !== null`, "the open ballots");
  const links = await p.evalJs(LINKS("[data-ballot-panel]"));
  assert.deepEqual(links.map((l) => [l.topic, l.design, l.href]), DESIGNS.map((d) => [HEARTH_BALLOT_TOPIC, d, MAP[d]]));
  await p.click(`[data-ballot='${HEARTH_BALLOT_TOPIC}'] a[data-hearth-preview='${A}']`);
  await p.until(`document.querySelector("[data-hearth-stage]")?.dataset.hearthEntry === ${JSON.stringify(A)}`, `the ${A} preview`);
  assert.equal(await p.evalJs(`location.pathname + location.search`), MAP[A]);
  await p.close();
});

const BACKING = "[data-hearth-backing]";
const shown = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden"; })()`;
const formOf = `document.querySelector("[data-hearth-backing-form] .bs")`;
/** Open the panel and wait for the FRESH ballot read it makes (the form waits for that answer), then for the panel to have settled on it. */
async function openPanel(p, o) {
  const reads = () => o.asked.filter((a) => a === "GET /api/votes").length;
  const before = reads();
  await p.click(".hearth-backing-sum");
  for (const end = Date.now() + 15_000; reads() === before;) { if (Date.now() > end) throw new Error("opening the panel made no fresh read"); await new Promise((r) => setTimeout(r, 50)); }
  await p.until(`document.querySelector("[data-hearth-backing-note]").hidden`, "the fresh read answered");
}
/**
 * CONTRAST: every element in the open panel that shows words (a text node, or a field's own value), its computed colour over the surface it sits on (the
 * panel's, or the field's own), at 4.5:1. The surface must be opaque for the number to mean anything. `atLeast` keeps the measure from passing on nothing.
 */
async function readsOnItsSurface(p, atLeast) {
  const pairs = await p.evalJs(`(() => {
    const rgb = (s) => (s.match(/[\\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const panel = document.querySelector(".hearth-backing-panel");
    const surface = (e) => { for (let x = e; x && x !== panel.parentElement; x = x.parentElement) { const b = rgb(getComputedStyle(x).backgroundColor); if ((b[3] ?? 1) > 0) return b; } return [0, 0, 0, 0]; };
    return [...panel.querySelectorAll("*")].filter((e) => e.getClientRects().length && (/^(INPUT|SELECT)$/.test(e.tagName) ? e.value : [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))).map((e) => {
      const bg = surface(e), c = rgb(getComputedStyle(e).color), a = c[3] ?? 1, mix = c.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a));
      const [L1, L2] = [lum(mix), lum(bg)].sort((x, y) => y - x);
      return { text: (e.value || e.textContent).trim().slice(0, 30), ratio: Math.round(((L1 + 0.05) / (L2 + 0.05)) * 10) / 10, bgAlpha: bg[3] ?? 1 };
    });
  })()`);
  assert.ok(pairs.length >= atLeast, `the panel's words were measured: ${JSON.stringify(pairs)}`);
  for (const x of pairs) { assert.equal(x.bgAlpha, 1, `"${x.text}" sits on an opaque surface`); assert.ok(x.ratio >= 4.5, `"${x.text}" reads at ${x.ratio}:1`); }
  return pairs;
}
async function pick(p, id) {
  await p.click("[data-hearth-lb-btn]");
  await p.until(shown(`#hearth-opt-${id}`), `the ${id} option`);
  await p.click(`#hearth-opt-${id}`);
  await p.until(`document.querySelector("[data-hearth-stage]")?.dataset.hearthEntry === ${JSON.stringify(id)}`, `${id} drawn`);
}

// POS-1066 visual FIX (Darko 2026-11-15 22:54 EST, via Wright 03:55:10Z): "oh actually, let's make it vote-orange, and just keep the stamp icon purple". The falsifiers
// (the brief): the icon disappears, becomes orange with the button, the label changes, or the picker and the button clip or overlap; at 1280 and 390, shut and open.
test("B's look: the control is vote-orange with the stamp icon in stamp purple, its words unchanged; it fits beside the picker at 1280 and 390, shut and open", { skip: SKIP }, async () => {
  await setup();
  const VOTE = "rgb(201, 130, 61)", STAMP = "rgb(170, 143, 216)";   // civic-art.mjs ACCENTS.votes.A; postmark.css --pm-stamp
  for (const width of [1280, 390]) {
    const o = office();
    const p = await openPage(browser, base, `/households/${VISITED}/?entry=${A}`, { width, height: 844, office: o, signedIn: true });
    await p.until(shown(BACKING), "Back this design");
    const look = () => p.evalJs(`(() => {
      const rgb = (s) => (s.match(/[\\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const sum = document.querySelector(".hearth-backing-sum"), icon = sum.querySelector(".hearth-backing-icon"), svg = icon?.querySelector("svg");
      const pick = document.querySelector("[data-hearth-lb-btn]").getBoundingClientRect(), r = sum.getBoundingClientRect(), ir = svg ? svg.getBoundingClientRect() : null;
      // the words' contrast: the summary's own wash laid over the first opaque background behind it (the page's night; a gradient image is not sampled)
      let under = null; for (let x = sum.parentElement; x && !under; x = x.parentElement) { const b = rgb(getComputedStyle(x).backgroundColor); if ((b[3] ?? 1) === 1 && b.length >= 3) under = b; }
      under = under || rgb(getComputedStyle(document.body).backgroundColor);
      const w = rgb(getComputedStyle(sum).backgroundColor), wa = w[3] ?? 1, bg = under.slice(0, 3).map((v, i) => w[i] * wa + v * (1 - wa));
      const [L1, L2] = [lum(rgb(getComputedStyle(sum).color)), lum(bg)].sort((a, b) => b - a);
      const overlap = !(r.right <= pick.left || pick.right <= r.left || r.bottom <= pick.top || pick.bottom <= r.top);
      return { words: sum.textContent.trim(), color: getComputedStyle(sum).color, iconColor: icon ? getComputedStyle(icon).color : null, iconSize: ir ? [Math.round(ir.width), Math.round(ir.height)] : null,
        iconHidden: icon?.getAttribute("aria-hidden"), iconFocusable: svg?.getAttribute("focusable"), wash: getComputedStyle(sum).backgroundColor,
        onScreen: r.left >= 0 && r.right <= innerWidth + 0.5, clipped: sum.scrollWidth > sum.clientWidth + 0.5, overlap, ratio: Math.round(((L1 + 0.05) / (L2 + 0.05)) * 10) / 10, scrollW: document.documentElement.scrollWidth, w: innerWidth };
    })()`);
    const shut = await look();
    assert.equal(shut.words, "Back this design", `${width}: the label is unchanged`);
    assert.equal(shut.color, VOTE, `${width}: the words are the vote-orange`);
    assert.equal(shut.iconColor, STAMP, `${width}: the stamp icon is stamp purple, not orange with the button`);
    assert.ok(shut.iconSize && shut.iconSize[0] >= 10 && shut.iconSize[1] >= 10, `${width}: the icon is drawn (${JSON.stringify(shut.iconSize)})`);
    assert.deepEqual([shut.iconHidden, shut.iconFocusable], ["true", "false"], `${width}: the icon is decorative and not focusable`);
    assert.deepEqual([shut.onScreen, shut.clipped, shut.overlap], [true, false, false], `${width}: on screen, unclipped, clear of the picker: ${JSON.stringify(shut)}`);
    assert.ok(shut.scrollW <= shut.w, `${width}: no sideways scroll`);
    assert.ok(shut.ratio >= 4.5, `${width}: the words read at ${shut.ratio}:1`);
    await openPanel(p, o);
    const open = await look();
    assert.deepEqual([open.words, open.color, open.iconColor], ["Back this design", VOTE, STAMP], `${width}: open, the same words and colours`);
    assert.notEqual(open.wash, shut.wash, `${width}: open deepens the wash`);
    assert.deepEqual([open.onScreen, open.clipped, open.overlap], [true, false, false], `${width}: open, still clear: ${JSON.stringify(open)}`);
    assert.ok(open.ratio >= 4.5, `${width}: open, the words read at ${open.ratio}:1`);
    await p.close();
  }
});

test("B: a signed-in visitor backs the design ON SCREEN as their own resident; switching designs cannot confirm one as the other; the save stays the house's", { skip: SKIP }, async () => {
  await setup();
  const o = office();
  const p = await openPage(browser, base, `/households/${VISITED}/?entry=${A}`, { width: 1280, office: o, signedIn: true });
  await p.until(shown(BACKING), "Back this design");
  const corner = await p.evalJs(`(() => { const c = document.querySelector(".pm-subrail-corner"); return { inCorner: c.contains(document.querySelector(${JSON.stringify(BACKING)})), afterPicker: !!(document.querySelector("[data-hearth-picker]").compareDocumentPosition(document.querySelector(${JSON.stringify(BACKING)})) & Node.DOCUMENT_POSITION_FOLLOWING), outsideDesign: !document.querySelector(".hearth-frame").contains(document.querySelector(${JSON.stringify(BACKING)})), says: document.querySelector(".hearth-backing-sum").textContent.trim() }; })()`);
  assert.deepEqual(corner, { inCorner: true, afterPicker: true, outsideDesign: true, says: "Back this design" }, "beside the dropdown, in the site's strip");
  assert.equal(await p.evalJs(shown("[data-hearth-acts]")), false, "the house's save is not this visitor's (the dropdown's own gate)");

  await openPanel(p, o);
  await p.until(`${formOf} && !document.querySelector("[data-hearth-backing-form] .bs-form").hidden`, "the stake form");
  const form = await p.evalJs(`({ from: [...document.querySelectorAll("[data-hearth-backing-form] select[name=from] option")].map((o) => o.value), on: [...document.querySelectorAll("[data-hearth-backing-form] select[name=candidate] option")].map((o) => o.value), ballot: document.querySelector("[data-hearth-backing-ballot]").textContent })`);
  assert.deepEqual(form.from, ["far-res"], "the signed-in human's own resident, from /me: not the house's");
  assert.deepEqual(form.on, [A], "the one design on screen");
  assert.match(form.ballot, /Postmark's default Hearth \(invented\)/);
  await p.type("[data-hearth-backing-form] input[name=stamps]", "3");
  await p.click("[data-hearth-backing-form] .bs-preview");
  await p.until(shown("[data-hearth-backing-form] .bs-confirm"), "the confirm, after the preview");
  assert.equal(o.posts.length, 1);
  await readsOnItsSurface(p, 10);                                     // the whole signed-in form and its preview, read on the panel

  await pick(p, B);                                                   // switch the dropdown to B: B's own form, nothing previewed
  const onB = await p.evalJs(`({ on: [...document.querySelectorAll("[data-hearth-backing-form] select[name=candidate] option")].map((o) => o.value), confirm: ${shown("[data-hearth-backing-form] .bs-confirm")}, open: document.querySelector(${JSON.stringify(BACKING)}).open })`);
  assert.deepEqual(onB, { on: [B], confirm: false, open: true }, "B has its own form, with no confirm to press");
  await pick(p, A);                                                   // back to A: A's preview is still A's
  await p.until(shown("[data-hearth-backing-form] .bs-confirm"), "A's confirm again");
  await p.click("[data-hearth-backing-form] .bs-confirm");
  await p.until(`/staked 3 of 3/.test(document.querySelector("[data-hearth-backing-form] .bs-out").textContent)`, "the receipt");
  const confirms = o.posts.filter((x) => !x.body.args.preview);
  assert.equal(confirms.length, 1);
  assert.deepEqual(confirms[0].body, { do: "stake-vote", args: { from: "far-res", topic: HEARTH_BALLOT_TOPIC, candidate: A, stamps: 3 } }, "exactly A, as previewed");
  assert.equal(confirms[0].auth, "Bearer invented-token");
  assert.ok(!o.posts.some((x) => x.body.args.candidate === B), "nothing was ever sent for B");
  await p.close();
});

test("B: a ballot that has closed takes the control away when the panel is reopened; unreadable, the same; staking again, it returns", { skip: SKIP }, async () => {
  await setup();
  const o = office();
  const p = await openPage(browser, base, `/households/${VISITED}/?entry=${A}`, { width: 1280, office: o, signedIn: true });
  await p.until(shown(BACKING), "Back this design");
  await openPanel(p, o);
  await p.until(`${formOf} !== null`, "the form");
  await p.click(".hearth-backing-sum");                              // close it
  o.votesAnswer = ok({ topics: [hearthBallot("closed"), OTHER] });
  await openPanel(p, o);                                             // reopen: a fresh read
  await p.until(`!${shown(BACKING)}`, "the control gone");
  assert.equal(await p.evalJs(`document.querySelector(${JSON.stringify(BACKING)}).dataset.hearthBacking`), "closed");
  assert.equal(await p.evalJs(`document.querySelectorAll("[data-hearth-backing-form] .bs").length`), 0, "no form left on the page");
  o.votesAnswer = { status: 503, json: { error: "down" } };
  await p.evalJs(`document.dispatchEvent(new Event("visibilitychange")), true`);
  await p.until(`document.querySelector(${JSON.stringify(BACKING)}).dataset.hearthBacking === "unreadable"`, "unreadable");
  assert.equal(await p.evalJs(shown(BACKING)), false);
  o.votesAnswer = ok({ topics: [hearthBallot("staking")] });
  await p.evalJs(`document.dispatchEvent(new Event("visibilitychange")), true`);
  await p.until(shown(BACKING), "back while staking");
  assert.equal(o.posts.length, 0, "nothing was sent");
  await p.close();
});

test("B signed out: the form says to sign in and the panel offers the site's sign-in; on a phone the panel fits and its words read on its surface", { skip: SKIP }, async () => {
  await setup();
  const o = office();
  const p = await openPage(browser, base, `/households/${VISITED}/?entry=${A}`, { width: 390, height: 844, office: o });
  await p.until(shown(BACKING), "Back this design");
  await openPanel(p, o);
  await p.until(`${formOf} !== null && /Sign in to stake/.test(document.querySelector("[data-hearth-backing-form] .bs-gate").textContent)`, "the sign-in line");
  assert.equal(await p.evalJs(shown("[data-hearth-backing-form] .bs-form")), false, "no form without a sign-in");
  assert.equal(await p.evalJs(shown("[data-hearth-backing-signin]")), true, "the site's sign-in, offered");
  const m = await p.evalJs(`(() => { const r = document.querySelector(".hearth-backing-panel").getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth, scrollW: document.documentElement.scrollWidth }; })()`);
  assert.ok(m.l >= 0 && m.r <= m.w + 0.5, `the panel runs off a 390 px screen: ${JSON.stringify(m)}`);
  assert.ok(m.scrollW <= m.w, `the page scrolls sideways: ${JSON.stringify(m)}`);
  await readsOnItsSurface(p, 3);
  await p.close();
});
