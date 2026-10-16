const $ = (sel) => document.querySelector(sel);
const KEYS_STORAGE = "openforge.keys";

// ---------- AI model settings (kept in this browser only) ----------

function loadKeys() {
  try {
    return JSON.parse(localStorage.getItem(KEYS_STORAGE)) ?? {};
  } catch {
    return {};
  }
}

function saveKeys(keys) {
  try {
    localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys));
  } catch {
    // Private mode: keys live only for this page view.
  }
}

let keys = loadKeys();
let serverKeys = {};

function fillSettings() {
  $("#key-anthropic").value = keys.anthropic?.apiKey ?? "";
  $("#model-anthropic").value = keys.anthropic?.model ?? "";
  $("#key-openai").value = keys.openai?.apiKey ?? "";
  $("#model-openai").value = keys.openai?.model ?? "";
  $("#key-gemini").value = keys.gemini?.apiKey ?? "";
  $("#model-gemini").value = keys.gemini?.model ?? "";
  $("#local-url").value = keys.local?.baseURL ?? "";
  $("#local-model").value = keys.local?.model ?? "";
  $("#key-local").value = keys.local?.apiKey ?? "";
  $("#use-mock").checked = Boolean(keys.mock);
}

function readSettings() {
  const v = (id) => $(id).value.trim();
  keys = {
    anthropic: v("#key-anthropic") ? { apiKey: v("#key-anthropic"), model: v("#model-anthropic") } : undefined,
    openai: v("#key-openai") ? { apiKey: v("#key-openai"), model: v("#model-openai") } : undefined,
    gemini: v("#key-gemini") ? { apiKey: v("#key-gemini"), model: v("#model-gemini") } : undefined,
    local: v("#local-url") && v("#local-model") ? { baseURL: v("#local-url"), model: v("#local-model"), apiKey: v("#key-local") } : undefined,
    mock: $("#use-mock").checked,
  };
  saveKeys(keys);
}

function teamNames() {
  const names = [];
  if (keys.anthropic || serverKeys.anthropic) names.push("Claude");
  if (keys.openai || serverKeys.openai) names.push("GPT");
  if (keys.gemini || serverKeys.gemini) names.push("Gemini");
  if (keys.local || serverKeys.local) names.push("Local model");
  if (keys.mock || serverKeys.mock) names.push("Demo model");
  return names;
}

function renderTeam() {
  const names = teamNames();
  $("#models-dot").classList.toggle("on", names.length > 0);
  $("#team-line").textContent = names.length ? `Team: ${names.join(" + ")}` : "Add an AI model to start";
  $("#create-btn").disabled = names.length === 0;
}

$("#settings-btn").addEventListener("click", () => {
  fillSettings();
  $("#settings").showModal();
});
$("#settings").addEventListener("close", () => {
  if ($("#settings").returnValue === "save") {
    readSettings();
    renderTeam();
  }
});

// ---------- Projects ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

$("#create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = $("#prompt").value.trim();
  if (!prompt) return;
  $("#create-btn").disabled = true;
  try {
    const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ prompt, keys }) });
    location.hash = project.id;
  } catch (err) {
    alert(err.message);
  } finally {
    renderTeam();
  }
});

document.querySelectorAll("[data-example]").forEach((btn) =>
  btn.addEventListener("click", () => {
    $("#prompt").value = btn.dataset.example;
    $("#prompt").focus();
  }),
);

$("#projects-btn").addEventListener("click", async () => {
  const list = $("#project-list");
  list.replaceChildren();
  const projects = await api("/api/projects").catch(() => []);
  if (projects.length === 0) list.append(el("li", { className: "muted" }, "No sites yet."));
  for (const p of projects) {
    const link = el("a", { href: `#${p.id}` }, el("strong", {}, p.plan?.name ?? "Untitled site"), el("div", { className: "muted" }, `${statusLabel(p.status)} · ${new Date(p.createdAt).toLocaleString()}`));
    link.addEventListener("click", () => $("#projects").close());
    list.append(el("li", {}, link));
  }
  $("#projects").showModal();
});

function statusLabel(status) {
  return { working: "Building", ready: "Ready", failed: "Failed" }[status] ?? status;
}

// ---------- Workspace ----------

let current = null;
let source = null;
let activeItem = null;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== undefined && c !== null));
  return node;
}

function addItem(text, state = "active", detail) {
  if (activeItem && activeItem.classList.contains("active")) {
    activeItem.classList.replace("active", "ok");
  }
  const item = el("li", { className: state }, el("div", {}, text), detail ? el("div", { className: "detail" }, detail) : null);
  $("#timeline").append(item);
  item.scrollIntoView({ block: "end", behavior: "smooth" });
  if (state === "active") activeItem = item;
  return item;
}

function setBusy(busy) {
  $("#edit-btn").disabled = busy;
  $("#edit").disabled = busy;
  document.querySelector(".forge-anim").classList.toggle("idle", !busy);
}

async function openProject(id) {
  source?.close();
  $("#home").hidden = true;
  $("#workspace").hidden = false;
  $("#timeline").replaceChildren();
  $("#preview").hidden = true;
  $("#preview-empty").hidden = false;
  $("#preview-status").textContent = "Your site will appear here once it passes its tests.";
  $("#open-btn").hidden = true;
  $("#download-btn").hidden = true;
  activeItem = null;

  try {
    current = await api(`/api/projects/${id}`);
  } catch (err) {
    addItem(err.message, "bad");
    return;
  }
  renderHeader();
  for (const h of current.history.slice(0, -1)) addItem(h.kind === "create" ? "Site created" : `Changed: ${h.text}`, "ok");

  source = new EventSource(`/api/projects/${id}/events`);
  source.onmessage = (msg) => handleEvent(JSON.parse(msg.data));
}

