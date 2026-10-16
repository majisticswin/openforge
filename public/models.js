// AI models panel: add connections from one dropdown, pick a model for each,
// scan for local servers, and show token usage and cost.

const $ = (sel) => document.querySelector(sel);
const STORAGE = "openforge.models";

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.includes("-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children.flat().filter((c) => c !== undefined && c !== null && c !== false));
  return node;
}

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

export function fmtCost(n, unknown = 0) {
  if (n === undefined || n === null) return "unknown";
  const text = n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  return unknown > 0 ? `${text} + unpriced` : text;
}

// ---------- State (kept in this browser only) ----------

let state = { connections: [], roles: {} };
let presets = [];
let localServers = [];
const accountCache = new Map();
const listeners = new Set();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE));
    if (saved && Array.isArray(saved.connections)) state = { connections: saved.connections, roles: saved.roles ?? {} };
  } catch {
    // Storage blocked: start empty.
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(state));
  } catch {
    // Private mode: settings last for this page view only.
  }
  for (const fn of listeners) fn();
}

export function onChange(fn) {
  listeners.add(fn);
}

export function activeConnections() {
  return state.connections.filter((c) => c.enabled !== false);
}

/** What the server needs to run a job: connections without cached model lists, plus role choices. */
export function requestBody() {
  return {
    connections: activeConnections().map(({ models: _models, ...rest }) => rest),
    roles: state.roles,
  };
}

