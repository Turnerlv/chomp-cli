/**
 * @file boundaryRules.test.ts
 * Automated architectural boundary enforcement tests for `@chomp/core` (AGENTS.md §9 & [PAT-EXT-28]).
 *
 * Verifies:
 *   1. DB Isolation: `@chomp/core` has zero imports from `@chomp/db`, `better-sqlite3`, or `sqlite3`.
 *   2. Ontology Isolation: `packages/core/src/types/ontology.ts` has zero external or cross-module imports.
 *   3. Core Visitor Purity ([PAT-EXT-28]): The 6 language-level core visitor/orchestrator files
 *      (`contractVisitor.ts`, `relationshipVisitor.ts`, `openConnectorVisitor.ts`, `boundaryVisitor.ts`,
 *      `targetResolver.ts`, `extractor/index.ts`) contain zero inline framework string literals or regexes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const CORE_SRC_DIR = path.resolve(import.meta.dirname);

const CORE_VISITOR_FILES = [
  "extractor/visitors/contractVisitor.ts",
  "extractor/visitors/relationshipVisitor.ts",
  "extractor/visitors/openConnectorVisitor.ts",
  "extractor/visitors/boundaryVisitor.ts",
  "extractor/visitors/targetResolver.ts",
  "extractor/index.ts",
] as const;

const FORBIDDEN_FRAMEWORK_LITERAL_REGEX =
  /\b(next|nextjs|express|nestjs|remix|astro|payload|hono|prisma|supabase|electron|trpc|drizzle|typeorm|mongoose|sequelize|bullmq|agenda|socket\.io|redux|zustand)\b/i;

function collectTypeScriptFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTypeScriptFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(abs);
    }
  }
  return results;
}

function isInsideImportOrExportDeclaration(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isImportDeclaration(cur) || ts.isExportDeclaration(cur)) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

describe("AGENTS.md §9 Architectural Boundary Rules (@chomp/core)", () => {
  it("Rule 9.1 (DB Isolation): @chomp/core contains zero database imports (@chomp/db, better-sqlite3, sqlite3)", () => {
    const allFiles = collectTypeScriptFiles(CORE_SRC_DIR).filter(
      (f) => !f.endsWith("boundaryRules.test.ts")
    );
    const violations: string[] = [];

    for (const filePath of allFiles) {
      const content = fs.readFileSync(filePath, "utf8");
      const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const spec = node.moduleSpecifier.text;
          if (
            spec === "@chomp/db" ||
            spec.startsWith("@chomp/db/") ||
            spec === "better-sqlite3" ||
            spec === "sqlite3"
          ) {
            const rel = path.relative(CORE_SRC_DIR, filePath);
            violations.push(`${rel}: imports '${spec}'`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    assert.deepEqual(violations, []);
  });

  it("Rule 9.2 (Ontology Isolation): packages/core/src/types/ontology.ts has zero imports", () => {
    const ontologyPath = path.join(CORE_SRC_DIR, "types/ontology.ts");
    const content = fs.readFileSync(ontologyPath, "utf8");
    const sf = ts.createSourceFile(ontologyPath, content, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];

    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier) {
        imports.push(stmt.moduleSpecifier.getText(sf));
      }
    }

    assert.deepEqual(
      imports,
      [],
      "ontology.ts must remain a pure zero-dependency data shape definition"
    );
  });

  it("Rule 9.3 ([PAT-EXT-28] Core Visitor Purity): core visitors and orchestrator contain zero inline framework literals or regexes", () => {
    const violations: string[] = [];

    for (const relPath of CORE_VISITOR_FILES) {
      const absPath = path.join(CORE_SRC_DIR, relPath);
      const content = fs.readFileSync(absPath, "utf8");
      const sf = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, true);
      const lines = content.split("\n");

      const visit = (node: ts.Node) => {
        if (
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isRegularExpressionLiteral(node)) &&
          !isInsideImportOrExportDeclaration(node)
        ) {
          const text = node.getText(sf);
          if (FORBIDDEN_FRAMEWORK_LITERAL_REGEX.test(text)) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push(
              `${relPath}:${line + 1} -> ${text} (${lines[line]?.trim() ?? ""})`
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    assert.deepEqual(
      violations,
      [],
      `Found inline framework literal(s) in core visitors; move them to conventions/frameworks.ts or sourcePreprocessor.ts:\n${violations.join("\n")}`
    );
  });
});
