import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const mode = process.argv.includes('--write') ? 'write' : 'dry-run';
const root = process.cwd();
const targetDir = path.join(root, 'src', 'server');

const METHOD_NAMES = new Set(['all', 'get', 'run']);
const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
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

function isFunctionLike(node) {
  return FUNCTION_KINDS.has(node.kind);
}

function hasAsyncModifier(node) {
  return !!node.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.AsyncKeyword);
}

function getFunctionTokenPos(node, sourceFile) {
  if (node.kind === ts.SyntaxKind.ArrowFunction) {
    return node.getStart(sourceFile);
  }
  if (node.kind === ts.SyntaxKind.MethodDeclaration || node.kind === ts.SyntaxKind.GetAccessor || node.kind === ts.SyntaxKind.SetAccessor) {
    if (!node.name) return node.getStart(sourceFile);
    return node.name.getStart(sourceFile);
  }

  let pos = node.getStart(sourceFile);
  const children = node.getChildren(sourceFile);
  for (const child of children) {
    if (child.kind === ts.SyntaxKind.FunctionKeyword) {
      pos = child.getStart(sourceFile);
      break;
    }
  }
  return pos;
}

function findNearestFunction(node) {
  let current = node.parent;
  while (current) {
    if (isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

function unwrapExpression(node) {
  if (!node) return node;
  if (ts.isParenthesizedExpression(node)) return unwrapExpression(node.expression);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression?.(node)) {
    return unwrapExpression(node.expression);
  }
  return node;
}

function isDbIdentifier(node, queryVars) {
  return ts.isIdentifier(node) && (node.text === 'db' || node.text === 'tx' || queryVars.has(node.text));
}

function dependsOnDb(node, queryVars) {
  const expr = unwrapExpression(node);
  if (!expr) return false;

  if (isDbIdentifier(expr, queryVars)) return true;

  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    return dependsOnDb(expr.expression, queryVars);
  }

  if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) {
    if (dependsOnDb(expr.expression, queryVars)) return true;
    return expr.arguments?.some((arg) => dependsOnDb(arg, queryVars)) ?? false;
  }

  if (ts.isConditionalExpression(expr)) {
    return dependsOnDb(expr.condition, queryVars)
      || dependsOnDb(expr.whenTrue, queryVars)
      || dependsOnDb(expr.whenFalse, queryVars);
  }

  if (ts.isBinaryExpression(expr)) {
    return dependsOnDb(expr.left, queryVars) || dependsOnDb(expr.right, queryVars);
  }

  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.some((el) => dependsOnDb(el, queryVars));
  }

  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.some((prop) => {
      if (ts.isPropertyAssignment(prop)) return dependsOnDb(prop.initializer, queryVars);
      if (ts.isShorthandPropertyAssignment(prop)) return queryVars.has(prop.name.text);
      if (ts.isSpreadAssignment(prop)) return dependsOnDb(prop.expression, queryVars);
      return false;
    });
  }

  return false;
}

function collectQueryVars(sourceFile) {
  const queryVars = new Set();
  let changed = true;

  while (changed) {
    changed = false;
    function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (!queryVars.has(node.name.text) && dependsOnDb(node.initializer, queryVars)) {
          queryVars.add(node.name.text);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  return queryVars;
}

function shouldAwaitDbCall(callNode, queryVars) {
  if (!ts.isPropertyAccessExpression(callNode.expression)) return false;
  const method = callNode.expression.name.text;
  if (!METHOD_NAMES.has(method)) return false;
  if (ts.isAwaitExpression(callNode.parent)) return false;

  const targetExpr = callNode.expression.expression;
  return dependsOnDb(targetExpr, queryVars);
}

function buildEditsForFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const queryVars = collectQueryVars(sourceFile);

  const awaitedCalls = [];
  const asyncFunctions = new Map();

  function visit(node) {
    if (ts.isCallExpression(node) && shouldAwaitDbCall(node, queryVars)) {
      awaitedCalls.push(node);
      const fn = findNearestFunction(node);
      if (fn && !hasAsyncModifier(fn)) {
        asyncFunctions.set(fn.pos + ':' + fn.end, fn);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const edits = [];
  for (const callNode of awaitedCalls) {
    const parent = callNode.parent;
    const callStart = callNode.getStart(sourceFile);
    const callEnd = callNode.getEnd();
    const original = text.slice(callStart, callEnd);
    const needsParens = (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
      && parent.expression === callNode
    );
    const replacement = needsParens ? `(await ${original})` : `await ${original}`;
    edits.push({ start: callStart, end: callEnd, text: replacement, type: 'await' });
  }

  for (const fn of asyncFunctions.values()) {
    const insertPos = getFunctionTokenPos(fn, sourceFile);
    edits.push({ start: insertPos, end: insertPos, text: 'async ', type: 'async' });
  }

  // De-duplicate same edit span/text
  const uniq = new Map();
  for (const edit of edits) {
    const key = `${edit.start}:${edit.end}:${edit.text}`;
    if (!uniq.has(key)) uniq.set(key, edit);
  }

  const finalEdits = [...uniq.values()].sort((a, b) => b.start - a.start || b.end - a.end);
  if (finalEdits.length === 0) {
    return { changed: false, text, nextText: text, awaitCount: 0, asyncCount: 0 };
  }

  let nextText = text;
  for (const edit of finalEdits) {
    nextText = nextText.slice(0, edit.start) + edit.text + nextText.slice(edit.end);
  }

  return {
    changed: nextText !== text,
    text,
    nextText,
    awaitCount: finalEdits.filter((e) => e.type === 'await').length,
    asyncCount: finalEdits.filter((e) => e.type === 'async').length,
  };
}

const files = listTsFiles(targetDir);
let changedFiles = 0;
let totalAwaitEdits = 0;
let totalAsyncEdits = 0;
const touched = [];

for (const file of files) {
  const result = buildEditsForFile(file);
  if (!result.changed) continue;
  changedFiles += 1;
  totalAwaitEdits += result.awaitCount;
  totalAsyncEdits += result.asyncCount;
  touched.push(path.relative(root, file));
  if (mode === 'write') {
    fs.writeFileSync(file, result.nextText, 'utf8');
  }
}

console.log(JSON.stringify({
  mode,
  changedFiles,
  totalAwaitEdits,
  totalAsyncEdits,
  sampleFiles: touched.slice(0, 20),
}, null, 2));
