import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** A generated project: relative path -> file contents. */
export type FileMap = Map<string, string>;

/**
 * Models return files in this block format. It is far more reliable than JSON
 * for large code files, because nothing inside the file needs escaping.
 *
 *   <<<FILE path="server.js">>>
 *   ...contents...
 *   <<<END FILE>>>
 *
 * A fixer can also delete a file with: <<<DELETE path="old.js">>>
 */
export const FILE_FORMAT_INSTRUCTIONS = `Output every file in this exact format, one block per file, with no markdown code fences around it:

<<<FILE path="relative/path/to/file.ext">>>
(complete file contents)
<<<END FILE>>>

To delete a file, output: <<<DELETE path="relative/path/to/file.ext">>>
Always write complete files, never partial snippets or "rest unchanged" placeholders.`;

const FILE_BLOCK = /<<<FILE path="([^"]+)">>>\r?\n([\s\S]*?)\r?\n?<<<END FILE>>>/g;
const DELETE_BLOCK = /<<<DELETE path="([^"]+)">>>/g;

export interface ParsedFiles {
  files: FileMap;
  deleted: string[];
}

/** Rejects absolute paths and anything that escapes the project folder. */
export function safeRelativePath(raw: string): string | null {
  const normalized = path.posix.normalize(raw.trim().replace(/\\/g, "/")).replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("..") || /^[a-zA-Z]:/.test(normalized)) {
    return null;
  }
  if (normalized.split("/").some((part) => part === "node_modules" || part === ".git")) return null;
  return normalized;
}

export function parseFileBlocks(output: string): ParsedFiles {
  const files: FileMap = new Map();
  for (const match of output.matchAll(FILE_BLOCK)) {
    const filePath = safeRelativePath(match[1]);
    if (filePath) files.set(filePath, stripFence(match[2]));
  }
  const deleted = [...output.matchAll(DELETE_BLOCK)]
    .map((match) => safeRelativePath(match[1]))
    .filter((p): p is string => p !== null);
  return { files, deleted };
}

/** Models sometimes wrap a file's body in ``` fences despite instructions. */
function stripFence(content: string): string {
  const fenced = content.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  return fenced ? fenced[1] : content;
}

export function formatFileBlocks(files: FileMap): string {
  return [...files]
    .map(([filePath, content]) => `<<<FILE path="${filePath}">>>\n${content}\n<<<END FILE>>>`)
    .join("\n\n");
}

export function applyChanges(files: FileMap, changes: ParsedFiles): FileMap {
  const next = new Map(files);
  for (const filePath of changes.deleted) next.delete(filePath);
  for (const [filePath, content] of changes.files) next.set(filePath, content);
  return next;
}

export async function writeProject(dir: string, files: FileMap): Promise<void> {
  // Clear previous output but keep installed dependencies and saved data between rounds.
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir)) {
    if (entry !== "node_modules" && entry !== "data") await rm(path.join(dir, entry), { recursive: true, force: true });
  }
  for (const [filePath, content] of files) {
    const target = path.join(dir, filePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export async function readProject(dir: string): Promise<FileMap> {
  const files: FileMap = new Map();
  async function walk(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      // Skip installed and generated files: npm recreates the lockfile, and data/ belongs to the running site.
      if (["node_modules", "data", "package-lock.json"].includes(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.set(path.relative(dir, full).split(path.sep).join("/"), await readFile(full, "utf8"));
    }
  }
  await walk(dir);
  return files;
}
