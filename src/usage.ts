import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/** One AI call, as recorded after it finishes. */
export interface UsageRecord {
  at: string;
  /** planner, builder, reviewer, fixer or editor */
  role: string;
  connectionId: string;
  connectionName: string;
  kind: string;
  preset?: string;
  local: boolean;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the provider didn't report token counts and they were estimated from text length. */
  estimated: boolean;
  /** US dollars, when the price is known. */
  cost?: number;
  durationMs: number;
  projectId?: string;
  projectName?: string;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of the costs OpenForge could price. */
  cost: number;
  /** Calls whose cost is unknown (no price for that model). */
  unpricedCalls: number;
  estimatedCalls: number;
}

export interface UsageSummary {
  allTime: UsageTotals;
  today: UsageTotals;
  last30Days: UsageTotals;
  byModel: (UsageTotals & { connectionName: string; model: string; local: boolean })[];
  byProject: (UsageTotals & { projectId: string; projectName: string })[];
  byRole: (UsageTotals & { role: string })[];
  byDay: (UsageTotals & { day: string })[];
  recent: UsageRecord[];
}

function emptyTotals(): UsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, unpricedCalls: 0, estimatedCalls: 0 };
}

function add(totals: UsageTotals, r: UsageRecord) {
  totals.calls++;
  totals.inputTokens += r.inputTokens;
  totals.outputTokens += r.outputTokens;
  if (r.cost === undefined) totals.unpricedCalls++;
  else totals.cost += r.cost;
  if (r.estimated) totals.estimatedCalls++;
}

function group<K extends string, X>(records: UsageRecord[], key: (r: UsageRecord) => string, extra: (r: UsageRecord) => X): (UsageTotals & X)[] {
  const map = new Map<string, UsageTotals & X>();
  for (const r of records) {
    const k = key(r);
    if (!map.has(k)) map.set(k, { ...emptyTotals(), ...extra(r) });
    add(map.get(k)!, r);
  }
  return [...map.values()];
}

/** Records every AI call to a local file so people can see what they are spending. */
export class UsageStore {
  private file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "usage.jsonl");
  }

  async record(r: UsageRecord): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(r) + "\n");
  }

  async all(): Promise<UsageRecord[]> {
    try {
      const text = await readFile(this.file, "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as UsageRecord];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  async summary(now = new Date()): Promise<UsageSummary> {
    const records = await this.all();
    const today = now.toISOString().slice(0, 10);
    const monthAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const summary: UsageSummary = {
      allTime: emptyTotals(),
      today: emptyTotals(),
      last30Days: emptyTotals(),
      byModel: group(records, (r) => `${r.connectionName}|${r.model}`, (r) => ({ connectionName: r.connectionName, model: r.model, local: r.local })),
      byProject: group(
        records.filter((r) => r.projectId),
        (r) => r.projectId!,
        (r) => ({ projectId: r.projectId!, projectName: r.projectName ?? "Untitled site" }),
      ),
      byRole: group(records, (r) => r.role, (r) => ({ role: r.role })),
      byDay: group(records.filter((r) => r.at >= monthAgo), (r) => r.at.slice(0, 10), (r) => ({ day: r.at.slice(0, 10) })),
      recent: records.slice(-50).reverse(),
    };
    // A site is named by its plan after the first call, so show the latest name.
    for (const r of records) {
      const site = summary.byProject.find((p) => p.projectId === r.projectId);
      if (site && r.projectName) site.projectName = r.projectName;
    }
    for (const r of records) {
      add(summary.allTime, r);
      if (r.at.startsWith(today)) add(summary.today, r);
      if (r.at >= monthAgo) add(summary.last30Days, r);
    }
    const byTokens = (a: UsageTotals, b: UsageTotals) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
    summary.byModel.sort(byTokens);
    summary.byProject.sort(byTokens);
    summary.byDay.sort((a, b) => a.day.localeCompare(b.day));
    return summary;
  }
}
