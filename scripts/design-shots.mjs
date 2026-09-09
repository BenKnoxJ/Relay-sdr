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
 *   SET      which set of signed states to shoot: 9b or 9c (the shell, Home
 *            and Campaigns, one set since Task 9c; the key picks OUT) or
 *            6b (the bench, which renders the slice 1 screens from fixtures).
 *            Default 9b.
 *   OUT      where the comparisons go   (default docs/design/task-<SET>)
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
const SET = process.env.SET ?? "9b";
const OUT = process.env.OUT ?? `docs/design/task-${SET}`;
const ONLY = process.env.ONLY ?? "";
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
const MOCK_FRAMES_9B = {
  "mock-home-day-one": 1,
  "mock-inbox-draft": 2,
  "mock-inbox-reply": 3,
  "mock-inbox-call": 4,
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

/**
 * The frames the bench stands in for.
 *
 * The bench renders slice 1's screens from checked-in output, so its comparison
 * is against the slice 1 frames — the plan expanded, the draft selected, Your
 * people after the reveal, and Start pre-filled. What is being compared is the
 * component, not the page around it: the bench draws no nav and no step strip,
 * and those absences are expected rather than findings.
 */
const MOCK_FRAMES_6B = {
  "mock-draft-selected": 2,
  "mock-plan-expanded": 8,
  "mock-start": 11,
  "mock-your-people": 13,
};

const APP_PAGES_9B = { home: "/", content: "/content", inbox: "/inbox", campaigns: "/campaigns", settings: "/settings" };

const APP_PAGES_6B = {
  plan: "/bench/research/insurance-direct",
  draft: "/bench/outreach/first-email",
  people: "/bench/leadgen/after-reveal",
  start: "/bench/orchestrator/pre-fill",
};

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
const STATES_9B = [
  ["home-day-one", "Home, day one (signed mock section 1b)",
    [["Signed mock", "mock-home-day-one"], ["Built, light", "app-home-light"], ["Built, dark", "app-home-dark"]]],
  ["content-coming", "Content before its slice (signed mock section 6)",
    [["Signed mock", "mock-content-coming"], ["Built, light", "app-content-light"], ["Built, dark", "app-content-dark"]]],
  ["inbox-draft", "Inbox, a draft selected (signed mock section 2a)",
    [["Signed mock", "mock-inbox-draft"], ["Built, light", "app-inbox-draft-light"], ["Built, dark", "app-inbox-draft-dark"]]],
  ["inbox-draft-reject", "Inbox, the draft's four reject reasons open (signed mock section 2a draws them under the card)",
    [["Signed mock", "mock-inbox-draft"], ["Built, light", "app-inbox-reject-light"], ["Built, dark", "app-inbox-reject-dark"]]],
  ["inbox-needs-you", "Inbox, a draft that needs the rep (signed mock section 2a, the first row of Drafts)",
    [["Signed mock", "mock-inbox-draft"], ["Built, light", "app-inbox-needs-you-light"], ["Built, dark", "app-inbox-needs-you-dark"]]],
  ["inbox-reply", "Inbox, a reply selected (signed mock section 2b)",
    [["Signed mock", "mock-inbox-reply"], ["Built, light", "app-inbox-light"], ["Built, dark", "app-inbox-dark"]]],
  ["inbox-call", "Inbox, a call selected (signed mock section 2c)",
    [["Signed mock", "mock-inbox-call"], ["Built, light", "app-inbox-call-light"], ["Built, dark", "app-inbox-call-dark"]]],
  ["inbox-call-spoke", "Inbox, Spoke asking for one line (signed mock section 2c draws the box under the outcomes)",
    [["Signed mock", "mock-inbox-call"], ["Built, light", "app-inbox-spoke-light"], ["Built, dark", "app-inbox-spoke-dark"]]],
  ["inbox-empty", "Inbox, empty, reached by working every row (signed mock section 2c)",
    [["Signed mock", "mock-inbox-empty"], ["Built, light", "app-inbox-empty-light"], ["Built, dark", "app-inbox-empty-dark"]]],
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

const STATES_6B = [
  ["plan-cards", "The research pack in the plan cards (signed mock 3b-ii), from a checked-in pack",
    [["Signed mock", "mock-plan-expanded"], ["Built, light", "app-plan-light"], ["Built, dark", "app-plan-dark"]]],
  ["approve-card", "A draft on the Approve card (signed mock 2a), from a checked-in draft",
    [["Signed mock", "mock-draft-selected"], ["Built, light", "app-draft-light"], ["Built, dark", "app-draft-dark"]]],
  ["your-people", "Your people after the reveal (signed mock 3f), from a checked-in reveal",
    [["Signed mock", "mock-your-people"], ["Built, light", "app-people-light"], ["Built, dark", "app-people-dark"]]],
  ["start-prefill", "Start, pre-filled, with the guessed fields dashed (signed mock 3d)",
    [["Signed mock", "mock-start"], ["Built, light", "app-start-light"], ["Built, dark", "app-start-dark"]]],
];

const SETS = {
  // Task 9c added the Campaigns frames and states to the shell set in place, so
  // "9b" and "9c" are one set; the key only picks the output directory.
  "9b": { frames: MOCK_FRAMES_9B, pages: { ...APP_PAGES_9B, ...CAMPAIGN_PAGES }, states: STATES_9B, focusPass: true, roles: true, campaigns: true },
  "9c": { frames: MOCK_FRAMES_9B, pages: { ...APP_PAGES_9B, ...CAMPAIGN_PAGES }, states: STATES_9B, focusPass: true, roles: true, campaigns: true },
  "6b": { frames: MOCK_FRAMES_6B, pages: APP_PAGES_6B, states: STATES_6B, focusPass: false, roles: false },
};

const chosen = SETS[SET];
if (chosen === undefined) {
  throw new Error(`SET must be one of ${Object.keys(SETS).join(", ")}, not ${JSON.stringify(SET)}`);
}
const MOCK_FRAMES = chosen.frames;
const APP_PAGES = chosen.pages;
const STATES = chosen.states;

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

/**
 * The Inbox's states (Task 9d, mock 2a, 2b, 2c and empty).
 *
 * Its own pass rather than routes, because every one of them is a live state
 * of one page: which row is selected, whether the reasons are open, and — for
 * empty — that every row has been worked. `/inbox` itself lands on the first
 * row, a reply, which is 2b and is already shot above as `app-inbox-*`.
 *
 * The rows are found by their test ids and the buttons by their text, which
 * is the copy file's; a renamed button fails here loudly rather than shooting
 * the wrong state and calling it signed.
 */
const INBOX_STATES = {
  draft: `rows()[4].click();`,
  reject: `rows()[4].click(); await tick(); button("Reject…").click();`,
  "needs-you": `rows()[3].click();`,
  call: `rows()[2].click();`,
  spoke: `rows()[2].click(); await tick(); button("Spoke").click();`,
  empty: `
    // Two labels, one outcome, three approves.
    button("Warm").click(); await tick();
    button("Warm").click(); await tick();
    button("Voicemail").click(); await tick();
    button("Approve").click(); await tick();
    button("Approve").click(); await tick();
    button("Approve").click(); await tick();
  `,
};

for (const [name, steps] of Object.entries(INBOX_STATES)) {
  for (const theme of ["light", "dark"]) {
    await cdp.send("Page.navigate", { url: `${APP}/inbox` });
    await sleep(2000);
    await evaluate(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)})`);
    await evaluate(`document.querySelectorAll("nextjs-portal").forEach((el) => el.remove())`);
    const { result } = await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `(async () => {
        const rows = () => [...document.querySelectorAll('[data-testid="queue-row"]')];
        const button = (text) => {
          const found = [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === text);
          if (!found) throw new Error("no button " + JSON.stringify(text) + " on the Inbox");
          return found;
        };
        const tick = () => new Promise((resolve) => setTimeout(resolve, 150));
        if (rows().length === 0) throw new Error("no rows on the Inbox: is the queue rendering?");
        ${steps}
        await tick();
        // Focus stays where the click left it, and the ring is not the state.
        document.activeElement?.blur();
        return "";
      })().catch((error) => error.message)`,
    });
    if (result.value !== "") throw new Error(`inbox-${name}: ${result.value}`);
    await sleep(500);
    await capture(`app-inbox-${name}-${theme}`);
  }
}

/**
 * The plan with one card open (mock 3b-ii).
 *
 * Its own pass rather than a route, because "expanded" is a live state: the
 * card is a disclosure the rep opens, and there is no url that lands on it.
 * The card opened is "Their pain, in their words", which is the one the signed
 * mock draws open.
 */
for (const theme of chosen.campaigns ? ["light", "dark"] : []) {
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
for (const theme of chosen.focusPass ? ["light", "dark"] : []) {
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
if (!chosen.roles) {
  // Nothing on the bench differs by role: it is one developer's own screen.
} else if (REP_APP !== undefined && REP_APP !== "") {
  await shootApp(REP_APP, "rep", { home: "/" });
  states.push(ROLE_STATE);
} else {
  console.log("REP_APP is unset, so nav-roles was not produced.");
}

// One comparison image per signed state, stacked so each pane is full width.
// Filtered last rather than first: the app shots are cheap, and a filter
// applied to the capture loops is one more place for a name to drift.
const wanted = states.filter(([id]) => id.startsWith(ONLY));
if (wanted.length === 0) throw new Error(`ONLY=${JSON.stringify(ONLY)} matches no state`);
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
</style>${wanted.map(([id, title, panes]) => `<section id="${id}"><h2>${title}</h2>
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

for (const [id] of wanted) {
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
