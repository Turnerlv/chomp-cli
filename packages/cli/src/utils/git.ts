import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/**
 * Resolves the canonical repository name for `inputPath` (`[PAT-VIS-24]`, `[PAT-CLI-13]`).
 *
 * When running inside a Git worktree (where `.git` is a pointer file containing
 * `gitdir: /path/to/<repo>/.git/worktrees/<worktree>`), resolves `commondir` back to
 * the parent repository root (`<repo>`) instead of returning the worktree/branch directory name.
 * Preserves standalone non-git fixture directories (`fixtures/cloned-repos/<name>`,
 * `fixtures/test-repos/<name>`, or isolated `.chomp/` target directories).
 */
export function resolveRepoName(inputPath: string): string {
  const abs = resolve(inputPath);
  let dir = abs;
  try {
    if (existsSync(abs) && !statSync(abs).isDirectory()) {
      dir = dirname(abs);
    }
  } catch {
    // Path may not exist yet (e.g. dry-run); fall back to basename(abs)
  }

  const posixDir = dir.replace(/\\/g, '/');
  const fixtureMatch = /\/fixtures\/(?:cloned-repos|test-repos)\/([^/]+)(?:\/|$)/.exec(posixDir);
  if (fixtureMatch) {
    const matchEnd =
      posixDir.indexOf(fixtureMatch[0]) + fixtureMatch[0].replace(/\/$/, '').length;
    const fixtureRoot = dir.slice(0, matchEnd);
    if (!existsSync(resolve(fixtureRoot, '.git'))) {
      return fixtureMatch[1];
    }
  }

  if (existsSync(resolve(dir, '.chomp')) && !existsSync(resolve(dir, '.git'))) {
    return basename(dir);
  }

  try {
    let cur = dir;
    let gitEntryPath: string | undefined;
    let gitOwnerDir: string | undefined;
    for (let i = 0; i < 8; i++) {
      const candidate = resolve(cur, '.git');
      if (existsSync(candidate)) {
        gitEntryPath = candidate;
        gitOwnerDir = cur;
        break;
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }

    if (gitEntryPath && gitOwnerDir) {
      const stat = statSync(gitEntryPath);
      if (stat.isFile()) {
        const ptr = readFileSync(gitEntryPath, 'utf-8').trim();
        const match = /^gitdir:\s*(.+)$/i.exec(ptr);
        if (match) {
          const gitDir = resolve(gitOwnerDir, match[1].trim());
          const commonDirFile = resolve(gitDir, 'commondir');
          if (existsSync(commonDirFile)) {
            const relCommon = readFileSync(commonDirFile, 'utf-8').trim();
            if (relCommon) {
              const commonDir = resolve(gitDir, relCommon);
              if (basename(commonDir) === '.git') {
                return basename(dirname(commonDir));
              }
              const cleanBare = basename(commonDir).replace(/\.git$/i, '');
              if (cleanBare) return cleanBare;
            }
          }
          const normalizedGitDir = gitDir.replace(/\\/g, '/');
          const wtMatch = /^(.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(normalizedGitDir);
          if (wtMatch && wtMatch[1]) {
            return basename(wtMatch[1]);
          }
          return basename(gitOwnerDir);
        }
      }
      if (stat.isDirectory()) {
        if (
          gitOwnerDir !== dir &&
          existsSync(resolve(dir, 'package.json')) &&
          !dir.startsWith(resolve(gitOwnerDir, 'packages') + '/') &&
          !dir.startsWith(resolve(gitOwnerDir, 'apps') + '/')
        ) {
          return basename(dir);
        }
        if (!posixDir.includes('/.chomp/')) {
          return basename(gitOwnerDir);
        }
      }
    }
  } catch {
    // Fall back to basename(dir)
  }

  return basename(dir);
}

export function normalizeGitRemoteWebUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;

  // SSH SCP-like syntax: git@github.com:owner/repo.git
  const scpMatch = /^(?:[^@]+@)?([a-zA-Z0-9.-]+):([a-zA-Z0-9._/-]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scpMatch && !trimmed.includes('://')) {
    const [, host, repoPath] = scpMatch;
    return `https://${host}/${repoPath.replace(/^\/+/, '')}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'ssh:') {
      const cleanPath = parsed.pathname.replace(/\.git\/?$/, '').replace(/\/+$/, '');
      if (!cleanPath || cleanPath === '/') return undefined;
      const protocol = parsed.protocol === 'http:' ? 'http:' : 'https:';
      return `${protocol}//${parsed.host}${cleanPath}`;
    }
  } catch {
    // Ignore malformed remote URLs
  }
  return undefined;
}

