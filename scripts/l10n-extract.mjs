// Collects the strings passed to vscode.l10n.t() (host) and t() (webview, webview/l10n.ts)
// into l10n/bundle.l10n.json, the English source of the translations
// (l10n/bundle.l10n.<language>.json). Run after adding or changing UI strings:
//   npm run l10n           write the bundle
//   npm run l10n -- --check fail if the bundle is out of date
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "l10n", "bundle.l10n.json");

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "testing" ? [] : sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const messages = new Map();
const problems = [];
for (const file of [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "webview"))]) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const isWebview = relative(root, file).startsWith("webview");
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (callee === "vscode.l10n.t" || (isWebview && callee === "t")) {
        const [first] = node.arguments;
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
          messages.set(first.text, first.text);
        } else {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          problems.push(`${relative(root, file)}:${line + 1}: the message must be a string literal`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

const sorted = Object.fromEntries([...messages].sort(([a], [b]) => a.localeCompare(b, "en")));
const json = `${JSON.stringify(sorted, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(output, "utf8");
  } catch {
    // Missing: out of date.
  }
  if (current !== json) {
    console.error("l10n/bundle.l10n.json is out of date: run npm run l10n");
    process.exit(1);
  }
  console.log(`l10n bundle up to date (${messages.size} messages)`);
} else {
  writeFileSync(output, json);
  console.log(`${relative(root, output)}: ${messages.size} messages`);
}
