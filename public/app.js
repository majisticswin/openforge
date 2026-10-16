import { activeConnections, el, fmtCost, fmtTokens, initModels, onChange, openModels, renderUsage, requestBody, teamSummary } from "/models.js";

const $ = (sel) => document.querySelector(sel);

// ---------- AI models ----------

function renderTeam() {
  const team = teamSummary();
  $("#models-dot").classList.toggle("on", activeConnections().length > 0);
  $("#team-line").textContent = team ? `Team: ${team}` : "Add an AI model to start";
  $("#create-btn").disabled = !team;
}

$("#settings-btn").addEventListener("click", () => openModels());
onChange(renderTeam);

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
    const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ prompt, ...requestBody() }) });
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
  renderSiteUsage();
}

// Usage shown for this site: what was saved before the current job, plus calls streamed live.
let liveUsage = null;

function renderSiteUsage() {
  const base = current?.usage ?? { inputTokens: 0, outputTokens: 0, cost: 0, unpricedCalls: 0, calls: 0 };
  const u = liveUsage
    ? {
        inputTokens: base.inputTokens + liveUsage.inputTokens,
        outputTokens: base.outputTokens + liveUsage.outputTokens,
        cost: base.cost + liveUsage.cost,
        unpricedCalls: base.unpricedCalls + liveUsage.unpricedCalls,
        calls: base.calls + liveUsage.calls,
      }
    : base;
  const line = $("#site-usage");
  line.hidden = u.calls === 0;
  line.replaceChildren(
    `This site so far: ${fmtTokens(u.inputTokens + u.outputTokens)} tokens (${fmtTokens(u.inputTokens)} in, ${fmtTokens(u.outputTokens)} out) · ${fmtCost(u.cost, u.unpricedCalls)} · `,
    el("a", { href: "#", onclick: (e) => (e.preventDefault(), openModels("usage-panel")) }, "Usage details"),
  );
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
    case "usage": {
      const c = event.call;
      if (liveUsage) {
        liveUsage.calls++;
        liveUsage.inputTokens += c.inputTokens;
        liveUsage.outputTokens += c.outputTokens;
        if (c.cost === undefined) liveUsage.unpricedCalls++;
        else liveUsage.cost += c.cost;
        renderSiteUsage();
      }
      progressItem?.append(
        el("div", { className: "tokens" }, `${c.connectionName} · ${c.model}: ${fmtTokens(c.inputTokens)} in, ${fmtTokens(c.outputTokens)} out${c.estimated ? " (estimated)" : ""} · ${fmtCost(c.cost)}`),
      );
      break;
    }
    case "warning":
      addItem(event.message, "warn");
      break;
    case "status":
      if (event.status === "working") {
        liveUsage = { inputTokens: 0, outputTokens: 0, cost: 0, unpricedCalls: 0, calls: 0 };
        setBusy(true);
      } else if (event.status === "ready") {
        setBusy(false);
        if (activeItem?.classList.contains("active")) activeItem.classList.replace("active", "ok");
        addItem("Your site is ready", "ok");
        showResult();
      } else if (event.status === "failed") {
        api(`/api/projects/${current.id}`).then((p) => {
          current = p;
          liveUsage = null;
          renderSiteUsage();
        });
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
  liveUsage = null;
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
    await api(`/api/projects/${current.id}/edit`, { method: "POST", body: JSON.stringify({ instruction, ...requestBody() }) });
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

initModels().finally(renderTeam);
route();
