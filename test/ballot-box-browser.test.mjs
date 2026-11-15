// ballot-box-browser.test.mjs — the Ballot Box, RENDERED from the office's answer on the built page (POS-1054).
//
//   node --test test/ballot-box-browser.test.mjs
//
// It serves the built site (dist-town/, what `npm run build` makes; the built-pages CI job builds it first), drives headless Chrome over
// CDP (Node's global WebSocket; a throwaway profile, no sync, no extensions) and answers GET /api/votes ITSELF through CDP's Fetch
// domain with INVENTED replies that a step can change: the live board is never touched, nothing is signed in, and nothing is staked.
// The page's static shell holds no tally: whatever shows came from the answer given here, and a second answer changes it WITHOUT a
// rebuild. WITHOUT dist-town the test SKIPS and says so; WITH built pages and no browser it FAILS (built-pages cannot turn a skip into
// a pass).

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
async function launch(chrome) {
  const profile = mkdtempSync(join(tmpdir(), "pos1054-profile-"));
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
  if (server) { server.closeAllConnections?.(); await Promise.race([new Promise((ok) => server.close(ok)), new Promise((ok) => setTimeout(ok, 3000).unref())]); }
});

// the invented office: `answer` is what GET /api/votes says now ({ code, body } or { fail: true } for a dropped connection)
const office = { answer: null, reads: 0, writes: 0 };
const cand = (candidate, staked) => ({ candidate, staked });
const topic = (t, status, candidates, extra = {}) => ({ topic: t, status, cap_per_household_per_candidate: 20, window: "the office's own words about the window", candidates, ...extra });
const HEARTH = topic("hearth-names", "staking", [cand("Emberlight", 14), cand("Kettle Song", 0), cand("The Long Table", 31), cand("Ash & Ivy", 7)]);
const SUBS = topic("lantern-colours", "submissions", [cand("Amber", 0), cand("Dusk blue", 0)]);
const PAST = topic("older-vote", "closed", [cand("Iris", 22), cand("Oriel", 9)]);
const ok = (topics, extra = {}) => ({ code: 200, body: JSON.stringify({ topics, note: "stakes are escrow", ...extra }) });

