import type { GenerateRequest, Provider } from "./types.js";

/**
 * A fake provider that returns a small, real website. It lets you try the whole
 * pipeline (and run the tests) without any API key. Its first build has a
 * deliberately broken link so the test-and-fix loop has something to repair.
 */
export function createMockProvider(): Provider {
  return {
    id: "mock",
    label: "Demo model",
    model: "mock",
    async generate({ system, prompt, onText }: GenerateRequest) {
      let text: string;
      if (system.includes("lead architect")) text = JSON.stringify(PLAN);
      else if (system.includes("demanding reviewer")) text = JSON.stringify(REVIEW);
      else if (system.includes("fixing a generated website")) text = FIX;
      else if (system.includes("wants a change")) text = editFor(prompt);
      else text = BUILD;
      onText?.(text);
      return text;
    },
  };
}

const PLAN = {
  name: "Bloom Bakery",
  tagline: "Small-batch bread, baked before sunrise",
  audience: "Neighbours who want fresh bread and cakes",
  pages: [
    { path: "/", title: "Home", purpose: "Welcome visitors", sections: ["Hero", "Today's bakes"] },
    { path: "/contact", title: "Contact", purpose: "Take cake orders", sections: ["Order form"] },
  ],
  features: ["Order form that stores requests"],
  dataModels: [{ name: "Order", fields: ["id", "name", "email", "details", "createdAt"] }],
  apiRoutes: [{ method: "POST", path: "/api/orders", purpose: "Save an order" }],
  design: {
    mood: "warm, crafted",
    palette: { background: "#fbf7f1", surface: "#ffffff", text: "#2b2118", muted: "#7a6a5c", primary: "#b4532a", accent: "#e9b872" },
    fonts: { heading: "Fraunces", body: "Inter" },
    notes: "Soft paper background with a large serif headline.",
  },
};

const REVIEW = {
  score: 7,
  summary: "Works, but the home page links to a menu page that does not exist.",
  issues: [{ severity: "medium", file: "public/index.html", problem: "Links to /menu.html, which is missing.", fix: "Add public/menu.html." }],
};

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | Bloom Bakery</title>
  <meta name="description" content="Small-batch bread, baked before sunrise.">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header><a class="logo" href="/">Bloom Bakery</a><nav><a href="/">Home</a> <a href="/menu.html">Menu</a> <a href="/contact">Contact</a></nav></header>
  <main>${body}</main>
</body>
</html>`;

const BUILD = `<<<FILE path="package.json">>>
{
  "name": "bloom-bakery",
  "type": "module",
  "scripts": { "start": "node server.js" },
  "engines": { "node": ">=20" },
  "dependencies": { "express": "^5.1.0" }
}
<<<END FILE>>>

<<<FILE path="db.js">>>
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

mkdirSync("data", { recursive: true });

export function readAll(name) {
  try {
    return JSON.parse(readFileSync(\`data/\${name}.json\`, "utf8"));
  } catch {
    return [];
  }
}

export function append(name, item) {
  const items = readAll(name);
  items.push(item);
  writeFileSync(\`data/\${name}.json.tmp\`, JSON.stringify(items, null, 2));
  renameSync(\`data/\${name}.json.tmp\`, \`data/\${name}.json\`);
  return item;
}
<<<END FILE>>>

<<<FILE path="server.js">>>
import express from "express";
import { append } from "./db.js";

const app = express();
app.use(express.json());
app.use(express.static("public", { extensions: ["html"] }));

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/orders", (req, res) => {
  const { name, email, details } = req.body ?? {};
  if (!name || !email || !details) return res.status(400).json({ error: "Name, email and details are required." });
  const order = append("orders", { id: Date.now().toString(36), name: String(name).slice(0, 100), email: String(email).slice(0, 200), details: String(details).slice(0, 2000), createdAt: new Date().toISOString() });
  res.status(201).json(order);
});

app.use((req, res) => res.status(404).sendFile("404.html", { root: "public" }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(\`Bloom Bakery running on http://localhost:\${port}\`));
<<<END FILE>>>

<<<FILE path="public/styles.css">>>
:root { --bg: #fbf7f1; --text: #2b2118; --primary: #b4532a; }
body { margin: 0; font-family: Inter, system-ui, sans-serif; background: var(--bg); color: var(--text); }
header { display: flex; justify-content: space-between; padding: 1rem clamp(1rem, 4vw, 3rem); }
main { padding: clamp(1rem, 4vw, 3rem); max-width: 60rem; margin: auto; }
h1 { font-family: Fraunces, Georgia, serif; font-size: clamp(2.5rem, 6vw, 4.5rem); }
a { color: var(--primary); }
<<<END FILE>>>

<<<FILE path="public/index.html">>>
${page("Home", "<h1>Bread worth waking up for.</h1><p>Sourdough, rye and seasonal cakes, baked every morning.</p>")}
<<<END FILE>>>

<<<FILE path="public/contact.html">>>
${page("Contact", `<h1>Order a cake</h1>
<form id="order"><label>Name <input name="name" required></label><label>Email <input name="email" type="email" required></label><label>Details <textarea name="details" required></textarea></label><button>Send order</button></form>
<p id="status" role="status"></p>
<script type="module">
document.getElementById("order").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
  document.getElementById("status").textContent = res.ok ? "Thanks! We'll be in touch." : "Something went wrong.";
});
</script>`)}
<<<END FILE>>>

<<<FILE path="public/404.html">>>
${page("Not found", "<h1>This page is still in the oven.</h1><p><a href=\"/\">Back home</a></p>")}
<<<END FILE>>>

<<<FILE path="README.md">>>
# Bloom Bakery

Run with \`npm install && npm start\`, then open http://localhost:3000.
<<<END FILE>>>`;

const FIX = `<<<FILE path="public/menu.html">>>
${page("Menu", "<h1>Today's bakes</h1><ul><li>Country sourdough</li><li>Dark rye</li><li>Cardamom buns</li></ul>")}
<<<END FILE>>>`;

function editFor(prompt: string): string {
  const instruction = prompt.split("Requested change:\n")[1]?.trim() ?? "";
  return `<<<FILE path="public/styles.css">>>
/* Edited: ${instruction.replace(/\*\//g, "")} */
:root { --bg: #1f1a17; --text: #f6efe7; --primary: #e9b872; }
body { margin: 0; font-family: Inter, system-ui, sans-serif; background: var(--bg); color: var(--text); }
header { display: flex; justify-content: space-between; padding: 1rem clamp(1rem, 4vw, 3rem); }
main { padding: clamp(1rem, 4vw, 3rem); max-width: 60rem; margin: auto; }
h1 { font-family: Fraunces, Georgia, serif; font-size: clamp(2.5rem, 6vw, 4.5rem); }
a { color: var(--primary); }
<<<END FILE>>>`;
}
