// Floating usage panel in the corner: pops up when the app opens and when a
// build starts, and counts tokens and cost live while the AI works.

import { balances, el, fmtCost, fmtTokens, openModels } from "/models.js";

const $ = (sel) => document.querySelector(sel);
const SEEN = "openforge.dock.seen";

let today = null;
let month = null;
let build = null;
let open = false;

function emptyTotals() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, unpricedCalls: 0 };
}

function add(t, call) {
  t.calls++;
  t.inputTokens += call.inputTokens;
  t.outputTokens += call.outputTokens;
  if (call.cost === undefined) t.unpricedCalls++;
  else t.cost += call.cost;
}

function tokens(t) {
  return fmtTokens(t.inputTokens + t.outputTokens);
}

async function refreshTotals() {
  try {
    const res = await fetch("/api/usage");
    const u = await res.json();
    today = u.today;
    month = u.last30Days;
  } catch {
    // Keep the last numbers.
  }
  render();
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshTotals, 400);
}

function setOpen(value) {
  open = value;
  render();
}

function totalsRow(label, t) {
  return el(
    "div",
    { className: "dock-row" },
    el("span", { className: "dock-label" }, label),
    el("span", { className: "dock-num" }, `${tokens(t)} tokens`),
    el("span", { className: "dock-num" }, fmtCost(t.cost, t.unpricedCalls)),
  );
}

function render() {
  const dock = $("#usage-dock");
  if (!dock) return;
  const running = build?.running;
  dock.classList.toggle("open", open);
  dock.classList.toggle("running", Boolean(running));

  const pillTotals = build ?? today;
  const pill = $("#dock-pill");
  pill.setAttribute("aria-expanded", String(open));
  pill.replaceChildren(
    el("span", { className: "dock-dot", "aria-hidden": "true" }),
    pillTotals ? `${tokens(pillTotals)} tokens · ${fmtCost(pillTotals.cost, pillTotals.unpricedCalls)}` : "Usage",
    el("span", { className: "muted" }, build ? (running ? " this build" : " last build") : " today"),
  );

  const body = $("#dock-body");
  const minimize = el("button", { type: "button", className: "dock-min", "aria-label": "Minimize usage panel", title: "Minimize" }, "–");
  minimize.addEventListener("click", () => {
    setOpen(false);
    $("#dock-pill").focus();
  });
  body.replaceChildren(minimize);
  if (build) {
    body.append(
      el("h3", {}, running ? "This build, live" : "Last build"),
      el("div", { className: "dock-big" }, `${tokens(build)} tokens`),
      el("div", { className: "muted small" }, `${fmtTokens(build.inputTokens)} in · ${fmtTokens(build.outputTokens)} out · ${fmtCost(build.cost, build.unpricedCalls)} · ${build.calls} call${build.calls === 1 ? "" : "s"}`),
    );
    if (build.byModel.size) {
      body.append(
        el(
          "ul",
          { className: "dock-models" },
          [...build.byModel.values()].map((m) =>
            el("li", {}, el("span", { className: "dock-model" }, m.name), el("span", { className: "dock-num" }, `${tokens(m)} · ${fmtCost(m.cost, m.unpricedCalls)}`)),
          ),
        ),
      );
    }
    for (const s of build.switches) body.append(el("p", { className: "dock-switch small" }, s));
  }
  body.append(el("h3", {}, "Your usage"));
  if (today) body.append(totalsRow("Today", today), totalsRow("Last 30 days", month));
  else body.append(el("p", { className: "muted small" }, "No AI calls yet."));
  const balanceList = el("div", { className: "dock-balances" });
  body.append(balanceList);
  balances().then((list) => {
    if (list.length) balanceList.replaceChildren(el("h3", {}, "Account balance"), ...list.map((b) => el("div", { className: "dock-row" }, el("span", { className: "dock-label" }, b.name), el("span", { className: "dock-num" }, b.text))));
  });
  const details = el("button", { type: "button", className: "link-btn small" }, "All usage details");
  details.addEventListener("click", () => openModels("usage-panel"));
  body.append(details);
}

export function initDock() {
  const dock = el(
    "aside",
    { id: "usage-dock", className: "usage-dock", "aria-label": "AI usage" },
    el("div", { id: "dock-body", className: "dock-body" }),
    el("button", { id: "dock-pill", type: "button", className: "dock-pill", "aria-controls": "dock-body" }),
  );
  document.body.append(dock);
  $("#dock-pill").addEventListener("click", () => setOpen(!open));
  document.addEventListener("keydown", (e) => e.key === "Escape" && open && !document.querySelector("dialog[open]") && setOpen(false));
  // Pop up once per visit with what has been used so far.
  let seen = false;
  try {
    seen = sessionStorage.getItem(SEEN) === "1";
    sessionStorage.setItem(SEEN, "1");
  } catch {
    // Storage blocked: pop up every time.
  }
  open = !seen;
  refreshTotals();
}

/** A build or edit started: pop the panel open and count from zero. */
export function dockBuildStart(replay = false) {
  build = { ...emptyTotals(), byModel: new Map(), switches: [], running: true };
  if (replay) render();
  else setOpen(true);
}

export function dockOpen() {
  setOpen(true);
}

/** Counts a call into this build; today's totals are re-read from the server so nothing is counted twice. */
export function dockEvent(event) {
  if (!build) return;
  if (event.type === "usage") {
    const c = event.call;
    add(build, c);
    refreshSoon();
    const key = `${c.connectionName} · ${c.model}`;
    if (!build.byModel.has(key)) build.byModel.set(key, { ...emptyTotals(), name: key });
    add(build.byModel.get(key), c);
  }
  if (event.type === "switch") build.switches.push(event.message);
  render();
}

export function dockBuildEnd() {
  if (build) build.running = false;
  refreshTotals();
}

/** Opening a finished site shows its saved totals instead of an empty build. */
export function dockShowSite(usage) {
  if (build?.running) return;
  build = usage?.calls ? { ...usage, byModel: new Map(), switches: [], running: false } : null;
  render();
}
