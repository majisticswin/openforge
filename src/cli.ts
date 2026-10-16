import path from "node:path";
import { parseArgs } from "node:util";
import { assignRoles, forgeSite } from "./engine/forge.js";
import { connectionsFromEnv, createProvider } from "./providers/index.js";
import { MOCK_CONNECTION } from "./providers/mock.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o", default: "my-site" },
    rounds: { type: "string", default: "2" },
    demo: { type: "boolean", default: false },
  },
});

const request = positionals.join(" ").trim();
if (!request) {
  console.log(`Usage: npm run forge -- "A website for my bakery with an online cake order form" [--out my-site] [--rounds 2] [--demo]

Set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or LOCAL_BASE_URL (any OpenAI-compatible server).
Use --demo to try the pipeline without any key.`);
  process.exit(1);
}

const connections = connectionsFromEnv();
if (values.demo && !connections.some((c) => c.kind === "mock")) connections.push(MOCK_CONNECTION);
const roles = assignRoles(connections.map(createProvider));
const dir = path.resolve(values.out!);

console.log(`Planner: ${roles.planner.label}\nBuilder: ${roles.builder.label}\nReviewers: ${roles.reviewers.map((r) => r.label).join(", ")}\n`);

let midLine = false;
const result = await forgeSite(request, {
  roles,
  dir,
  maxRounds: Number(values.rounds),
  onEvent: (event) => {
    if (event.type !== "progress" && midLine) {
      process.stdout.write("\n");
      midLine = false;
    }
    switch (event.type) {
      case "stage":
        console.log(`> ${event.message}`);
        break;
      case "progress":
        process.stdout.write(`  ${event.role}: ${Math.round(event.chars / 1000)}k characters written\r`);
        midLine = true;
        break;
      case "files":
        console.log(`  wrote ${event.files.length} file(s): ${event.files.join(", ")}`);
        break;
      case "review":
        console.log(`  ${event.review.reviewer}: ${event.review.score}/10, ${event.review.summary}`);
        break;
      case "verify": {
        const passed = event.result.checks.filter((c) => c.ok).length;
        console.log(`  automated tests: ${passed}/${event.result.checks.length} passed`);
        for (const p of event.result.problems) console.log(`    ${p.split("\n")[0]}`);
        break;
      }
      case "usage": {
        const c = event.call;
        const cost = c.cost === undefined ? "" : `, $${c.cost.toFixed(4)}`;
        console.log(`  ${c.role} used ${c.inputTokens.toLocaleString()} in / ${c.outputTokens.toLocaleString()} out tokens on ${c.model}${c.estimated ? " (estimated)" : ""}${cost}`);
        break;
      }
      case "warning":
        console.log(`  warning: ${event.message}`);
        break;
    }
  },
});

console.log(`\n${result.verify.ok ? "Done" : "Finished with failing checks"}: ${result.plan.name ?? "your site"} is in ${dir}`);
console.log(`Run it with: cd "${dir}" && npm install && npm start`);
process.exit(result.verify.ok ? 0 : 2);
