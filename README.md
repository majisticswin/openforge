# OpenForge

**Describe a website. Get a real one.**

OpenForge is a free, open source AI website builder. Instead of relying on one model, it puts Claude, GPT and Gemini on the same team: one plans the site, one writes the code, and the others review it. Every site is run and tested automatically, and problems are fixed before you see the result.

What you get is a complete full stack website (pages, a backend API, and stored data) that you can download and put on your own hosting.

## Why

Paying a developer thousands for a small business site is out of reach for most people, and today's AI builders lock your site into their platform. OpenForge is free, runs on your own computer or server, works with whichever AI you already have (including free local models), and the site it builds is yours.

## How it works

```
 your description
        │
        ▼
   ┌─────────┐   pages, features, data, API, design system
   │ Planner │   (GPT or Gemini when available)
   └────┬────┘
        ▼
   ┌─────────┐   every file: Express server, JSON data store,
   │ Builder │   HTML/CSS/JS pages, README  (Claude when available)
   └────┬────┘
        ▼
   ┌───────────────────────────────────────────┐
   │ Test: install, start the server, load     │
   │ every page, check links and the 404 page  │◄──┐
   ├───────────────────────────────────────────┤   │
   │ Review: the other models check bugs,      │   │ up to 2 rounds
   │ design, accessibility, SEO and security   │   │
   ├───────────────────────────────────────────┤   │
   │ Fix: the builder repairs what was found   │───┘
   └───────────────────────────────────────────┘
        ▼
  live preview, edit by chatting, download as .zip
```

With only one model, it plays every role. More models means more independent review.

## Quick start

You need [Node.js 22 or newer](https://nodejs.org).

```bash
git clone https://github.com/majisticswin/openforge.git
cd openforge
npm install
npm start
```

Open http://localhost:4321, click **AI models**, and pick from the **Add an AI** dropdown. Add as many as you like, then choose which model each one uses and which one writes the code.

| Kind | Options |
| --- | --- |
| Major providers | Claude, ChatGPT models (OpenAI), Gemini (free tier) |
| Cloud LLMs | OpenRouter, Groq, Together, DeepSeek, Mistral, Fireworks, xAI, or your own hosted model at any OpenAI-compatible URL |
| Local, free | Ollama, LM Studio, llama.cpp, LocalAI, vLLM, Jan, text-generation-webui, KoboldCpp, GPT4All |

OpenForge scans this computer for local AI servers that are already running and lists them at the top of the dropdown. To scan other machines too (for example when OpenForge runs in Docker), set `OPENFORGE_SCAN_HOSTS=host.docker.internal,192.168.1.20`.

If a model runs out of credit, has its key rejected or stops responding mid-build, OpenForge hands its job to the next model you added and keeps going. The model card says what happened, and new builds skip that model until you top up and press Refresh.

A floating usage panel in the corner pops up when you open OpenForge and when a build starts, and counts tokens and cost live. The **Usage** tab shows the tokens and cost of every AI call, by day, model and site. Counts come from what each provider reports for each call. Claude prices are built in, OpenRouter publishes its own, and for other paid models you can enter the price. OpenRouter and DeepSeek also show your remaining account balance; the other providers only expose that in their own dashboards, so OpenForge links there.

No key yet? Run `npm run demo` to see the whole flow with a built-in demo model.

You can also put keys in a `.env` file instead (copy `.env.example`).

### Command line

```bash
npm run forge -- "A website for my bakery with an online cake order form" --out bakery-site
cd bakery-site && npm install && npm start
```

## What the generated sites look like inside

Every site follows the same simple, portable stack so it runs almost anywhere:

- **Backend:** Node.js and Express (`server.js`), JSON API under `/api`
- **Data:** a small JSON file store (`db.js`) in `./data`, no database to set up
- **Frontend:** plain HTML, modern CSS and JavaScript in `./public`, no build step
- **Admin pages** for sites that collect data, protected by `ADMIN_PASSWORD`
- **Deploy:** any Node host, a VPS with PM2, or cPanel's "Setup Node.js App"

## Project layout

```
src/
  providers/   Claude, GPT, Gemini, local (OpenAI-compatible) and demo adapters
  engine/      prompts, file format, the plan → build → test → review → fix loop, the test runner
  projects.ts  stores generated sites under ./workspaces and runs previews
  server.ts    web app API
  cli.ts       command line
public/        the web app
test/          tests (run with npm test, no keys needed)
```

## Safety notes

- OpenForge runs the code the AI writes on your machine so it can test it. Package install scripts are disabled, but treat generated code like any code from the internet.
- Keys typed into the web app are stored in your browser and sent only to your own OpenForge server. Don't expose the server to the internet without adding authentication.

## Roadmap

1. **Engine prototype** (this release): multi-model plan, build, test, review, fix; preview; edits; download.
2. **Quality loop:** headless browser screenshots, visual and console-error checks, accessibility audits, ready-made design systems for common site types.
3. **Deploy:** one-click upload to your hosting (cPanel, FTP, VPS, Git-based hosts) and custom domains.
4. **Community launch:** docs, templates, benchmarks against other builders, hosted demo.

## Contributing

Issues and pull requests are welcome. Run `npm test` and `npm run typecheck` before opening a PR.

## License

MIT