async function openPage({ width = 1280, height = 900 } = {}) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => browser.send(m, p, sessionId);
  await S("Page.enable");
  await S("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await S("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("pm.office.base", "/api"); } catch (e) {}` });
  await S("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" }] });
  const listener = (m) => {
    if (m.sessionId !== sessionId || m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const url = request?.url ?? "";
    if (/\/api\/votes\/stake/.test(url) || request.method !== "GET") { office.writes += 1; return S("Fetch.fulfillRequest", { requestId, responseCode: 418, body: "" }).catch(() => {}); }
    if (/\/api\/votes(\?|$)/.test(url)) {
      office.reads += 1;
      if (office.answer.fail) return S("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }).catch(() => {});
      return S("Fetch.fulfillRequest", { requestId, responseCode: office.answer.code, responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "cache-control", value: "no-store" }], body: Buffer.from(office.answer.body ?? "").toString("base64") }).catch(() => {});
    }
    return S("Fetch.fulfillRequest", { requestId, responseCode: 404, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from("{}").toString("base64") }).catch(() => {});
  };
  browser.listeners.push(listener);
  await S("Page.navigate", { url: base + "/votes/" });
  const evalJs = async (expression) => {
    const r = await S("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (js, what, ms = 15_000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await evalJs(js)) return; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`timed out waiting for ${what} (the box says: ${await evalJs(`document.querySelector("[data-votes]")?.textContent.replace(/\\s+/g, " ").slice(0, 300)`)})`);
  };
  return { evalJs, until, send: S, close: async () => { browser.listeners.splice(browser.listeners.indexOf(listener), 1); await browser.send("Target.closeTarget", { targetId }).catch(() => {}); } };
}

// what the page drew, by section
const DRAWN = `(() => {
  const secs = {}; for (const s of document.querySelectorAll("[data-section]")) secs[s.dataset.section] = [...s.querySelectorAll(".v-topic")].map((t) => ({
    topic: t.dataset.topic, h: t.querySelector("h3").textContent, chip: t.querySelector(".v-chip").textContent,
    cands: [...t.querySelectorAll(".v-cand")].map((c) => [c.querySelector(".v-cand-name").textContent, c.querySelector(".v-cand-n").textContent.replace(/\\s*stamps$/, ""), Math.round(parseFloat(c.querySelector(".v-cand-fill").style.width) || 0)]) }));
  return { secs, text: document.querySelector("[data-votes]").textContent.replace(/\\s+/g, " "), unreadable: !!document.querySelector("[data-unreadable]"), intake: document.querySelector("[data-intake]")?.textContent ?? null, empty: !!document.querySelector(".v-empty"), scrollWidth: document.documentElement.scrollWidth };
})()`;

test("POS-1054: an invented Hearth-shaped open ballot, a submissions ballot and a closed one land in the right sections; every design and its backing stays visible (zero too)", { skip: SKIP, timeout: 120_000 }, async () => {
  await boot();
  office.answer = ok([PAST, SUBS, HEARTH]);
  const p = await openPage();
  try {
    await p.until(`document.querySelector("[data-section=staking]") !== null`, "the board");
    const d = await p.evalJs(DRAWN);
    assert.deepEqual(Object.keys(d.secs).sort(), ["closed", "staking", "submissions"]);
    assert.deepEqual(d.secs.staking[0].cands, [["Emberlight", "14", 45], ["Kettle Song", "0", 0], ["The Long Table", "31", 100], ["Ash & Ivy", "7", 23]], "all four designs, in the office's order, the zero one too");
    assert.equal(d.secs.staking[0].h, "hearth names");
    assert.equal(d.secs.staking[0].chip, "staking");
    assert.deepEqual(d.secs.submissions.map((t) => t.topic), ["lantern-colours"], "taking designs is its own place, apart from staking");
    assert.deepEqual(d.secs.closed.map((t) => t.topic), ["older-vote"], "only the closed ballot is under past ballots");
    assert.ok(d.text.indexOf("Open for backing") < d.text.indexOf("Taking designs") && d.text.indexOf("Taking designs") < d.text.indexOf("Past ballots"), "open first, then submissions, then the past");
    assert.ok(!/coming soon/i.test(await p.evalJs(`document.body.innerText`)), "no 'coming soon' anywhere on the page");
    assert.ok(!/illuminator/i.test(await p.evalJs(`document.body.innerText`)), "and no Iris/Illuminator board");
    assert.equal(await p.evalJs(`document.querySelectorAll("[data-votes] .v-topic").length`), 3, "nothing but the office's three ballots");
    assert.equal(office.writes, 0, "nothing was staked or written");
  } finally { await p.close(); }
});

test("POS-1054: a SECOND office answer changes the displayed backing without a rebuild", { skip: SKIP, timeout: 120_000 }, async () => {
  await boot();
  office.answer = ok([HEARTH]);
  const p = await openPage();
  try {
    await p.until(`document.querySelector("[data-section=staking]") !== null`, "the first board");
    assert.equal((await p.evalJs(DRAWN)).secs.staking[0].cands[1][1], "0");
    office.answer = ok([topic("hearth-names", "staking", [cand("Emberlight", 14), cand("Kettle Song", 9), cand("The Long Table", 31), cand("Ash & Ivy", 7)])]);
    await p.evalJs(`window.__same = "same document"; document.dispatchEvent(new Event("visibilitychange")); true`);
    await p.until(`document.querySelector("[data-cand-probe]") === null && [...document.querySelectorAll(".v-cand")].some((c) => c.textContent.includes("Kettle Song") && c.querySelector(".v-cand-n").textContent.startsWith("9"))`, "the new backing to show");
    assert.equal(await p.evalJs(`window.__same`), "same document", "the same document: no rebuild, no reload");
    assert.ok(office.reads >= 2, "it read the office again");
  } finally { await p.close(); }
});

test("POS-1054: failed or malformed replies stay visibly unreadable: never 'no ballots', never zero, never a board", { skip: SKIP, timeout: 180_000 }, async () => {
  await boot();
  const cases = [
    ["a 500", { code: 500, body: JSON.stringify({ error: "the office tripped" }) }],
    ["a dropped connection", { fail: true }],
    ["not JSON", { code: 200, body: "<html>oops" }],
    ["JSON with no topics", { code: 200, body: JSON.stringify({ note: "x" }) }],
    ["a refusal that still carries topics", { code: 503, body: JSON.stringify({ topics: [HEARTH] }) }],
  ];
  for (const [label, answer] of cases) {
    office.answer = answer;
    const p = await openPage();
    try {
      await p.until(`document.querySelector("[data-unreadable]") !== null`, `${label}: the unreadable notice`);
      const d = await p.evalJs(DRAWN);
      assert.equal(d.unreadable, true, label);
      assert.deepEqual(d.secs, {}, `${label}: no ballot is drawn`);
      assert.equal(d.empty, false, `${label}: never "no ballots"`);
      assert.ok(!/\b0 stamps\b/.test(d.text), `${label}: no zero shown`);
    } finally { await p.close(); }
  }
  office.answer = ok([]);
  const p = await openPage();
  try {
    await p.until(`document.querySelector(".v-empty") !== null`, "a readable empty list");
    assert.match((await p.evalJs(DRAWN)).text, /no ballots at all/, "only a readable empty reply says none");
  } finally { await p.close(); }
});

test("POS-1054: an intake note is intake (not a zero-backed ballot); an unknown status is not filed as past; hostile strings render as text", { skip: SKIP, timeout: 120_000 }, async () => {
  await boot();
  const HOSTILE = "<img src=x onerror=\"window.__pwned=1\"> & \"q\"";
  office.answer = ok([HEARTH, topic("odd-status", "archived", [cand("Whoever", 3)]), topic("<script>window.__pwned=1</script>", "staking", [cand(HOSTILE, 5)])], { awaiting_intake: ["fresh-ballot"], awaiting_intake_note: "x" });
  const p = await openPage();
  try {
    await p.until(`document.querySelector("[data-intake]") !== null && document.querySelector("[data-section=unknown]") !== null`, "the intake note and the unrecognised section");
    const d = await p.evalJs(DRAWN);
    assert.match(d.intake, /fresh ballot/, "the intake note names it");
    assert.ok(!Object.values(d.secs).flat().some((t) => t.topic === "fresh-ballot"), "and it is not drawn as a ballot with nothing staked");
    assert.deepEqual(d.secs.unknown.map((t) => t.topic), ["odd-status"], "an unknown status is shown as unrecognised");
    assert.equal(d.secs.closed, undefined, "and is NOT under past ballots");
    assert.ok(d.secs.staking.some((t) => t.cands[0][0] === HOSTILE), "a hostile design name is shown as its own text");
    assert.equal(await p.evalJs(`window.__pwned === undefined && document.querySelectorAll("[data-votes] img, [data-votes] script").length === 0`), true, "nothing was parsed as markup");
  } finally { await p.close(); }
});

test("POS-1054 (lead FIX): an unreadable design list is said to be unreadable (not 'no designs'); a true [] says none; only-unknown or unnamed ballots do not claim 'no ballot is open / past below'", { skip: SKIP, timeout: 180_000 }, async () => {
  await boot();
  const read = async (answer) => {
    office.answer = answer;
    const p = await openPage();
    try {
      await p.until(`document.querySelector("[data-votes] .v-topic, [data-votes] .v-empty, [data-votes] [data-unreadable]") !== null`, "the page to draw");
      await new Promise((r) => setTimeout(r, 300));
      return await p.evalJs(`(() => { const t = document.querySelector("[data-votes]"); return { text: t.textContent.replace(/\\s+/g, " "), stages: [...t.querySelectorAll(".v-cands .v-stage")].map((e) => e.textContent) }; })()`);
    } finally { await p.close(); }
  };
  const noList = await read(ok([{ topic: "no-list", status: "staking", cap_per_household_per_candidate: 20, window: "w" }, { topic: "null-list", status: "staking", candidates: null }, { topic: "obj-list", status: "staking", candidates: { candidate: "A", staked: 1 } }]));
  assert.equal(noList.stages.length, 3);
  for (const s of noList.stages) assert.match(s, /could not be read, so none are shown\. That does not mean it has none\./);
  assert.ok(!/lists no designs/.test(noList.text), "never 'the office lists no designs' for an unreadable list");
  const trueEmpty = await read(ok([topic("really-empty", "staking", [])]));
  assert.deepEqual(trueEmpty.stages, ["The office lists no designs on this ballot yet."], "a true [] still says none");
  const unknownOnly = await read(ok([topic("odd", "archived", [cand("A", 1)])]));
  assert.ok(!/No ballot is open right now/.test(unknownOnly.text) && !/Past ballots are below/.test(unknownOnly.text), "an unrecognised status is not 'no ballot open, past below'");
  assert.match(unknownOnly.text, /No ballot is shown as open here, and some of what the office sent could not be sorted/);
  const unnamed = await read(ok([{ status: "staking", candidates: [cand("A", 1)] }, { topic: "", status: "staking" }]));
  assert.ok(!/No ballot is open right now/.test(unnamed.text) && !/Past ballots are below/.test(unnamed.text));
  const plain = await read(ok([PAST]));
  assert.match(plain.text, /No ballot is open right now\. Past ballots are below\./, "when everything was sorted and only past ballots exist, the plain sentence stands");
  const huge = await read(ok([topic("huge", "staking", [cand("A", "9".repeat(400)), cand("B", 4)])]));
  assert.match(huge.text, /unreadable/);
});

for (const [name, width] of [["desktop 1280", 1280], ["phone 390", 390]]) {
  test(`POS-1054 (${name}): the board fits the view, and the how-to names the doors and the two things a stake needs`, { skip: SKIP, timeout: 120_000 }, async () => {
    await boot();
    office.answer = ok([HEARTH, SUBS, PAST]);
    const p = await openPage({ width });
    try {
      await p.until(`document.querySelector("[data-section=staking]") !== null`, "the board");
      const d = await p.evalJs(DRAWN);
      assert.ok(d.scrollWidth <= width, `no horizontal overflow (${d.scrollWidth} > ${width})`);
      const how = await p.evalJs(`document.querySelector("#how-to-stake").innerText`);
      for (const w of ["topic", "design", "stake-vote", "stake_topic", "writing desk"]) assert.ok(how.includes(w), `the how-to says ${w}`);
      assert.ok(/Straight away/.test(how) && /next crossing/.test(how), "direct stakes and mailed stakes are told apart");
      assert.ok(/the topic is hearth-names/.test(d.text), "each open ballot says which topic to name");
    } finally { await p.close(); }
  });
}
