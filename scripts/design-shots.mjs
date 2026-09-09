/**
 * Design conformance shots: the signed mock beside what the branch renders.
 *
 * Every UI pull request carries a side-by-side comparison of each signed state
 * (Phase 1 plan, conformance guard 1: "A page without this comparison is not
 * reviewable"). This produces them, so a second review round can regenerate
 * them after a fix instead of someone re-doing it by hand.
 *
 * No dependencies, deliberately. Relay does not ship a browser driver and does
 * not need one to take a screenshot: Chrome speaks the DevTools Protocol over a
 * WebSocket, and Node has had one since 22. The browser used is whichever
 * Chrome or Chromium is on the machine, named by CHROME.
 *
 *   npm run dev                     # in another shell, with DEV_USER_EMAIL set
 *   node scripts/design-shots.mjs   # writes docs/design/<task>/*.jpg
 *
 * Environment:
 *   MOCK     the signed mock, as a file:// URL. REQUIRED — it lives outside the
 *            repository, and there is no path worth guessing.
 *   APP      the running app, signed in as an admin (default localhost:5200)
 *   REP_APP  a second instance signed in as a rep. Optional; when it is set,
 *            the nav-roles comparison is produced as well.
 *   OUT      where the comparisons go   (default docs/design/task-9b)
 *   CHROME   the browser binary         (default chromium)
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const APP = process.env.APP ?? "http://localhost:5200";
const REP_APP = process.env.REP_APP;
const MOCK = process.env.MOCK;
if (MOCK === undefined || MOCK === "") {
  throw new Error(
    "MOCK is required: the file:// URL of the signed shell mock. It is not in this repository.",
  );
}
const OUT = process.env.OUT ?? "docs/design/task-9c";
const CHROME = process.env.CHROME ?? "chromium";
const PORT = Number(process.env.CDP_PORT ?? 9333);

const TMP = path.join(process.env.TMPDIR ?? "/tmp", "relay-design-shots");

/**
 * The signed mock's frames, by their index in document order.
 *
 * Counted from the mock rather than guessed: the campaign section (3b-3f) is
 * six frames, not the four the first pass assumed, so settings/content/dark
 * were three short and the comparison showed "Your people" where Settings
 * should have been.
 *
 *   0 1 · Home, smallest          9  3c · Campaign running
 *   1 1b · Home on day one       10  3c · Research stopped
 *   2 2a · Draft selected        11  3d · Start
 *   3 2b · Reply selected        12  3e · Your people, before reveal
 *   4 2c · Call selected         13  3f · Your people, after reveal
 *   5 2c · Inbox empty           14  5  · Settings
 *   6 3a · Campaigns list        15  6  · Content before its slice
 *   7 3b · Campaign, plan ready  16  6  · Home in dark
 *   8 3b-ii · Plan expanded
 */
const MOCK_FRAMES = {
  "mock-home-day-one": 1,
  "mock-inbox-empty": 5,
  "mock-campaigns-list": 6,
  "mock-campaign-plan-ready": 7,
  "mock-plan-expanded": 8,
  "mock-campaign-running": 9,
  "mock-campaign-stopped": 10,
  "mock-start": 11,
  "mock-settings": 14,
  "mock-content-coming": 15,
  "mock-home-dark": 16,
};

const APP_PAGES = { home: "/", content: "/content", inbox: "/inbox", campaigns: "/campaigns", settings: "/settings" };

/**
 * The Campaigns routes (Task 9c). The ids are the fixture adapter's own
 * (`src/lib/fixtures/campaigns.ts`), so a renamed fixture fails here loudly
 * rather than shooting a 404 and calling it a state.
 */
const CAMPAIGN_PAGES = {
  start: "/campaigns/new",
  "start-prefilled":
    "/campaigns/new?said=" +
    encodeURIComponent(
      "Managed print dealers in the Midlands who resell service contracts, sell them Insights360, partners not end users",
    ),
  "campaign-researching": "/campaigns/midlands-fleet-operators",
  "campaign-plan-ready": "/campaigns/managed-print-partners-midlands",
  "campaign-running": "/campaigns/uk-logistics-ops",
  "campaign-stopped": "/campaigns/vets-scotland",
};

