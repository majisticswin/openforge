import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { editSite, forgeSite, type ForgeEvent, type ForgeResult, type Roles } from "./engine/forge.js";
import { readProject } from "./engine/files.js";
import { startApp, installDependencies, type RunningApp } from "./engine/runner.js";
import type { SitePlan } from "./engine/verify.js";
import type { UsageStore } from "./usage.js";

export type ProjectStatus = "working" | "ready" | "failed";

export interface ProjectMeta {
  id: string;
  request: string;
  createdAt: string;
  status: ProjectStatus;
  error?: string;
  plan?: SitePlan;
  history: { at: string; kind: "create" | "edit"; text: string; checksPassed?: number; checksTotal?: number }[];
  roles?: { planner: string; builder: string; reviewers: string[] };
  /** Tokens and cost spent on this site so far, across the build and every edit. */
  usage?: { inputTokens: number; outputTokens: number; cost: number; unpricedCalls: number; calls: number };
}

type Listener = (event: ProjectEvent) => void;
export type ProjectEvent = ForgeEvent | { type: "status"; status: ProjectStatus; error?: string };

/** Keeps generated projects on disk under one folder, and runs at most one job per project. */
export class ProjectStore {
  private events = new Map<string, ProjectEvent[]>();
  private listeners = new Map<string, Set<Listener>>();
  private previews = new Map<string, RunningApp>();

  constructor(
    private root: string,
    private usage?: UsageStore,
    /** Sees every engine event, so the server can remember which models are failing. */
    private watch?: (e: ForgeEvent) => void,
  ) {}

  dir(id: string) {
    return path.join(this.root, id);
  }
  siteDir(id: string) {
    return path.join(this.dir(id), "site");
  }

  async list(): Promise<ProjectMeta[]> {
    if (!existsSync(this.root)) return [];
    const metas: ProjectMeta[] = [];
    for (const id of await readdir(this.root)) {
      const meta = await this.get(id);
      if (meta) metas.push(meta);
    }
    return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<ProjectMeta | undefined> {
    if (!/^[a-z0-9]+$/.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(path.join(this.dir(id), "project.json"), "utf8"));
    } catch {
      return undefined;
    }
  }

  private async save(meta: ProjectMeta) {
    await mkdir(this.dir(meta.id), { recursive: true });
    await writeFile(path.join(this.dir(meta.id), "project.json"), JSON.stringify(meta, null, 2));
  }

  history(id: string): ProjectEvent[] {
    return this.events.get(id) ?? [];
  }

  subscribe(id: string, listener: Listener): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);
    return () => set.delete(listener);
  }

  private emit(id: string, event: ProjectEvent) {
    // Progress ticks are only useful live; keep them out of the replay log.
    if (event.type !== "progress") {
      const log = this.events.get(id) ?? [];
      log.push(event);
      this.events.set(id, log);
    }
    for (const listener of this.listeners.get(id) ?? []) listener(event);
  }

  async create(request: string, roles: Roles, maxRounds?: number): Promise<ProjectMeta> {
    const meta: ProjectMeta = {
      id: Date.now().toString(36) + randomBytes(3).toString("hex"),
      request,
      createdAt: new Date().toISOString(),
      status: "working",
      history: [{ at: new Date().toISOString(), kind: "create", text: request }],
      roles: { planner: roles.planner.label, builder: roles.builder.label, reviewers: roles.reviewers.map((r) => r.label) },
    };
    await this.save(meta);
    this.run(meta, () =>
      forgeSite(request, {
        roles,
        dir: this.siteDir(meta.id),
        maxRounds,
        onEvent: this.jobEvents(meta, roles),
      }),
    );
    return meta;
  }

  async edit(id: string, instruction: string, roles: Roles): Promise<ProjectMeta> {
    const meta = await this.get(id);
    if (!meta) throw new Error("Project not found.");
    if (meta.status === "working") throw new Error("This site is still being worked on. Wait for it to finish first.");
    if (!meta.plan) throw new Error("This project has no finished site to edit.");
    meta.status = "working";
    meta.error = undefined;
    meta.history.push({ at: new Date().toISOString(), kind: "edit", text: instruction });
    await this.save(meta);
    const files = await readProject(this.siteDir(id));
    const plan = meta.plan;
    this.events.set(id, []);
    this.run(meta, () => editSite(instruction, plan, files, { roles, dir: this.siteDir(id), onEvent: this.jobEvents(meta, roles) }));
    return meta;
  }

  /** Forwards engine events to listeners, and records token usage against the site. */
  private jobEvents(meta: ProjectMeta, roles: Roles): (e: ForgeEvent) => void {
    return (e) => {
      if (e.type === "plan") meta.plan = e.plan;
      if (e.type === "switch") {
        meta.roles = { planner: roles.planner.label, builder: roles.builder.label, reviewers: roles.reviewers.map((r) => r.label) };
        void this.save(meta);
      }
      this.watch?.(e);
      if (e.type === "usage") {
        const u = (meta.usage ??= { inputTokens: 0, outputTokens: 0, cost: 0, unpricedCalls: 0, calls: 0 });
        u.calls++;
        u.inputTokens += e.call.inputTokens;
        u.outputTokens += e.call.outputTokens;
        if (e.call.cost === undefined) u.unpricedCalls++;
        else u.cost += e.call.cost;
        void this.usage?.record({ ...e.call, projectId: meta.id, projectName: meta.plan?.name ?? meta.request.slice(0, 60) });
      }
      this.emit(meta.id, e);
    };
  }

  private run(meta: ProjectMeta, job: () => Promise<ForgeResult>) {
    this.emit(meta.id, { type: "status", status: "working" });
    job()
      .then(async (result) => {
        meta.status = "ready";
        meta.plan = result.plan;
        const last = meta.history[meta.history.length - 1];
        last.checksPassed = result.verify.checks.filter((c) => c.ok).length;
        last.checksTotal = result.verify.checks.length;
        await this.save(meta);
        await this.restartPreview(meta.id);
        this.emit(meta.id, { type: "status", status: "ready" });
      })
      .catch(async (err: Error) => {
        meta.status = "failed";
        meta.error = err.message;
        await this.save(meta);
        this.emit(meta.id, { type: "status", status: "failed", error: err.message });
      });
  }

  /** Runs the generated site on its own port so the browser can show it in a frame. */
  async preview(id: string): Promise<string> {
    const running = this.previews.get(id);
    if (running && !running.exited()) return running.url;
    const dir = this.siteDir(id);
    const install = await installDependencies(dir);
    if (!install.ok) throw new Error(`Installing the site's dependencies failed:\n${install.output.slice(-2000)}`);
    const app = await startApp(dir);
    this.previews.set(id, app);
    return app.url;
  }

  private async restartPreview(id: string) {
    const running = this.previews.get(id);
    if (!running) return;
    await running.stop();
    this.previews.delete(id);
  }

  async stopAll() {
    await Promise.all([...this.previews.values()].map((p) => p.stop()));
  }
}