function renderHeader() {
  $("#site-name").textContent = current.plan?.name ?? "Planning your site…";
  $("#site-request").textContent = current.request;
  const r = current.roles;
  $("#site-team").textContent = r ? `Planner: ${r.planner} · Builder: ${r.builder} · Reviewers: ${r.reviewers.join(", ")}` : "";
}

let progressItem = null;

function handleEvent(event) {
  switch (event.type) {
    case "stage":
      progressItem = addItem(event.message);
      break;
    case "progress":
      if (progressItem) {
        const detail = progressItem.querySelector(".detail") ?? progressItem.appendChild(el("div", { className: "detail" }));
        detail.textContent = `${Math.round(event.chars / 1000)}k characters written`;
      }
      break;
    case "plan":
      current.plan = event.plan;
      renderHeader();
      addItem(
        `Plan ready: ${event.plan.pages.length} pages`,
        "ok",
        el("ul", {}, ...event.plan.pages.map((p) => el("li", {}, `${p.title ?? p.path} (${p.path})`))),
      );
      break;
    case "files":
      const count = `${event.files.length} file${event.files.length === 1 ? "" : "s"}`;
      addItem(event.round === 0 ? `Wrote ${count}` : `Updated ${count}`, "ok", event.files.join(", "));
      break;
    case "verify": {
      const passed = event.result.checks.filter((c) => c.ok).length;
      const total = event.result.checks.length;
      const failed = event.result.checks.filter((c) => !c.ok);
      addItem(`Automated tests: ${passed} of ${total} passed`, failed.length ? "warn" : "ok", failed.length ? el("ul", {}, ...failed.slice(0, 6).map((c) => el("li", {}, c.name))) : undefined);
      break;
    }
    case "review":
      addItem(
        el("span", {}, `${event.review.reviewer}: `, el("span", { className: "score" }, `${event.review.score}/10`)),
        "ok",
        el("div", {}, event.review.summary, event.review.issues.length ? el("ul", {}, ...event.review.issues.slice(0, 5).map((i) => el("li", {}, `${i.severity}: ${i.problem}`))) : null),
      );
      break;
    case "warning":
      addItem(event.message, "warn");
      break;
    case "status":
      if (event.status === "working") {
        setBusy(true);
      } else if (event.status === "ready") {
        setBusy(false);
        if (activeItem?.classList.contains("active")) activeItem.classList.replace("active", "ok");
        addItem("Your site is ready", "ok");
        showResult();
      } else if (event.status === "failed") {
        setBusy(false);
        if (activeItem?.classList.contains("active")) activeItem.classList.replace("active", "bad");
        addItem("Something went wrong", "bad", event.error);
        $("#preview-status").textContent = "The build stopped. See the details on the left.";
      }
      break;
  }
}

async function showResult() {
  current = await api(`/api/projects/${current.id}`);
  renderHeader();
  renderFiles();
  $("#download-btn").href = `/api/projects/${current.id}/download`;
  $("#download-btn").hidden = false;
  $("#preview-status").textContent = "Starting your site…";
  try {
    const { url } = await api(`/api/projects/${current.id}/preview`, { method: "POST" });
    $("#preview").src = url;
    $("#preview").hidden = false;
    $("#preview-empty").hidden = true;
    $("#open-btn").href = url;
    $("#open-btn").hidden = false;
  } catch (err) {
    $("#preview-status").textContent = `The preview could not start: ${err.message}`;
  }
}

function renderFiles() {
  const list = $("#file-list");
  list.replaceChildren();
  for (const file of current.files ?? []) {
    const btn = el("button", { type: "button" }, file);
    btn.addEventListener("click", async () => {
      list.querySelectorAll("button").forEach((b) => b.classList.remove("current"));
      btn.classList.add("current");
      const res = await fetch(`/api/projects/${current.id}/file?path=${encodeURIComponent(file)}`);
      $("#file-view").textContent = await res.text();
    });
    list.append(el("li", {}, btn));
  }
}

$("#edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const instruction = $("#edit").value.trim();
  if (!instruction || !current) return;
  addItem(`You asked: ${instruction}`, "ok");
  setBusy(true);
  try {
    await api(`/api/projects/${current.id}/edit`, { method: "POST", body: JSON.stringify({ instruction, keys }) });
    $("#edit").value = "";
  } catch (err) {
    setBusy(false);
    addItem(err.message, "bad");
  }
});

$("#edit").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#edit-form").requestSubmit();
  }
});

document.querySelectorAll("[role=tab]").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll("[role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    $("#preview-pane").hidden = tab.dataset.tab !== "preview";
    $("#code-pane").hidden = tab.dataset.tab !== "code";
  }),
);

// ---------- Routing ----------

function route() {
  const id = location.hash.slice(1);
  if (id) {
    openProject(id);
  } else {
    source?.close();
    $("#workspace").hidden = true;
    $("#home").hidden = false;
  }
}
window.addEventListener("hashchange", route);

api("/api/config")
  .then((config) => {
    serverKeys = config.serverKeys ?? {};
    const names = Object.entries(serverKeys).filter(([, on]) => on).map(([k]) => k);
    $("#server-keys").textContent = names.length ? `This server also has keys for: ${names.join(", ")}.` : "";
  })
  .catch(() => {})
  .finally(renderTeam);
route();