/** One row per signed state: what to show, in what order. */
const STATES = [
  ["home-day-one", "Home, day one (signed mock section 1b)",
    [["Signed mock", "mock-home-day-one"], ["Built, light", "app-home-light"], ["Built, dark", "app-home-dark"]]],
  ["content-coming", "Content before its slice (signed mock section 6)",
    [["Signed mock", "mock-content-coming"], ["Built, light", "app-content-light"], ["Built, dark", "app-content-dark"]]],
  ["inbox-empty", "Inbox, empty (signed mock section 2c)",
    [["Signed mock", "mock-inbox-empty"], ["Built, light", "app-inbox-light"], ["Built, dark", "app-inbox-dark"]]],
  ["campaigns-list", "Campaigns, the list (signed mock section 3a)",
    [["Signed mock", "mock-campaigns-list"], ["Built, light", "app-campaigns-light"], ["Built, dark", "app-campaigns-dark"]]],
  ["start", "Start, nothing said yet (signed mock section 3d)",
    [["Signed mock", "mock-start"], ["Built, light", "app-start-light"], ["Built, dark", "app-start-dark"]]],
  ["start-prefilled", "Start, pre-filled from the sentence (signed mock section 3d)",
    [["Signed mock", "mock-start"], ["Built, light", "app-start-prefilled-light"], ["Built, dark", "app-start-prefilled-dark"]]],
  ["campaign-researching", "Campaign page, Researching (§23.1c; the mock draws the state row in 3b)",
    [["Signed mock", "mock-campaign-plan-ready"], ["Built, light", "app-campaign-researching-light"], ["Built, dark", "app-campaign-researching-dark"]]],
  ["campaign-plan-ready", "Campaign page, Plan ready (signed mock section 3b)",
    [["Signed mock", "mock-campaign-plan-ready"], ["Built, light", "app-campaign-plan-ready-light"], ["Built, dark", "app-campaign-plan-ready-dark"]]],
  ["plan-expanded", "The plan, one card expanded, and the unknowns card (signed mock 3b-ii)",
    [["Signed mock", "mock-plan-expanded"], ["Built, light", "app-plan-expanded-light"], ["Built, dark", "app-plan-expanded-dark"]]],
  ["campaign-running", "Campaign page, Running (signed mock section 3c)",
    [["Signed mock", "mock-campaign-running"], ["Built, light", "app-campaign-running-light"], ["Built, dark", "app-campaign-running-dark"]]],
  ["campaign-stopped", "Campaign page, the research stop (signed mock section 3c)",
    [["Signed mock", "mock-campaign-stopped"], ["Built, light", "app-campaign-stopped-light"], ["Built, dark", "app-campaign-stopped-dark"]]],
  ["settings", "Settings (signed mock section 5; the cards fill in with Task 10b)",
    [["Signed mock", "mock-settings"], ["Built, light", "app-settings-light"], ["Built, dark", "app-settings-dark"]]],
  ["home-dark", "Home in dark (signed mock section 6 draws the populated Home)",
    [["Signed mock", "mock-home-dark"], ["Built, dark", "app-home-dark"], ["Built, light", "app-home-light"]]],
  ["home-focus", "The brief box with focus in it (WCAG 2.4.7; the mock draws no focus state)",
    [["Built, light", "app-focus-light"], ["Built, dark", "app-focus-dark"]]],
];

/** Only producible with a second instance signed in as a rep. */
const ROLE_STATE = ["nav-roles", "The nav: Admin for an admin, absent for a rep",
  [["Signed mock (admin)", "mock-home-day-one"], ["Built, admin", "app-home-light"], ["Built, rep", "rep-home-light"]]];

