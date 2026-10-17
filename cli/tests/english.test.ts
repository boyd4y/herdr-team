import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

test("built-in CLI text is English; Unicode remains user data", () => {
  const offenders: string[] = [];
  function inspect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { inspect(file); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node): void {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
          node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail) {
          if (/\p{Script=Han}/u.test((node as ts.StringLiteral).text)) {
            offenders.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  inspect(join(import.meta.dir, "../scripts"));
  expect(offenders).toEqual([]);
});
