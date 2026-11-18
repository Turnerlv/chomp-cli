import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { normalizeGitRemoteWebUrl } from "../utils/git.js";
import {
  buildEditorUri,
  buildRemoteFileUrl,
  detectPreferredEditorScheme,
  readSingleSourceLine,
  resolveSafeRepoFile,
} from "./sourceAccess.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

describe("sourceAccess & IDE deep-link helpers", () => {
  it("resolves valid in-repo files and blocks path traversal outside repoRoot", () => {
    const valid = resolveSafeRepoFile(
      REPO_ROOT,
      "packages/cli/src/visualizer/sourceAccess.ts",
    );
    assert.ok(valid && valid.endsWith("sourceAccess.ts"));

    assert.equal(resolveSafeRepoFile(REPO_ROOT, "../../etc/passwd"), null);
    assert.equal(resolveSafeRepoFile(REPO_ROOT, "/etc/passwd"), null);
    assert.equal(resolveSafeRepoFile(REPO_ROOT, "nonexistent/file.ts"), null);
    assert.equal(resolveSafeRepoFile(REPO_ROOT, "packages/cli\0/evil.ts"), null);
  });

  it("reads a single trimmed 1-based source line and rejects out-of-range lines", () => {
    const line1 = readSingleSourceLine(
      REPO_ROOT,
      "packages/cli/src/visualizer/sourceAccess.ts",
      1,
    );
    assert.ok(line1);
    assert.equal(line1.filePath, "packages/cli/src/visualizer/sourceAccess.ts");
    assert.equal(line1.lineNumber, 1);
    assert.match(line1.expression, /import \{ execFile \} from "node:child_process";/);

    assert.equal(
      readSingleSourceLine(REPO_ROOT, "packages/cli/src/visualizer/sourceAccess.ts", 0),
      null,
    );
    assert.equal(
      readSingleSourceLine(REPO_ROOT, "packages/cli/src/visualizer/sourceAccess.ts", 999999),
      null,
    );
    assert.equal(
      readSingleSourceLine(REPO_ROOT, "../../etc/passwd", 1),
      null,
    );
  });

  it("detects preferred editor scheme and formats editor + remote GitHub/GitLab URLs cleanly", () => {
    assert.equal(
      detectPreferredEditorScheme(REPO_ROOT, { CHOMP_IDE: "cursor" }),
      "cursor",
    );
    assert.equal(
      detectPreferredEditorScheme(REPO_ROOT, { TERM_PROGRAM: "Windsurf" }),
      "windsurf",
    );
    assert.equal(
      buildEditorUri("/Users/dev/project/src/router.ts", 84, "cursor"),
      "cursor://file/Users/dev/project/src/router.ts:84:1",
    );

    assert.equal(
      normalizeGitRemoteWebUrl("git@github.com:acme/chomp.git"),
      "https://github.com/acme/chomp",
    );
    assert.equal(
      normalizeGitRemoteWebUrl("https://oauth2:secret@github.com/acme/chomp.git"),
      "https://github.com/acme/chomp",
    );

    assert.equal(
      buildRemoteFileUrl(
        "https://github.com/acme/chomp",
        "71d9aff",
        "packages/cli/src/commands/ui.ts",
        326,
      ),
      "https://github.com/acme/chomp/blob/71d9aff/packages/cli/src/commands/ui.ts#L326",
    );
    assert.equal(
      buildRemoteFileUrl(
        "https://gitlab.com/acme/chomp",
        "main",
        "src/router.ts",
        42,
      ),
      "https://gitlab.com/acme/chomp/-/blob/main/src/router.ts#L42",
    );
  });
});