function shortModel(c) {
  if (!c.model) return "auto";
  return c.model.replace(/^models\//, "").split("/").pop();
}

export function teamSummary() {
  const active = activeConnections();
  if (active.length === 0) return "";
  const builder = active.find((c) => c.id === state.roles.builder) ?? rankSorted(active)[0];
  const others = active.filter((c) => c !== builder);
  const name = (c) => `${c.name} (${shortModel(c)})`;
  return others.length ? `${name(builder)} builds · ${others.map(name).join(", ")} plan and review` : `${name(builder)} does everything`;
}

function rankSorted(list) {
  const order = ["anthropic", "openai", "gemini", "compatible", "mock"];
  const rank = (c) => order.indexOf(c.kind) * 2 + (c.local ? 1 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b));
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

// ---------- Setup ----------

export async function initModels() {
  load();
  try {
    const config = await api("/api/config");
    presets = config.presets ?? [];
    for (const server of config.serverConnections ?? []) {
      if (!state.connections.some((c) => c.id === server.id)) state.connections.push({ ...server, enabled: true });
    }
    // Drop server connections that the server no longer has.
    const serverIds = new Set((config.serverConnections ?? []).map((c) => c.id));
    state.connections = state.connections.filter((c) => !c.fromServer || serverIds.has(c.id));
    save();
  } catch {
    // Server unreachable: keep what we have.
  }
  renderAddSelect();
  wirePanel();
}

function renderAddSelect() {
  const select = $("#add-select");
  select.replaceChildren(el("option", { value: "" }, "+ Add an AI…"));
  const group = (label, items) => items.length && select.append(el("optgroup", { label }, items));
  group(
    "Found running on this computer",
    localServers.map((s, i) => el("option", { value: `found:${i}` }, `${s.name} · ${s.models.length} model${s.models.length === 1 ? "" : "s"}`)),
  );
  group("Major AI providers", presets.filter((p) => p.group === "major").map((p) => el("option", { value: p.id }, p.name)));
  group("Cloud LLMs", presets.filter((p) => p.group === "cloud").map((p) => el("option", { value: p.id }, p.name)));
  group("Local models (add by hand)", presets.filter((p) => p.group === "local").map((p) => el("option", { value: p.id }, p.name)));
  group("Try it", [el("option", { value: "mock" }, "Demo model (no key needed)")]);
}

let wired = false;
function wirePanel() {
  if (wired) return;
  wired = true;

  $("#add-select").addEventListener("change", (e) => {
    const value = e.target.value;
    e.target.value = "";
    if (!value) return;
    if (value === "mock") return addConnection({ id: newId(), kind: "mock", name: "Demo model", model: "mock", local: true, enabled: true, models: [{ id: "mock", name: "Demo model", free: true }] });
    if (value.startsWith("found:")) {
      const server = localServers[Number(value.slice(6))];
      if (!server) return;
      const existing = state.connections.find((c) => c.baseURL === server.baseURL);
      if (existing) return flash(`${server.name} is already added.`);
      return addConnection({ id: newId(), kind: "compatible", name: server.name, baseURL: server.baseURL, preset: server.preset, local: true, enabled: true, model: server.models[0]?.id, models: server.models });
    }
    openAddForm(presets.find((p) => p.id === value));
  });

  $("#add-cancel").addEventListener("click", closeAddForm);
  $("#add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const preset = presets.find((p) => p.id === $("#add-form").dataset.preset);
    if (!preset) return;
    const connection = {
      id: newId(),
      kind: preset.kind,
      name: $("#add-name").value.trim() || preset.name,
      apiKey: $("#add-key").value.trim() || undefined,
      baseURL: preset.kind === "compatible" ? $("#add-url").value.trim() : undefined,
      preset: preset.id,
      local: preset.group === "local" || /\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test($("#add-url").value),
      enabled: true,
    };
    if (preset.needsKey && !connection.apiKey) return showAddError("Paste your API key first.");
    if (connection.kind === "compatible" && !/^https?:\/\//.test(connection.baseURL)) return showAddError("Enter the server address, starting with http:// or https://");
    $("#add-submit").disabled = true;
    $("#add-submit").textContent = "Connecting…";
    showAddError("");
    try {
      const { models } = await api("/api/models", { connection });
      if (models.length === 0) throw new Error("Connected, but no models were listed for this key.");
      connection.models = models;
      connection.model = defaultModel(connection.kind, models);
      applyModelPrice(connection);
      closeAddForm();
      addConnection(connection);
    } catch (err) {
      showAddError(err.message);
    } finally {
      $("#add-submit").disabled = false;
      $("#add-submit").textContent = "Connect and load models";
    }
  });

  $("#scan-btn").addEventListener("click", scanLocal);
  $("#settings-close").addEventListener("click", () => $("#settings").close());
  document.querySelectorAll("#settings [role=tab]").forEach((tab) =>
    tab.addEventListener("click", () => showPanel(tab.dataset.panel)),
  );
}

function showPanel(id) {
  document.querySelectorAll("#settings [role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.panel === id)));
  $("#models-panel").hidden = id !== "models-panel";
  $("#usage-panel").hidden = id !== "usage-panel";
  if (id === "usage-panel") renderUsage();
}

export function openModels(panel = "models-panel") {
  renderConnections();
  showPanel(panel);
  $("#settings").showModal();
  if (localServers.length === 0) scanLocal();
}

function flash(message) {
  $("#scan-status").textContent = message;
}

function showAddError(message) {
  $("#add-error").textContent = message;
}

function openAddForm(preset) {
  if (!preset) return;
  const form = $("#add-form");
  form.dataset.preset = preset.id;
  form.hidden = false;
  $("#add-title").textContent = `Add ${preset.name}`;
  $("#add-note").textContent = preset.note ?? "";
  $("#add-name").value = preset.name.replace(/\s*\(.*\)$/, "");
  $("#add-url-row").hidden = preset.kind !== "compatible";
  $("#add-url").value = preset.baseURL ?? "";
  $("#add-key").value = "";
  $("#add-key").placeholder = preset.needsKey ? "Paste your API key" : "Only if your server needs one";
  $("#add-key-link").hidden = !preset.keyUrl;
  if (preset.keyUrl) $("#add-key-link").href = preset.keyUrl;
  showAddError("");
  (preset.kind === "compatible" && !preset.baseURL ? $("#add-url") : preset.needsKey ? $("#add-key") : $("#add-name")).focus();
}

function closeAddForm() {
  $("#add-form").hidden = true;
}

/** A sensible first choice from a model list: the strongest general model for the big three, else the first. */
function defaultModel(kind, models) {
  const ids = models.map((m) => m.id);
  if (kind === "anthropic") return ids.find((id) => id === "claude-opus-5-5") ?? ids.find((id) => id.includes("opus")) ?? ids[0];
  if (kind === "openai") return ids.find((id) => /^gpt-\d/.test(id) && !/(mini|nano)/.test(id)) ?? ids[0];
  if (kind === "gemini") return ids.find((id) => /pro/.test(id) && !/(preview|exp)/.test(id)) ?? ids.find((id) => /pro/.test(id)) ?? ids[0];
  return ids[0];
}

/** Uses the price the provider published for this model (OpenRouter does), unless the user typed one. */
function applyModelPrice(c) {
  const info = c.models?.find((m) => m.id === c.model);
  if (info?.price && !c.customPrice) c.price = info.price;
  else if (!c.customPrice) delete c.price;
}

function addConnection(c) {
  state.connections.push(c);
  save();
  renderConnections();
  flash(`Added ${c.name}.`);
}

async function scanLocal() {
  const btn = $("#scan-btn");
  btn.disabled = true;
  flash("Looking for AI models running on this computer…");
  try {
    const { servers } = await api("/api/local/scan");
    localServers = servers;
    renderAddSelect();
    const fresh = servers.filter((s) => !state.connections.some((c) => c.baseURL === s.baseURL));
    if (servers.length === 0) flash("No local AI servers found. Start Ollama, LM Studio or another local server, then scan again.");
    else if (fresh.length === 0) flash(`Found ${servers.map((s) => s.name).join(", ")}. Already added.`);
    else flash(`Found ${fresh.map((s) => `${s.name} (${s.models.length} models)`).join(", ")}. Pick it from the dropdown to add it.`);
  } catch (err) {
    flash(`Scan failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Connection cards ----------

function badgeFor(c) {
  if (c.fromServer) return el("span", { className: "badge server", title: "Key set on the OpenForge server" }, "Server key");
  if (c.kind === "mock") return el("span", { className: "badge" }, "Demo");
  if (c.local) return el("span", { className: "badge local" }, "Local · free");
  if (c.kind === "compatible") return el("span", { className: "badge cloud" }, "Cloud");
  return el("span", { className: "badge cloud" }, "API");
}

function modelLabel(m) {
  const bits = [m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id];
  if (m.free) bits.push("free");
  else if (m.price) bits.push(`$${+m.price.input.toFixed(3)} / $${+m.price.output.toFixed(3)} per 1M`);
  if (m.contextLength) bits.push(`${fmtTokens(m.contextLength)} context`);
  if (m.size) bits.push(`${(m.size / 1e9).toFixed(1)} GB`);
  return bits.join(" · ");
}

export function renderConnections() {
  const list = $("#connection-list");
  list.replaceChildren();
  $("#no-connections").hidden = state.connections.length > 0;
  const builderId = (activeConnections().find((c) => c.id === state.roles.builder) ?? rankSorted(activeConnections())[0])?.id;

  for (const c of state.connections) {
    const select = el("select", { "aria-label": `Model for ${c.name}` });
    select.append(el("option", { value: "" }, "Automatic (best available)"));
    const models = c.models ?? [];
    for (const m of models) select.append(el("option", { value: m.id }, modelLabel(m)));
    if (c.model && !models.some((m) => m.id === c.model)) select.append(el("option", { value: c.model }, c.model));
    select.value = c.model ?? "";
    select.addEventListener("change", () => {
      c.model = select.value || undefined;
      applyModelPrice(c);
      save();
      renderConnections();
    });

    const refresh = el("button", { type: "button", className: "ghost small-btn", title: "Reload the model list" }, "Refresh");
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      refresh.textContent = "Loading…";
      try {
        const { models: fresh } = await api("/api/models", { connection: { ...c, models: undefined } });
        c.models = fresh;
        save();
        renderConnections();
      } catch (err) {
        refresh.textContent = "Failed";
        refresh.title = err.message;
        flash(`${c.name}: ${err.message}`);
      }
    });

    const enabled = el("input", { type: "checkbox", checked: c.enabled !== false });
    enabled.addEventListener("change", () => {
      c.enabled = enabled.checked;
      save();
      renderConnections();
    });

    const builder = el("input", { type: "radio", name: "builder", checked: c.id === builderId, disabled: c.enabled === false });
    builder.addEventListener("change", () => {
      state.roles.builder = c.id;
      save();
      renderConnections();
    });

    const remove = el("button", { type: "button", className: "link-btn" }, "Remove");
    remove.hidden = Boolean(c.fromServer);
    remove.addEventListener("click", () => {
      state.connections = state.connections.filter((x) => x !== c);
      if (state.roles.builder === c.id) delete state.roles.builder;
      save();
      renderConnections();
    });

    const meta = el(
      "div",
      { className: "conn-meta" },
      el("label", {}, enabled, "Use"),
      el("label", { title: "This model writes the code. The others plan and review." }, builder, "Writes the code"),
      priceEditor(c),
      el("span", { className: "account" }),
      remove,
    );

    const item = el(
      "li",
      { className: `conn${c.enabled === false ? " disabled" : ""}` },
      el("div", { className: "conn-top" }, el("span", { className: "conn-name" }, c.name), badgeFor(c), c.baseURL ? el("span", { className: "muted small" }, c.baseURL) : null),
      el("div", { className: "conn-model" }, select, c.kind === "mock" ? null : refresh),
      meta,
    );
    list.append(item);
    renderAccount(c, meta.querySelector(".account"));
  }
}

/** For models without a published price, let people enter one so costs can be tracked. */
function priceEditor(c) {
  if (c.local || c.kind === "mock") return el("span", {}, "Cost: free");
  if (c.kind === "anthropic" && !c.customPrice) return el("span", {}, "Cost: priced automatically");
  const modelPrice = c.models?.find((m) => m.id === c.model)?.price;
  if (modelPrice && !c.customPrice) return el("span", {}, `Cost: $${+modelPrice.input.toFixed(3)} in / $${+modelPrice.output.toFixed(3)} out per 1M`);
  const input = el("input", { type: "number", min: "0", step: "0.01", placeholder: "in", value: c.price?.input ?? "", "aria-label": "Dollars per million input tokens" });
  const output = el("input", { type: "number", min: "0", step: "0.01", placeholder: "out", value: c.price?.output ?? "", "aria-label": "Dollars per million output tokens" });
  const update = () => {
    if (input.value === "" || output.value === "") {
      delete c.price;
      delete c.customPrice;
    } else {
      c.price = { input: Number(input.value), output: Number(output.value) };
      c.customPrice = true;
    }
    save();
  };
  input.addEventListener("change", update);
  output.addEventListener("change", update);
  return el("span", { className: "conn-price", title: "Optional: the provider's price, so OpenForge can show what you spend" }, "$ per 1M tokens", input, output);
}

async function renderAccount(c, slot) {
  if (c.local || c.kind === "mock") return;
  const key = `${c.id}:${c.apiKey ?? ""}`;
  try {
    if (!accountCache.has(key)) accountCache.set(key, api("/api/account", { connection: { ...c, models: undefined } }));
    const info = await accountCache.get(key);
    const parts = [];
    if (info.supported) {
      if (info.remaining !== undefined) parts.push(`Balance: ${info.currency === "USD" || !info.currency ? "$" : info.currency + " "}${Number(info.remaining).toFixed(2)} left`);
      if (info.used !== undefined) parts.push(`used $${Number(info.used).toFixed(2)}${info.limit ? ` of $${info.limit}` : ""}`);
    }
    slot.replaceChildren(
      parts.length ? parts.join(", ") + " " : "",
      info.dashboardUrl ? el("a", { href: info.dashboardUrl, target: "_blank", rel: "noopener" }, info.supported ? "Details" : "Account usage ↗") : "",
    );
  } catch {
    accountCache.delete(key);
  }
}

// ---------- Usage ----------

function stat(label, totals) {
  return el(
    "div",
    { className: "stat" },
    el("div", { className: "label" }, label),
    el("div", { className: "value" }, `${fmtTokens(totals.inputTokens + totals.outputTokens)} tokens`),
    el("div", { className: "sub" }, `${fmtTokens(totals.inputTokens)} in · ${fmtTokens(totals.outputTokens)} out · ${fmtCost(totals.cost, totals.unpricedCalls)}`),
    el("div", { className: "sub" }, `${totals.calls} AI call${totals.calls === 1 ? "" : "s"}`),
  );
}

function table(target, headers, rows, empty) {
  const t = $(target);
  t.replaceChildren(el("thead", {}, el("tr", {}, headers.map(([h, num]) => el("th", { className: num ? "num" : "" }, h)))));
  const body = el("tbody");
  if (rows.length === 0) body.append(el("tr", {}, el("td", { className: "empty", colSpan: headers.length }, empty)));
  for (const row of rows) body.append(el("tr", {}, row.map((cell, i) => el("td", { className: headers[i][1] ? "num" : "" }, cell))));
  t.append(body);
}

export async function renderUsage() {
  let u;
  try {
    u = await api("/api/usage");
  } catch (err) {
    $("#usage-stats").replaceChildren(el("p", { className: "error" }, err.message));
    return;
  }
  $("#usage-stats").replaceChildren(stat("Today", u.today), stat("Last 30 days", u.last30Days), stat("All time", u.allTime));
  const notes = ["Token counts come from what each provider reports for every call OpenForge makes."];
  if (u.allTime.estimatedCalls) notes.push(`${u.allTime.estimatedCalls} call(s) were on servers that don't report usage, so those counts are estimated.`);
  if (u.allTime.unpricedCalls) notes.push(`${u.allTime.unpricedCalls} call(s) have no known price. Add a price on the model in the AI models tab to include them in costs.`);
  $("#usage-note").textContent = notes.join(" ");

  const totalCols = (t) => [t.calls, fmtTokens(t.inputTokens), fmtTokens(t.outputTokens), fmtCost(t.cost, t.unpricedCalls)];
  const numHeaders = [["Calls", true], ["Input", true], ["Output", true], ["Cost", true]];
  table("#usage-models", [["Model"], ...numHeaders], u.byModel.map((m) => [`${m.connectionName} · ${m.model}`, ...totalCols(m)]), "No AI calls yet.");
  table(
    "#usage-projects",
    [["Site"], ...numHeaders],
    u.byProject.map((p) => [el("a", { href: `#${p.projectId}`, onclick: () => $("#settings").close() }, p.projectName), ...totalCols(p)]),
    "No sites built yet.",
  );
  table(
    "#usage-recent",
    [["When"], ["Step"], ["Model"], ["Input", true], ["Output", true], ["Cost", true], ["Time", true]],
    u.recent.map((r) => [
      new Date(r.at).toLocaleString(),
      r.role,
      `${r.connectionName} · ${r.model}`,
      fmtTokens(r.inputTokens) + (r.estimated ? "*" : ""),
      fmtTokens(r.outputTokens) + (r.estimated ? "*" : ""),
      fmtCost(r.cost),
      `${(r.durationMs / 1000).toFixed(1)}s`,
    ]),
    "No AI calls yet.",
  );
}