async function launch() {
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`, "about:blank",
  ], { stdio: "ignore" });

  // Without this a missing binary surfaces as an uncaught ENOENT from the
  // event loop rather than as the message below.
  let failed;
  chrome.on("error", (error) => { failed = error; });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page !== undefined) return { chrome, ws: page.webSocketDebuggerUrl };
    } catch {
      // not listening yet
    }
    if (failed !== undefined) {
      chrome.kill();
      throw new Error(`could not run ${CHROME}: ${failed.message}`);
    }
    await sleep(100);
  }
  // Both throws are BEFORE the try/finally below, so the browser they leave
  // behind is not the finally's to clean up — and a Chrome still holding the
  // debugging port is the next run's failure, which is the one thing the
  // finally exists to prevent.
  chrome.kill();
  throw new Error(`${CHROME} did not start a debuggable page on ${PORT}`);
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  let ready;
  const opened = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  // Marked handled: if the socket closes before anything awaits it, an
  // unrejected promise would take the process down with an unrelated message.
  opened.catch(() => {});
  socket.addEventListener("open", () => ready.resolve());

  // A browser that dies mid-run must fail the script rather than hang it: every
  // send is waiting on a reply that is never coming.
  const die = (why) => {
    const error = new Error(`the browser connection ${why}`);
    ready.reject(error);
    for (const waiter of pending.values()) waiter({ error: { message: why } });
    pending.clear();
  };
  socket.addEventListener("error", () => die("failed"));
  socket.addEventListener("close", () => die("closed"));

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter !== undefined) { pending.delete(message.id); waiter(message); }
  });
  return {
    async send(method, params = {}) {
      await opened;
      id += 1;
      const mine = id;
      const answer = new Promise((resolve) => pending.set(mine, resolve));
      socket.send(JSON.stringify({ id: mine, method, params }));
      const message = await answer;
      if (message.error) throw new Error(`${method}: ${message.error.message}`);
      return message.result;
    },
    close: () => socket.close(),
  };
}

mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });

const { chrome, ws } = await launch();
const cdp = connect(ws);

const evaluate = (expression) => cdp.send("Runtime.evaluate", { expression });
const viewport = (width, height) =>
  cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });

async function capture(name, clip) {
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: clip !== undefined, ...(clip === undefined ? {} : { clip }),
  });
  writeFileSync(path.join(TMP, `${name}.png`), Buffer.from(data, "base64"));
}

async function boxOf(expression) {
  const { result } = await evaluate(`(() => {
    const el = ${expression};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 });
  })()`);
  return result.value === null ? null : JSON.parse(result.value);
}

try {
await cdp.send("Page.enable");

// The signed mock, frame by frame.
await viewport(1320, 1200);
await cdp.send("Page.navigate", { url: MOCK });
await sleep(2000);
for (const [name, index] of Object.entries(MOCK_FRAMES)) {
  const box = await boxOf(`document.querySelectorAll(".frame")[${index}]`);
  if (box === null) throw new Error(`the mock has no frame ${index} for ${name}`);
  await capture(name, box);
}

// The running app, each page in both themes.
await viewport(1280, 760);
async function shootApp(origin, prefix, routes) {
  for (const [name, route] of Object.entries(routes)) {
    for (const theme of ["light", "dark"]) {
      await cdp.send("Page.navigate", { url: `${origin}${route}` });
      await sleep(2000);
      await evaluate(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)})`);
      // Next's development indicator is not part of the product.
      await evaluate(`document.querySelectorAll("nextjs-portal").forEach((el) => el.remove())`);
      await sleep(500);
      await capture(`${prefix}-${name}-${theme}`);
    }
  }
}

await shootApp(APP, "app", APP_PAGES);
await shootApp(APP, "app", CAMPAIGN_PAGES);

/**
 * The plan with one card open (mock 3b-ii).
 *
 * Its own pass rather than a route, because "expanded" is a live state: the
 * card is a disclosure the rep opens, and there is no url that lands on it.
 * The card opened is "Their pain, in their words", which is the one the signed
 * mock draws open.
 */