function readRemoteOriginFromGitConfig(commonDir: string): string | undefined {
  try {
    const configPath = resolve(commonDir, 'config');
    if (!existsSync(configPath)) return undefined;
    const raw = readFileSync(configPath, 'utf-8');
    const originBlock = /\[remote\s+"origin"\]([\s\S]*?)(?:\n\[|$)/.exec(raw);
    if (!originBlock) return undefined;
    const urlLine = /^\s*url\s*=\s*(.+)$/m.exec(originBlock[1]);
    return normalizeGitRemoteWebUrl(urlLine?.[1]);
  } catch {
    return undefined;
  }
}

function readGitInfoFromFs(startDir: string): {
  commitSha?: string;
  branchName?: string;
  commitMessage?: string;
  remoteUrl?: string;
} {
  try {
    let cur = resolve(startDir);
    let gitEntryPath: string | undefined;
    for (let i = 0; i < 8; i++) {
      const candidate = resolve(cur, '.git');
      if (existsSync(candidate)) {
        gitEntryPath = candidate;
        break;
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    if (!gitEntryPath) return {};

    let gitDir = gitEntryPath;
    if (statSync(gitEntryPath).isFile()) {
      const ptr = readFileSync(gitEntryPath, 'utf-8').trim();
      if (ptr.startsWith('gitdir:')) {
        gitDir = resolve(dirname(gitEntryPath), ptr.slice('gitdir:'.length).trim());
      }
    }

    let commonDir = gitDir;
    const commonDirFile = resolve(gitDir, 'commondir');
    if (existsSync(commonDirFile)) {
      const relCommon = readFileSync(commonDirFile, 'utf-8').trim();
      if (relCommon) {
        commonDir = resolve(gitDir, relCommon);
      }
    }

    let commitMessage: string | undefined;
    for (const base of [gitDir, commonDir]) {
      const editMsgFile = resolve(base, 'COMMIT_EDITMSG');
      if (existsSync(editMsgFile)) {
        const rawMsg = readFileSync(editMsgFile, 'utf-8')
          .split('\n')
          .filter((line) => !line.startsWith('#'))
          .join('\n')
          .trim();
        if (rawMsg) {
          commitMessage = rawMsg;
          break;
        }
      }
    }

    const remoteUrl = readRemoteOriginFromGitConfig(commonDir);

    const headFile = resolve(gitDir, 'HEAD');
    if (!existsSync(headFile)) return remoteUrl ? { remoteUrl } : {};
    const headRaw = readFileSync(headFile, 'utf-8').trim();

    if (headRaw.startsWith('ref:')) {
      const refPath = headRaw.slice('ref:'.length).trim();
      const branchName = refPath.startsWith('refs/heads/')
        ? refPath.slice('refs/heads/'.length)
        : undefined;

      for (const base of [gitDir, commonDir]) {
        const looseRef = resolve(base, refPath);
        if (existsSync(looseRef)) {
          const sha = readFileSync(looseRef, 'utf-8').trim();
          if (sha) return { commitSha: sha, branchName, commitMessage, remoteUrl };
        }
      }

      const packedRefs = resolve(commonDir, 'packed-refs');
      if (existsSync(packedRefs)) {
        const lines = readFileSync(packedRefs, 'utf-8').split('\n');
        for (const line of lines) {
          if (!line || line.startsWith('#') || line.startsWith('^')) continue;
          const [sha, ref] = line.trim().split(/\s+/);
          if (ref === refPath && sha) {
            return { commitSha: sha, branchName, commitMessage, remoteUrl };
          }
        }
      }

      return { branchName, commitMessage, remoteUrl };
    }

    if (/^[0-9a-f]{7,40}$/i.test(headRaw)) {
      return { commitSha: headRaw, commitMessage, remoteUrl };
    }
    return remoteUrl ? { remoteUrl } : {};
  } catch {
    return {};
  }
}

export function getGitInfo(cwd: string): {
  commitSha?: string;
  branchName?: string;
  commitMessage?: string;
  remoteUrl?: string;
} {
  const absCwd = resolve(cwd);
  if (
    (absCwd.includes('/fixtures/cloned-repos/') || absCwd.includes('/fixtures/test-repos/')) &&
    !existsSync(resolve(absCwd, '.git'))
  ) {
    return {};
  }
  try {
    const commitSha = execSync('git rev-parse HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const branchName = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    let commitMessage: string | undefined;
    try {
      commitMessage = execSync('git log -1 --pretty=%B', {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Ignore if git log fails on empty repo
    }
    let remoteUrl: string | undefined;
    try {
      const rawRemote = execSync('git config --get remote.origin.url', {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      remoteUrl = normalizeGitRemoteWebUrl(rawRemote);
    } catch {
      // Ignore if origin remote is not configured
    }

    return {
      commitSha: commitSha || undefined,
      branchName: branchName === 'HEAD' ? undefined : branchName || undefined, // handle detached head
      commitMessage: commitMessage || undefined,
      remoteUrl,
    };
  } catch {
    // Fallback to direct .git/HEAD filesystem inspection if git CLI fails or is restricted
    return readGitInfoFromFs(cwd);
  }
}
