import { spawnSync } from "node:child_process";
import path from "node:path";
import type { FileMap } from "./files.js";
import { installDependencies, startApp } from "./runner.js";

export interface SitePlan {
  name?: string;
  pages?: { path: string; title?: string }[];
  [key: string]: unknown;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  checks: { name: string; ok: boolean; detail?: string }[];
}

/** Static checks that need no running server. */
export function staticChecks(files: FileMap, plan: SitePlan, dir: string): VerifyResult["checks"] {
  const checks: VerifyResult["checks"] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  const pkgRaw = files.get("package.json");
  let pkg: { scripts?: Record<string, string>; type?: string } | undefined;
  try {
    pkg = pkgRaw ? JSON.parse(pkgRaw) : undefined;
  } catch (err) {
    add("package.json is valid JSON", false, String(err));
  }
  if (!pkgRaw) add("package.json exists", false, "package.json is missing");
  if (pkg) {
    add("package.json has a start script", Boolean(pkg.scripts?.start), "Add \"start\": \"node server.js\"");
    add("package.json uses ES modules", pkg.type === "module", 'Set "type": "module"');
  }
  add("server.js exists", files.has("server.js"), "server.js is missing");

  for (const file of files.keys()) {
    if (!/\.(m?js)$/.test(file) || file.startsWith("public/")) continue;
    const result = spawnSync(process.execPath, ["--check", path.join(dir, file)], { encoding: "utf8" });
    if (result.status !== 0) add(`${file} has valid syntax`, false, result.stderr.trim().slice(0, 1500));
  }

  // Every local link or asset referenced from HTML must exist.
  const pagePaths = new Set((plan.pages ?? []).map((p) => normalizePagePath(p.path)));
  for (const [file, content] of files) {
    if (!file.endsWith(".html")) continue;
    for (const match of content.matchAll(/\s(?:href|src)="([^"#?]+)/g)) {
      const ref = match[1];
      if (/^(https?:|mailto:|tel:|data:|javascript:|\/\/|\$\{)/.test(ref) || ref.startsWith("/api/")) continue;
      const resolved = ref.startsWith("/") ? ref : path.posix.join("/", path.posix.dirname(file.replace(/^public\//, "")), ref);
      const asFile = `public${resolved}`;
      const exists =
        files.has(asFile) ||
        files.has(`${asFile.replace(/\/$/, "")}/index.html`) ||
        files.has(`${asFile}.html`) ||
        pagePaths.has(normalizePagePath(resolved));
      if (!exists) add(`Link "${ref}" in ${file} resolves`, false, `${file} references "${ref}", which does not exist`);
    }
  }
  return checks;
}

function normalizePagePath(p: string): string {
  const clean = p.replace(/\.html$/, "").replace(/\/index$/, "/").replace(/\/+$/, "");
  return clean === "" ? "/" : clean;
}

/** Installs, starts the site, and requests every planned page. */
export async function verifySite(files: FileMap, plan: SitePlan, dir: string): Promise<VerifyResult> {
  const checks = staticChecks(files, plan, dir);
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  if (checks.every((c) => c.ok)) {
    const install = await installDependencies(dir);
    add("Dependencies install", install.ok, install.output.slice(-2000));
    if (install.ok) {
      try {
        const app = await startApp(dir);
        add("Server starts and /api/health responds", true);
        try {
          for (const page of plan.pages ?? [{ path: "/" }]) {
            const res = await fetch(app.url + page.path, { signal: AbortSignal.timeout(5000) });
            const type = res.headers.get("content-type") ?? "";
            add(
              `Page ${page.path} loads`,
              res.ok && type.includes("text/html"),
              `GET ${page.path} returned ${res.status} (${type || "no content type"})`,
            );
          }
          const missing = await fetch(`${app.url}/openforge-missing-page-check`, { signal: AbortSignal.timeout(5000) });
          add("Unknown paths return 404", missing.status === 404, `An unknown path returned ${missing.status}`);
          if (app.exited()) add("Server stays running", false, app.logs().slice(-2000));
        } finally {
          await app.stop();
        }
      } catch (err) {
        add("Server starts and /api/health responds", false, err instanceof Error ? err.message : String(err));
      }
    }
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    checks,
    problems: failed.map((c) => `[automated test] ${c.name}: FAILED. ${c.detail ?? ""}`.trim()),
  };
}
