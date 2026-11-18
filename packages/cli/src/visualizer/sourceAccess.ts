import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

export type EditorScheme = "cursor" | "windsurf" | "kiro" | "vscode";

const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EXPRESSION_LENGTH = 160;

/**
 * Safely resolves a repo-relative file path strictly within `repoRoot` using `realpathSync`
 * containment so path traversal (`..`) and symlink escapes outside the repo are rejected.
 */
export function resolveSafeRepoFile(
  repoRoot: string,
  relFilePath: string,
): string | null {
  if (!repoRoot || !relFilePath || typeof relFilePath !== "string") return null;
  if (relFilePath.includes("\0")) return null;
  const trimmed = relFilePath.trim().replace(/^file:\/\//i, "");
  if (!trimmed) return null;

  try {
    const realRoot = realpathSync(resolve(repoRoot));
    const candidate = resolve(realRoot, trimmed);
    if (!existsSync(candidate)) return null;
    const realFile = realpathSync(candidate);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
      return null;
    }
    const st = statSync(realFile);
    if (!st.isFile()) return null;
    return realFile;
  } catch {
    return null;
  }
}

/**
 * Reads a single 1-based source line from a validated repository file for localhost-only
 * `UNKNOWN` / `LIKELY` call-shape tooltips. Never exposes full files or binary data.
 */
export function readSingleSourceLine(
  repoRoot: string,
  relFilePath: string,
  lineNumber: number,
): { filePath: string; lineNumber: number; expression: string } | null {
  if (!Number.isInteger(lineNumber) || lineNumber < 1) return null;
  const realFile = resolveSafeRepoFile(repoRoot, relFilePath);
  if (!realFile) return null;

  try {
    const st = statSync(realFile);
    if (st.size > MAX_SOURCE_FILE_BYTES) return null;
    const raw = readFileSync(realFile, "utf-8");
    if (raw.includes("\0")) return null;
    const lines = raw.split(/\r?\n/);
    if (lineNumber > lines.length) return null;
    const rawLine = (lines[lineNumber - 1] ?? "").replace(/\t/g, "  ").trim();
    if (!rawLine) return null;
    const expression =
      rawLine.length > MAX_EXPRESSION_LENGTH
        ? `${rawLine.slice(0, MAX_EXPRESSION_LENGTH - 1)}…`
        : rawLine;
    return {
      filePath: relFilePath.trim(),
      lineNumber,
      expression,
    };
  } catch {
    return null;
  }
}

/**
 * Detects the active local IDE scheme from environment variables and workspace markers.
 */
export function detectPreferredEditorScheme(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): EditorScheme {
  const explicit = (env.CHOMP_IDE ?? "").trim().toLowerCase();
  if (
    explicit === "cursor" ||
    explicit === "windsurf" ||
    explicit === "kiro" ||
    explicit === "vscode"
  ) {
    return explicit;
  }

  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (env.CURSOR_TRACE_ID || termProgram.includes("cursor")) return "cursor";
  if (termProgram.includes("windsurf")) return "windsurf";
  if (termProgram.includes("kiro")) return "kiro";
  if (env.VSCODE_IPC_HOOK_CLI || termProgram.includes("vscode")) return "vscode";

  try {
    const absRoot = resolve(repoRoot);
    if (existsSync(resolve(absRoot, ".cursor"))) return "cursor";
    if (existsSync(resolve(absRoot, ".windsurf"))) return "windsurf";
    if (existsSync(resolve(absRoot, ".kiro"))) return "kiro";
    if (existsSync(resolve(absRoot, ".vscode"))) return "vscode";
  } catch {
    // Ignore fs errors
  }

  return "vscode";
}

/**
 * Builds an IDE `file` deep-link URI (`cursor://file/...`, `vscode://file/...`, etc.).
 */
