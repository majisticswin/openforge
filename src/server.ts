import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assignRoles, type RolePreferences } from "./engine/forge.js";
import { readProject } from "./engine/files.js";
import { PRESETS } from "./providers/catalog.js";
import { accountInfo, listModels, scanLocalServers } from "./providers/discovery.js";
import { connectionsFromEnv, createProvider, sanitizeConnection, type Connection } from "./providers/index.js";
import { MOCK_CONNECTION } from "./providers/mock.js";
import { ProjectStore } from "./projects.js";
import { UsageStore } from "./usage.js";
import { createZip } from "./zip.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workspaces = process.env.OPENFORGE_WORKSPACES ?? path.join(root, "workspaces");
const usage = new UsageStore(workspaces);
// Models that failed recently (no credit, bad key), so new jobs start with one that works.
const failing = new Map<string, { until: number }>();
const store = new ProjectStore(workspaces, usage, (e) => {
  if (e.type === "switch") failing.set(e.connectionId, { until: Date.now() + (e.problem === "rate" || e.problem === "down" ? 2 : 30) * 60_000 });
  if (e.type === "usage") failing.delete(e.call.connectionId);
});
const envConnections = connectionsFromEnv();
if (process.argv.includes("--demo") && !envConnections.some((c) => c.kind === "mock")) envConnections.push(MOCK_CONNECTION);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(root, "public")));

/** Connections configured on the server (.env) are referred to by id, so their keys never reach the browser. */
function resolveConnection(raw: unknown): Connection | null {
  const id = (raw as { id?: unknown } | null)?.id;
  const server = envConnections.find((c) => c.id === id);
  if (server) {
    const overrides = raw as Partial<Connection>;
    return { ...server, model: overrides.model || server.model, price: sanitizeConnection({ ...server, ...overrides })?.price, enabled: overrides.enabled !== false };
  }
  return sanitizeConnection(raw);
}

/**
 * Keys typed into the browser are sent with each request and only kept in
 * memory for that job. Keys in the server's environment are used otherwise.
 */
function rolesFor(body: { connections?: unknown[]; roles?: RolePreferences }) {
  const sent = Array.isArray(body.connections) ? body.connections.map(resolveConnection).filter((c): c is Connection => c !== null) : [];
  const connections = sent.length > 0 ? sent : envConnections;
  const providers = connections.filter((c) => c.enabled !== false).map(createProvider);
  const sentAvoid = Array.isArray(body.roles?.avoid) ? body.roles.avoid.filter((id): id is string => typeof id === "string") : [];
  const avoid = [...sentAvoid, ...[...failing].filter(([, f]) => f.until > Date.now()).map(([id]) => id)];
  return assignRoles(providers, { builder: body.roles?.builder, planner: body.roles?.planner, avoid });
}

app.get("/api/config", (_req, res) => {
  res.json({
    presets: PRESETS,
    // Server-side connections without their keys.
    serverConnections: envConnections.map(({ apiKey: _key, ...rest }) => ({ ...rest, fromServer: true })),
  });
});

app.post("/api/models", async (req, res) => {
  const connection = resolveConnection(req.body?.connection);
  if (!connection) return res.status(400).json({ error: "Fill in the API key (and address, for custom servers) first." });
  try {
    const models = await listModels(connection);
    // The key works again (topped up or fixed), so new jobs may use it right away.
    failing.delete(connection.id);
    res.json({ models });
  } catch (err) {
    res.status(400).json({ error: friendlyError(err) });
  }
});

app.get("/api/local/scan", async (_req, res) => {
  res.json({ servers: await scanLocalServers() });
});

app.post("/api/account", async (req, res) => {
  const connection = resolveConnection(req.body?.connection);
  if (!connection) return res.status(400).json({ error: "Unknown connection." });
  try {
    res.json(await accountInfo(connection));
  } catch (err) {
    res.status(400).json({ error: friendlyError(err) });
  }
});

app.get("/api/usage", async (_req, res) => {
  res.json(await usage.summary());
});

function friendlyError(err: unknown): string {
  const e = err as { status?: number; message?: string; cause?: { code?: string } };
  if (e.status === 401 || e.status === 403) return "That API key was rejected. Check it and try again.";
  if (e.cause?.code === "ECONNREFUSED") return "Nothing is answering at that address. Is the server running?";
  if (e.message?.includes("timeout") || e.message?.includes("aborted")) return "The server took too long to answer.";
  return e.message ?? String(err);
}

app.get("/api/projects", async (_req, res) => {
  res.json(await store.list());
});

app.post("/api/projects", async (req, res) => {
  const request = String(req.body?.prompt ?? "").trim();
  if (request.length < 10) return res.status(400).json({ error: "Describe the website in a sentence or more." });
  if (request.length > 8000) return res.status(400).json({ error: "Please keep the description under 8,000 characters." });
  try {
    const meta = await store.create(request, rolesFor(req.body), Number(req.body?.rounds) || undefined);
    res.status(201).json(meta);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get("/api/projects/:id", async (req, res) => {
  const meta = await store.get(req.params.id);
  if (!meta) return res.status(404).json({ error: "Project not found." });
  const files = meta.status === "working" ? [] : [...(await readProject(store.siteDir(meta.id)).catch(() => new Map())).keys()];
  res.json({ ...meta, files });
});

app.get("/api/projects/:id/events", async (req, res) => {
  const meta = await store.get(req.params.id);
  if (!meta) return res.status(404).end();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const event of store.history(meta.id)) send(event);
  if (meta.status !== "working") send({ type: "status", status: meta.status, error: meta.error });
  // Everything before this marker is a replay of what already happened.
  send({ type: "live" });
  const unsubscribe = store.subscribe(meta.id, send);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

app.get("/api/projects/:id/file", async (req, res) => {
  const meta = await store.get(req.params.id);
  if (!meta) return res.status(404).json({ error: "Project not found." });
  const files = await readProject(store.siteDir(meta.id));
  const content = files.get(String(req.query.path ?? ""));
  if (content === undefined) return res.status(404).json({ error: "File not found." });
  res.type("text/plain").send(content);
});

app.post("/api/projects/:id/edit", async (req, res) => {
  const instruction = String(req.body?.instruction ?? "").trim();
  if (!instruction) return res.status(400).json({ error: "Say what you would like changed." });
  try {
    res.json(await store.edit(req.params.id, instruction, rolesFor(req.body)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/api/projects/:id/preview", async (req, res) => {
  const meta = await store.get(req.params.id);
  if (!meta || meta.status !== "ready") return res.status(400).json({ error: "The site is not ready yet." });
  try {
    res.json({ url: await store.preview(meta.id) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/projects/:id/download", async (req, res) => {
  const meta = await store.get(req.params.id);
  if (!meta) return res.status(404).json({ error: "Project not found." });
  const files = await readProject(store.siteDir(meta.id));
  const slug = (meta.plan?.name ?? "website").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "website";
  const zip = createZip([...files].map(([p, content]) => ({ path: `${slug}/${p}`, content })));
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${slug}.zip"`);
  res.send(zip);
});

const port = Number(process.env.PORT) || 4321;
const server = app.listen(port, () => console.log(`OpenForge is running at http://localhost:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await store.stopAll();
    server.close();
    process.exit(0);
  });
}
