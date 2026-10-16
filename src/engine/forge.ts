import { costOf, priceFor } from "../providers/pricing.js";
import type { Provider } from "../providers/types.js";
import type { UsageRecord } from "../usage.js";
import { applyChanges, formatFileBlocks, parseFileBlocks, writeProject, type FileMap } from "./files.js";
import {
  BUILDER_SYSTEM,
  EDITOR_SYSTEM,
  FIXER_SYSTEM,
  PLANNER_SYSTEM,
  REVIEWER_SYSTEM,
  builderPrompt,
  editorPrompt,
  fixerPrompt,
  plannerPrompt,
  reviewerPrompt,
} from "./prompts.js";
import { verifySite, type SitePlan, type VerifyResult } from "./verify.js";

export interface Roles {
  planner: Provider;
  builder: Provider;
  reviewers: Provider[];
  fixer: Provider;
}

export interface ReviewIssue {
  severity: "high" | "medium" | "low";
  file?: string;
  problem: string;
  fix?: string;
}

export interface Review {
  reviewer: string;
  score: number;
  summary: string;
  issues: ReviewIssue[];
}

export type ForgeEvent =
  | { type: "stage"; stage: string; message: string }
  | { type: "progress"; role: string; chars: number }
  | { type: "plan"; plan: SitePlan }
  | { type: "files"; files: string[]; round: number }
  | { type: "verify"; result: VerifyResult; round: number }
  | { type: "review"; review: Review; round: number }
  | { type: "usage"; call: UsageRecord }
  | { type: "warning"; message: string };

export interface ForgeOptions {
  roles: Roles;
  /** Folder the site is written to and tested in. */
  dir: string;
  /** How many review-and-fix rounds to run at most. */
  maxRounds?: number;
  onEvent?: (event: ForgeEvent) => void;
  signal?: AbortSignal;
}

export interface ForgeResult {
  plan: SitePlan;
  files: FileMap;
  verify: VerifyResult;
  reviews: Review[];
  rounds: number;
}

export interface RolePreferences {
  /** Connection id of the model that should write the code. */
  builder?: string;
  /** Connection id of the model that should plan the site. */
  planner?: string;
}

/**
 * By default Claude builds (strongest coder) and the other models plan and
 * review, for a second opinion. The user can pick the builder and planner.
 */
export function assignRoles(providers: Provider[], prefs: RolePreferences = {}): Roles {
  if (providers.length === 0) throw new Error("Add at least one AI model first (Claude, GPT, Gemini, a cloud LLM, or a local model).");
  const rank = (p: Provider) => {
    const order = ["anthropic", "openai", "gemini", "compatible", "mock"];
    return order.indexOf(p.kind) * 2 + (p.connection.local ? 1 : 0);
  };
  const sorted = [...providers].sort((a, b) => rank(a) - rank(b));
  const builder = sorted.find((p) => p.connection.id === prefs.builder) ?? sorted[0];
  const others = sorted.filter((p) => p !== builder);
  const planner = sorted.find((p) => p.connection.id === prefs.planner) ?? others[0] ?? builder;
  return {
    builder,
    fixer: builder,
    planner,
    // More than three reviewers adds cost without much new signal.
    reviewers: others.length > 0 ? others.slice(0, 3) : [builder],
  };
}

