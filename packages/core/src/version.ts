import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readCoreExtractorVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../package.json', '../../package.json']) {
    const candidate = path.resolve(here, rel);
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (parsed?.name === '@chomp/core' && typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // Fall through to next candidate
    }
  }
  return '0.2.42';
}

/** Canonical extractor version read from `@chomp/core`'s `package.json`. */
export const CORE_EXTRACTOR_VERSION: string = readCoreExtractorVersion();
