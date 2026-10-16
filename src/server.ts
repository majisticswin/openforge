import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assignRoles } from "./engine/forge.js";
import { readProject } from "./engine/files.js";
import { configFromEnv, createProviders, type ProviderConfig } from "./providers/index.js";
import { ProjectStore } from "./projects.js";
import { createZip } from "./zip.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const store = new ProjectStore(process.env.OPENFORGE_WORKSPACES ?? path.join(root, "workspaces"));
const envConfig = configFromEnv();
if (process.argv.includes("--demo")) envConfig.mock = true;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(root, "public")));

/**
 * Keys typed into the browser are sent with each request and only kept in
 * memory for that job. Keys in the server's environment are used otherwise.
 */
function rolesFor(body: { keys?: ProviderConfig }) {
  const keys = body.keys ?? {};
  const config: ProviderConfig = {
    anthropic: keys.anthropic?.apiKey ? keys.anthropic : envConfig.anthropic,
    openai: keys.openai?.apiKey ? keys.openai : envConfig.openai,
    gemini: keys.gemini?.apiKey ? keys.gemini : envConfig.gemini,
    local: keys.local?.baseURL && keys.local.model ? keys.local : envConfig.local,
    mock: keys.mock ?? envConfig.mock,
  };
  return assignRoles(createProviders(config));
}

app.get("/api/config", (_req, res) => {
  res.json({
    serverKeys: {
      anthropic: Boolean(envConfig.anthropic),
      openai: Boolean(envConfig.openai),
      gemini: Boolean(envConfig.gemini),
      local: Boolean(envConfig.local),
      mock: Boolean(envConfig.mock),
    },
  });
});

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