/** Pulls the first JSON object out of a model response, tolerating code fences or stray prose. */
export function extractJson<T>(text: string): T {
  const unfenced = text.replace(/```(?:json)?/g, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The response did not contain a JSON object.");
  return JSON.parse(unfenced.slice(start, end + 1)) as T;
}

async function ask(provider: Provider, role: string, system: string, prompt: string, opts: ForgeOptions): Promise<string> {
  let chars = 0;
  let lastReport = 0;
  const started = Date.now();
  const result = await provider.generate({
    system,
    prompt,
    signal: opts.signal,
    onText: (chunk) => {
      chars += chunk.length;
      if (chars - lastReport > 2000) {
        lastReport = chars;
        opts.onEvent?.({ type: "progress", role, chars });
      }
    },
  });
  const { connection } = provider;
  opts.onEvent?.({
    type: "usage",
    call: {
      at: new Date().toISOString(),
      role: role.split(":")[0],
      connectionId: connection.id,
      connectionName: connection.name,
      kind: connection.kind,
      preset: connection.preset,
      local: Boolean(connection.local),
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      estimated: Boolean(result.usage.estimated),
      cost: costOf(result.usage, priceFor(connection, result.model)),
      durationMs: Date.now() - started,
    },
  });
  return result.text;
}

async function makePlan(request: string, opts: ForgeOptions): Promise<SitePlan> {
  const { planner } = opts.roles;
  opts.onEvent?.({ type: "stage", stage: "plan", message: `${planner.label} is planning the site` });
  for (let attempt = 1; ; attempt++) {
    const text = await ask(planner, "planner", PLANNER_SYSTEM, plannerPrompt(request), opts);
    try {
      const plan = extractJson<SitePlan>(text);
      if (!Array.isArray(plan.pages) || plan.pages.length === 0) throw new Error("The plan has no pages.");
      return plan;
    } catch (err) {
      if (attempt >= 2) throw new Error(`The planner did not return a usable plan: ${(err as Error).message}`);
      opts.onEvent?.({ type: "warning", message: "The plan was malformed, asking again." });
    }
  }
}

async function review(request: string, planJson: string, files: FileMap, round: number, opts: ForgeOptions): Promise<Review[]> {
  const fileText = formatFileBlocks(files);
  const results = await Promise.allSettled(
    opts.roles.reviewers.map(async (reviewer): Promise<Review> => {
      const text = await ask(reviewer, `reviewer:${reviewer.connection.id}`, REVIEWER_SYSTEM, reviewerPrompt(request, planJson, fileText), opts);
      const parsed = extractJson<Omit<Review, "reviewer">>(text);
      return {
        reviewer: reviewer.label,
        score: Number(parsed.score) || 0,
        summary: parsed.summary ?? "",
        issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 12) : [],
      };
    }),
  );
  const reviews: Review[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      reviews.push(result.value);
      opts.onEvent?.({ type: "review", review: result.value, round });
    } else {
      // One reviewer failing (rate limit, bad key) should not sink the whole build.
      opts.onEvent?.({ type: "warning", message: `${opts.roles.reviewers[i].label} could not review: ${result.reason?.message ?? result.reason}` });
    }
  });
  return reviews;
}

function describeProblems(verify: VerifyResult, reviews: Review[]): string[] {
  const problems = [...verify.problems];
  for (const r of reviews) {
    for (const issue of r.issues) {
      if (issue.severity === "low") continue;
      problems.push(`[${r.reviewer}, ${issue.severity}] ${issue.file ? `${issue.file}: ` : ""}${issue.problem}${issue.fix ? ` Fix: ${issue.fix}` : ""}`);
    }
  }
  return problems;
}

/** Tests the current files and lets the fixer repair them, up to maxRounds times. */
async function improve(request: string, plan: SitePlan, startFiles: FileMap, opts: ForgeOptions, withReview: boolean): Promise<ForgeResult> {
  const planJson = JSON.stringify(plan, null, 2);
  const maxRounds = opts.maxRounds ?? 2;
  let files = startFiles;
  let allReviews: Review[] = [];

  for (let round = 1; ; round++) {
    await writeProject(opts.dir, files);
    opts.onEvent?.({ type: "stage", stage: "test", message: `Running the site and testing every page (round ${round})` });
    const verify = await verifySite(files, plan, opts.dir);
    opts.onEvent?.({ type: "verify", result: verify, round });

    let reviews: Review[] = [];
    if (withReview && round <= maxRounds) {
      opts.onEvent?.({ type: "stage", stage: "review", message: `${opts.roles.reviewers.map((r) => r.label).join(" and ")} reviewing the code and design` });
      reviews = await review(request, planJson, files, round, opts);
      allReviews = allReviews.concat(reviews);
    }

    const problems = describeProblems(verify, reviews);
    const blocking = verify.ok ? reviews.some((r) => r.issues.some((i) => i.severity === "high")) : true;
    if (problems.length === 0 || (!blocking && round > 1) || round > maxRounds) {
      return { plan, files, verify, reviews: allReviews, rounds: round };
    }

    opts.onEvent?.({ type: "stage", stage: "fix", message: `${opts.roles.fixer.label} fixing ${problems.length} problem${problems.length === 1 ? "" : "s"}` });
    const text = await ask(opts.roles.fixer, "fixer", FIXER_SYSTEM, fixerPrompt(request, planJson, formatFileBlocks(files), problems.join("\n")), opts);
    const changes = parseFileBlocks(text);
    if (changes.files.size === 0 && changes.deleted.length === 0) {
      opts.onEvent?.({ type: "warning", message: "The fixer returned no changes." });
      return { plan, files, verify, reviews: allReviews, rounds: round };
    }
    files = applyChanges(files, changes);
    opts.onEvent?.({ type: "files", files: [...changes.files.keys()], round });
  }
}

/** Builds a complete website from a description: plan, build, then test, review, and fix. */
export async function forgeSite(request: string, opts: ForgeOptions): Promise<ForgeResult> {
  const plan = await makePlan(request, opts);
  opts.onEvent?.({ type: "plan", plan });

  const { builder } = opts.roles;
  opts.onEvent?.({ type: "stage", stage: "build", message: `${builder.label} is writing the code` });
  const text = await ask(builder, "builder", BUILDER_SYSTEM, builderPrompt(request, JSON.stringify(plan, null, 2)), opts);
  const { files } = parseFileBlocks(text);
  if (files.size === 0) throw new Error("The builder did not return any files.");
  opts.onEvent?.({ type: "files", files: [...files.keys()], round: 0 });

  return improve(request, plan, files, opts, true);
}

/** Applies a plain-language change ("make the header dark") to an existing site, then tests and repairs it. */
export async function editSite(instruction: string, plan: SitePlan, files: FileMap, opts: ForgeOptions): Promise<ForgeResult> {
  const { builder } = opts.roles;
  opts.onEvent?.({ type: "stage", stage: "edit", message: `${builder.label} is making your change` });
  const text = await ask(builder, "editor", EDITOR_SYSTEM, editorPrompt(JSON.stringify(plan, null, 2), formatFileBlocks(files), instruction), opts);
  const changes = parseFileBlocks(text);
  if (changes.files.size === 0 && changes.deleted.length === 0) throw new Error("The AI did not change any files.");
  const next = applyChanges(files, changes);
  opts.onEvent?.({ type: "files", files: [...changes.files.keys()], round: 0 });
  return improve(instruction, plan, next, { ...opts, maxRounds: Math.min(opts.maxRounds ?? 2, 1) }, false);
}