export function buildEditorUri(
  absFilePath: string,
  lineNumber?: number,
  scheme: EditorScheme = "vscode",
): string {
  const posixAbs = absFilePath.replace(/\\/g, "/");
  const withLeadingSlash = posixAbs.startsWith("/") ? posixAbs : `/${posixAbs}`;
  const encodedPath = withLeadingSlash
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const lineSuffix =
    typeof lineNumber === "number" && Number.isInteger(lineNumber) && lineNumber >= 1
      ? `:${lineNumber}:1`
      : "";
  return `${scheme}://file${encodedPath}${lineSuffix}`;
}

/**
 * Builds a remote GitHub / GitLab blob URL (`#L<line>`) when `remoteUrl` is available.
 */
export function buildRemoteFileUrl(
  remoteUrl: string | undefined,
  commitSha: string | undefined,
  relFilePath: string,
  lineNumber?: number,
): string | null {
  if (!remoteUrl || !relFilePath) return null;
  const base = remoteUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return null;
  const cleanRel = relFilePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!cleanRel || cleanRel.includes("..")) return null;
  const ref = (commitSha ?? "").trim() || "HEAD";
  const encodedRel = cleanRel
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const isGitLab = /gitlab/i.test(base);
  const blobPrefix = isGitLab ? "/-/blob" : "/blob";
  const lineAnchor =
    typeof lineNumber === "number" && Number.isInteger(lineNumber) && lineNumber >= 1
      ? `#L${lineNumber}`
      : "";
  return `${base}${blobPrefix}/${encodeURIComponent(ref)}/${encodedRel}${lineAnchor}`;
}

function tryExecEditorCli(
  bin: string,
  targetArg: string,
): Promise<boolean> {
  return new Promise((resolveDone) => {
    try {
      const child = execFile(
        bin,
        ["-g", targetArg],
        { timeout: 2500, windowsHide: true },
        (err) => {
          resolveDone(!err);
        },
      );
      child.on("error", () => resolveDone(false));
    } catch {
      resolveDone(false);
    }
  });
}

/**
 * Opens a validated repository file in the developer's local IDE via safe `execFile`
 * (`-g file:line`), returning both `editorUri` and `remoteFileUrl` fallbacks.
 */
export async function openInLocalEditor(params: {
  repoRoot: string;
  relFilePath: string;
  lineNumber?: number;
  remoteUrl?: string;
  commitSha?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  ok: boolean;
  openedLocally: boolean;
  editorScheme?: EditorScheme;
  editorUri?: string;
  remoteFileUrl?: string;
}> {
  const { repoRoot, relFilePath, lineNumber, remoteUrl, commitSha, env } = params;
  const remoteFileUrl =
    buildRemoteFileUrl(remoteUrl, commitSha, relFilePath, lineNumber) ?? undefined;
  const realFile = resolveSafeRepoFile(repoRoot, relFilePath);
  if (!realFile) {
    return {
      ok: false,
      openedLocally: false,
      ...(remoteFileUrl ? { remoteFileUrl } : {}),
    };
  }

  const scheme = detectPreferredEditorScheme(repoRoot, env);
  const editorUri = buildEditorUri(realFile, lineNumber, scheme);
  const lineArg =
    typeof lineNumber === "number" && Number.isInteger(lineNumber) && lineNumber >= 1
      ? `${realFile}:${lineNumber}`
      : realFile;

  const cliCandidates =
    scheme === "cursor"
      ? ["cursor", "code"]
      : scheme === "windsurf"
        ? ["windsurf", "code"]
        : scheme === "kiro"
          ? ["kiro", "code"]
          : ["code", "cursor"];

  let openedLocally = false;
  for (const bin of cliCandidates) {
    if (await tryExecEditorCli(bin, lineArg)) {
      openedLocally = true;
      break;
    }
  }

  return {
    ok: true,
    openedLocally,
    editorScheme: scheme,
    editorUri,
    ...(remoteFileUrl ? { remoteFileUrl } : {}),
  };
}
