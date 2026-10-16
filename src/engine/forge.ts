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
  /** Every model the user added, best first. When one fails (no credit, bad key), the next takes over. */
  pool?: Provider[];
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
  | { type: "switch"; at: string; role: string; connectionId: string; from: string; to?: string; problem: ModelProblem; message: string; detail: string }
  | { type: "warning"; message: string };

export interface ForgeOptions {
  roles: Roles;
  /** Folder the site is written to and tested in. */
  dir: string;
  /** How many review-and-fix rounds to run at most. */
  maxRounds?: number;
  onEvent?: (event: ForgeEvent) => void;
  signal?: AbortSignal;
  /** Connection ids that failed during this job. Filled in as the job runs. */
  failed?: Set<string>;
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
  /** Connection ids that failed recently (no credit, bad key). They are only used when nothing else is left. */
  avoid?: string[];
}

/**
 * By default Claude builds (strongest coder) and the other models plan and
 * review, for a second opinion. The user can pick the builder and planner.
 */
export function assignRoles(providers: Provider[], prefs: RolePreferences = {}): Roles {
  if (providers.length === 0) throw new Error("Add at least one AI model first (Claude, GPT, Gemini, a cloud LLM, or a local model).");
  const rank = (p: Provider) => {
    const order = ["anthropic", "openai", "gemini", "compatible", "mock"];
    const avoided = prefs.avoid?.includes(p.connection.id) ? 100 : 0;
    return avoided + order.indexOf(p.kind) * 2 + (p.connection.local ? 1 : 0);
  };
  const sorted = [...providers].sort((a, b) => rank(a) - rank(b));
  const usable = (p: Provider | undefined) => (p && !prefs.avoid?.includes(p.connection.id) ? p : undefined);
  const builder = usable(sorted.find((p) => p.connection.id === prefs.builder)) ?? sorted[0];
  const others = sorted.filter((p) => p !== builder);
  const healthy = others.filter((p) => usable(p));
  const planner = usable(sorted.find((p) => p.connection.id === prefs.planner)) ?? healthy[0] ?? builder;
  return {
    builder,
    fixer: builder,
    planner,
    // More than three reviewers adds cost without much new signal.
    reviewers: healthy.length > 0 ? healthy.slice(0, 3) : [builder],
    pool: [builder, ...others],
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

export type ModelProblem = "credit" | "key" | "model" | "rate" | "down";

/** Sorts a provider error into a reason a person understands. */
export function classifyError(err: unknown): ModelProblem {
  const e = err as { status?: number; code?: number | string; message?: string };
  const status = Number(e?.status ?? e?.code) || 0;
  const text = String(e?.message ?? err).toLowerCase();
  if (status === 402 || /credit|balance|billing|payment|insufficient_quota|exceeded your current quota|quota exceeded|resource_exhausted|plan and billing/.test(text)) return "credit";
  if (status === 401 || status === 403 || /api key|api_key|unauthori[sz]ed|permission|authentication/.test(text)) return "key";
  if (status === 404 || /model.*(not found|does not exist|not supported)|no such model|unknown model/.test(text)) return "model";
  if (status === 429 || /rate limit|too many requests/.test(text)) return "rate";
  return "down";
}

const PROBLEM_TEXT: Record<ModelProblem, string> = {
  credit: "ran out of credit",
  key: "rejected the API key",
  model: "doesn't offer that model",
  rate: "hit its rate limit",
  down: "stopped responding",
};

/** The provider's own explanation, without the JSON wrapping some SDKs put around it. */
export function shortError(err: unknown): string {
  const text = String((err as Error)?.message ?? err);
  const inner = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return (inner ? inner[1].replace(/\\"/g, '"') : text).slice(0, 300);
}

function isAbort(err: unknown, opts: ForgeOptions) {
  return opts.signal?.aborted || (err as Error)?.name === "AbortError";
}

/**
 * Hands a failed model's job to the next working model in the pool, so a build
 * keeps going when one account runs out of credit. Returns the replacement.
 */
function replace(failed: Provider, role: string, err: unknown, opts: ForgeOptions): Provider | undefined {
  const roles = opts.roles;
  const dead = (opts.failed ??= new Set());
  dead.add(failed.connection.id);
  const problem = classifyError(err);
  // The demo model writes a canned site, so it never stands in for a real model.
  const pool = (roles.pool ?? [roles.builder, roles.planner, ...roles.reviewers]).filter((p) => p.kind !== "mock" || failed.kind === "mock");
  const alive = (p: Provider) => !dead.has(p.connection.id);
  const next = pool.find(alive);
  const isReviewer = role.startsWith("reviewer");

  let to: Provider | undefined;
  if (isReviewer) {
    // Bring in a model that isn't reviewing yet, so the review still gets a second opinion.
    to = pool.find((p) => alive(p) && !roles.reviewers.includes(p) && p !== roles.builder);
    roles.reviewers = roles.reviewers.flatMap((r) => (r === failed ? (to ? [to] : []) : [r]));
  } else {
    to = next;
    roles.reviewers = roles.reviewers.filter((r) => r !== failed);
  }
  if (next) {
    if (roles.builder === failed) roles.builder = next;
    if (roles.fixer === failed) roles.fixer = next;
    if (roles.planner === failed) roles.planner = next;
    // A model shouldn't review its own code when someone else can.
    const others = roles.reviewers.filter((r) => r !== roles.builder);
    roles.reviewers = others.length > 0 ? others : [roles.builder];
  }

  const reason = `${failed.label} ${PROBLEM_TEXT[problem]}`;
  const message = to ? `${reason}. Switched to ${to.label}.` : isReviewer ? `${reason}, so it was left out of the review.` : `${reason}, and no other model is left to take over.`;
  opts.onEvent?.({ type: "switch", at: new Date().toISOString(), role: role.split(":")[0], connectionId: failed.connection.id, from: failed.label, to: to?.label, problem, message, detail: shortError(err) });
  return to;
}

/** Asks a model, and if its account fails, asks the next one. Throws only when every model has failed. */
async function ask(provider: Provider, role: string, system: string, prompt: string, opts: ForgeOptions): Promise<string> {
  return (await askWith(provider, role, system, prompt, opts)).text;
}

/** Like ask, and also says which model ended up answering. */
async function askWith(provider: Provider, role: string, system: string, prompt: string, opts: ForgeOptions): Promise<{ text: string; by: Provider }> {
  const errors: string[] = [];
  let current: Provider | undefined = provider;
  while (current) {
    try {
      return { text: await askOnce(current, role, system, prompt, opts), by: current };
    } catch (err) {
      if (isAbort(err, opts)) throw err;
      errors.push(`${current.label} ${PROBLEM_TEXT[classifyError(err)]}: ${shortError(err)}`);
      current = replace(current, role, err, opts);
    }
  }
  const error = new Error(errors.length > 1 ? `Every AI model failed.\n${errors.join("\n")}` : errors[0]);
  // The switch event already told the user; callers that tolerate a missing reviewer stay quiet.
  (error as Error & { reported?: boolean }).reported = true;
  throw error;
}

async function askOnce(provider: Provider, role: string, system: string, prompt: string, opts: ForgeOptions): Promise<string> {
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
  const reviewers = [...opts.roles.reviewers];
  const results = await Promise.allSettled(
    reviewers.map(async (reviewer): Promise<Review> => {
      const { text, by } = await askWith(reviewer, `reviewer:${reviewer.connection.id}`, REVIEWER_SYSTEM, reviewerPrompt(request, planJson, fileText), opts);
      const parsed = extractJson<Omit<Review, "reviewer">>(text);
      return {
        reviewer: by.label,
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
    } else if (!result.reason?.reported) {
      // A reviewer whose answer can't be read should not sink the whole build.
      opts.onEvent?.({ type: "warning", message: `${reviewers[i].label} could not review: ${result.reason?.message ?? result.reason}` });
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
