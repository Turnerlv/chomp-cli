/**
 * packages/cli/src/utils/credentials.ts
 *
 * Local Chomp credential persistence (`~/.chomp/credentials.json` with `0600` permissions)
 * for GitHub 14-day Trial JWTs (`chomp_tok_...`) and Pro / Team SLA License Keys (`chomp_live_...`).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface ChompLocalCredentials {
  token?: string;
  apiKey?: string;
  githubHandle?: string;
  updatedAt?: string;
}

export function getChompCredentialsPath(): string {
  const override = process.env.CHOMP_CREDENTIALS_PATH?.trim();
  if (override) {
    return resolve(override);
  }
  return resolve(homedir(), ".chomp", "credentials.json");
}

export function decodeJwtPayloadUnsafe(token: string): Record<string, any> | null {
  try {
    const stripped = token.startsWith("chomp_tok_")
      ? token.slice("chomp_tok_".length)
      : token;
    const parts = stripped.split(".");
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function loadChompCredentials(): ChompLocalCredentials | null {
  const credPath = getChompCredentialsPath();
  if (!existsSync(credPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(credPath, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const result: ChompLocalCredentials = {};
    if (typeof raw.token === "string" && raw.token.trim()) {
      result.token = raw.token.trim();
    }
    if (typeof raw.apiKey === "string" && raw.apiKey.trim()) {
      result.apiKey = raw.apiKey.trim();
    }
    if (typeof raw.githubHandle === "string" && raw.githubHandle.trim()) {
      result.githubHandle = raw.githubHandle.trim();
    } else if (result.token) {
      const payload = decodeJwtPayloadUnsafe(result.token);
      if (typeof payload?.handle === "string" && payload.handle.trim()) {
        result.githubHandle = payload.handle.trim();
      }
    }
    if (typeof raw.updatedAt === "string" && raw.updatedAt.trim()) {
      result.updatedAt = raw.updatedAt.trim();
    }
    if (!result.token && !result.apiKey) return null;
    return result;
  } catch {
    return null;
  }
}

export function saveChompCredentials(
  patch: Partial<ChompLocalCredentials>,
): ChompLocalCredentials {
  const credPath = getChompCredentialsPath();
  const dir = dirname(credPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prev = loadChompCredentials() ?? {};
  const next: ChompLocalCredentials = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (next.token && !next.githubHandle) {
    const payload = decodeJwtPayloadUnsafe(next.token);
    if (typeof payload?.handle === "string" && payload.handle.trim()) {
      next.githubHandle = payload.handle.trim();
    }
  }
  if (!next.token) delete next.token;
  if (!next.apiKey) delete next.apiKey;
  if (!next.githubHandle) delete next.githubHandle;

  writeFileSync(credPath, JSON.stringify(next, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(credPath, 0o600);
  } catch {
    // Non-fatal on platforms without POSIX chmod
  }
  return next;
}

export function clearChompCredentials(): void {
  const credPath = getChompCredentialsPath();
  if (existsSync(credPath)) {
    try {
      unlinkSync(credPath);
    } catch {
      // ignore
    }
  }
}

/**
 * Resolves the active Bearer credential in precedence order:
 * explicit option -> env `CHOMP_API_KEY` -> saved `apiKey` (`chomp_live_...`) -> saved `token` (`chomp_tok_...`).
 */
export function resolveActiveBearerToken(explicitApiKey?: string): string | undefined {
  if (explicitApiKey && explicitApiKey.trim()) {
    return explicitApiKey.trim();
  }
  if (process.env.CHOMP_API_KEY && process.env.CHOMP_API_KEY.trim()) {
    return process.env.CHOMP_API_KEY.trim();
  }
  const creds = loadChompCredentials();
  return creds?.apiKey || creds?.token || undefined;
}