for (const theme of ["light", "dark"]) {
  await cdp.send("Page.navigate", { url: `${APP}/campaigns/managed-print-partners-midlands` });
  await sleep(2000);
  await evaluate(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)})`);
  await evaluate(`document.querySelectorAll("nextjs-portal").forEach((el) => el.remove())`);
  const { result } = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-testid="plan-card"]')];
    const card = cards[2];
    if (!card) return "no third plan card on the campaign page";
    const toggle = card.querySelector("button");
    if (!toggle) return "the plan card has no disclosure to open";
    toggle.click();
    return "";
  })()`);
  if (result.value !== "") throw new Error(`plan-expanded: ${result.value}`);
  await sleep(500);
  await capture(`app-plan-expanded-${theme}`);
}

/**
 * Home with focus in the brief box, in both themes.
 *
 * Its own pass rather than a route, because focus is a live state: the page has
 * to be loaded, the field focused, and the shot taken while it still is. The
 * signed mock draws no focus state at all, so this comparison is the built page
 * against itself in the two themes — which is the whole of what 2.4.7 asks.
 */
for (const theme of ["light", "dark"]) {
  await cdp.send("Page.navigate", { url: `${APP}/` });
  await sleep(2000);
  await evaluate(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)})`);
  await evaluate(`document.querySelectorAll("nextjs-portal").forEach((el) => el.remove())`);
  const { result } = await evaluate(`(() => {
    const field = document.querySelector('textarea[name="sentence"]');
    if (!field) return "no brief box on Home";
    field.focus();
    return document.activeElement === field ? "" : "the brief box did not take focus";
  })()`);
  if (result.value !== "") throw new Error(`home-focus: ${result.value}`);
  await sleep(500);
  await capture(`app-focus-${theme}`);
}

// The rep's nav is the same page signed in as somebody without the admin item,
// so it needs a second instance rather than a second route.
const states = [...STATES];
if (REP_APP !== undefined && REP_APP !== "") {
  await shootApp(REP_APP, "rep", { home: "/" });
  states.push(ROLE_STATE);
} else {
  console.log("REP_APP is unset, so nav-roles was not produced.");
}

// One comparison image per signed state, stacked so each pane is full width.
const inline = (name) => `data:image/png;base64,${readFileSync(path.join(TMP, `${name}.png`)).toString("base64")}`;
const page = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#fff;font:14px/1.5 system-ui,sans-serif;color:#272f4a}
  section{padding:20px 24px 28px}
  h2{margin:0 0 4px;font-size:18px}
  .why{margin:0 0 14px;color:#6b7280;font-size:13px}
  .row{display:grid;grid-template-columns:1fr;gap:18px}
  figure{margin:0}
  figcaption{font-size:13px;margin:0 0 6px;font-weight:600}
  img{width:100%;display:block;border:1px solid #e6e8ef;border-radius:8px}
</style>${states.map(([id, title, panes]) => `<section id="${id}"><h2>${title}</h2>
<p class="why">The signed mock first, then this branch. Any difference is a finding.</p>
<div class="row">${panes.map(([caption, file]) => `<figure><figcaption>${caption}</figcaption><img src="${inline(file)}"></figure>`).join("")}</div></section>`).join("")}`;

const composed = path.join(TMP, "compare.html");
writeFileSync(composed, page);
// Scale 1 for the composed sheet: the panes inside it are already 2x
// captures, and composing at 2x again quadruples the bytes committed to the
// repository for no more detail.
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1360, height: 1000, deviceScaleFactor: 1, mobile: false,
});
await cdp.send("Page.navigate", { url: `file://${composed}` });
await sleep(2500);

for (const [id] of states) {
  const box = await boxOf(`document.getElementById(${JSON.stringify(id)})`);
  if (box === null) throw new Error(`the composed page has no section ${id}`);
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "jpeg", quality: 84, captureBeyondViewport: true, clip: box,
  });
  writeFileSync(path.join(OUT, `${id}.jpg`), Buffer.from(data, "base64"));
  console.log(`${OUT}/${id}.jpg`);
}

} finally {
  // A headless browser left holding the debugging port is the next run's
  // failure, so it is closed whether this finished or threw.
  cdp.close();
  chrome.kill();
}
