import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const mode = process.argv.includes('--write') ? 'write' : 'dry-run';
const root = process.cwd();
const targetDir = path.join(root, 'src', 'server');

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
]);

function listTsFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && full.endsWith('.ts')) {
        out.push(full);
      }
    }
  }
  return out;
}

function hasAsyncModifier(node) {
  return !!node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.AsyncKeyword);
}

function isPromiseTypeNode(typeNode) {
  if (!typeNode) return false;
  if (!ts.isTypeReferenceNode(typeNode)) return false;
  const typeName = typeNode.typeName;
  return ts.isIdentifier(typeName) && typeName.text === 'Promise';
}

function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let next = text;
  for (const edit of sorted) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  }
  return next;
}

const files = listTsFiles(targetDir);
let changedFiles = 0;
let editsCount = 0;
const touched = [];

for (const filePath of files) {
  const text = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = [];

  function visit(node) {
    if (FUNCTION_KINDS.has(node.kind) && hasAsyncModifier(node) && node.type && !isPromiseTypeNode(node.type)) {
      const start = node.type.getStart(sourceFile);
      const end = node.type.getEnd();
      const original = text.slice(start, end);
      edits.push({ start, end, text: `Promise<${original}>` });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (edits.length === 0) continue;

  const next = applyEdits(text, edits);
  if (next === text) continue;

  changedFiles += 1;
  editsCount += edits.length;
  touched.push(path.relative(root, filePath));
  if (mode === 'write') {
    fs.writeFileSync(filePath, next, 'utf8');
  }
}

console.log(JSON.stringify({
  mode,
  changedFiles,
  editsCount,
  sampleFiles: touched.slice(0, 20),
}, null, 2));
