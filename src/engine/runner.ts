import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, shell: process.platform === "win32" });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: String(err) });
    });
  });
}

/**
 * Installs the generated site's dependencies. Install scripts are disabled
 * because the package list was written by an AI. Skips the install when
 * package.json hasn't changed since the last successful one.
 */
export async function installDependencies(dir: string): Promise<{ ok: boolean; output: string }> {
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) return { ok: false, output: "package.json is missing" };
  const hash = createHash("sha256").update(await readFile(pkgPath)).digest("hex");
  const stamp = path.join(dir, "node_modules", ".openforge-install");
  if (existsSync(stamp) && (await readFile(stamp, "utf8")) === hash) return { ok: true, output: "" };

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = await run(npm, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], dir, 180_000);
  if (result.code === 0) await writeFile(stamp, hash);
  return { ok: result.code === 0, output: result.output };
}

export interface RunningApp {
  url: string;
  port: number;
  logs: () => string;
  exited: () => boolean;
  stop: () => Promise<void>;
}

/** Starts the generated site and waits until /api/health answers (or the process dies). */
export async function startApp(dir: string, port?: number, timeoutMs = 20_000): Promise<RunningApp> {
  port ??= await freePort();
  const child: ChildProcess = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), NODE_ENV: "production", ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "openforge" },
  });
  let logs = "";
  let exited = false;
  child.stdout?.on("data", (d) => (logs = (logs + d).slice(-20_000)));
  child.stderr?.on("data", (d) => (logs = (logs + d).slice(-20_000)));
  child.on("exit", () => (exited = true));

  const app: RunningApp = {
    url: `http://127.0.0.1:${port}`,
    port,
    logs: () => logs,
    exited: () => exited,
    stop: () =>
      new Promise((resolve) => {
        if (exited) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      }),
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !exited) {
    try {
      const res = await fetch(`${app.url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return app;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  await app.stop();
  throw new Error(
    exited ? `The server crashed on startup:\n${logs.slice(-4000)}` : `The server did not answer /api/health within ${timeoutMs / 1000}s.\n${logs.slice(-4000)}`,
  );
}
