import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const root = new URL('../apps/web/src/i18n/locales/', import.meta.url);
const locales = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
const namespaces = (locale) => readdirSync(new URL(`${locale}/`, root)).filter((name) => name.endsWith('.json')).sort();
const plural = /_(zero|one|two|few|many|other)$/;
const variables = (value) => [...new Set([...value.matchAll(/{{-?\s*([\w.]+)(?:\s*,[^}]+)?\s*}}/g)].map((match) => match[1]))].sort();

function messages(value, path = '', result = new Map()) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${path}: expected an object`);
  for (const [key, entry] of Object.entries(value)) {
    const name = path ? `${path}.${key}` : key;
    if (typeof entry === 'string') {
      assert.ok(entry.trim(), `${name}: empty translation`);
      result.set(name, entry);
    } else messages(entry, name, result);
  }
  return result;
}

function normalize(catalog, locale) {
  const result = new Map(), groups = new Map();
  for (const [key, value] of catalog) {
    const match = key.match(plural), name = key.replace(plural, '');
    const tokens = variables(value);
    if (result.has(name)) assert.deepEqual(tokens, result.get(name).tokens, `${locale}:${key}: plural interpolation differs`);
    result.set(name, { plural: !!match, tokens });
    if (match) {
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(match[1]);
    }
  }
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  for (const [key, forms] of groups) {
    assert.equal(catalog.has(key), false, `${locale}:${key}: do not mix a plain key and plural forms`);
    assert.deepEqual(forms.filter((form) => form !== 'zero' || categories.includes('zero')).sort(), [...categories].sort(),
      `${locale}:${key}: expected locale-specific cardinal plural forms`);
  }
  return result;
}

test('bundled catalogs match English keys, interpolation and locale-specific plural forms', () => {
  assert.ok(locales.includes('en'), 'English is the canonical catalog');
  const canonical = namespaces('en');
  assert.ok(canonical.length > 0);
  for (const locale of locales) {
    assert.deepEqual(namespaces(locale), canonical, `${locale}: missing or extra namespace`);
    for (const namespace of canonical) {
      const read = (language) => messages(JSON.parse(readFileSync(new URL(`${language}/${namespace}`, root), 'utf8')));
      const expected = normalize(read('en'), 'en'), actual = normalize(read(locale), locale);
      assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), `${locale}/${namespace}: missing or extra key`);
      for (const [key, entry] of expected) assert.deepEqual(actual.get(key), entry, `${locale}/${namespace}:${key}: interpolation or plural contract differs`);
    }
  }
});

// Brand names, language autonyms, key names, encodings, and protocol examples
// intentionally keep their spelling. This is not a sentence-level allowlist.
const technical = new Set(['TeachMeCoding', 'Agent', 'CRLF', 'YOLO', 'Enter', 'Shift', 'IDE', '· UTF-8', 'English', '简体中文', 'npx', 'https://example.com/mcp']);
const retired = new Set(['actionReceipt', 'executionFeedback', 'errorDetail', 'issueDetail', 'followupErrorDetail']);

function sourceViolations(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const result = [];
  const web = file.startsWith('apps/web/src/') && !file.includes('/fixtures/');
  const report = (node, reason) => result.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${reason}`);
  const copy = (node, value) => {
    const text = value.trim();
    if (/\p{L}/u.test(text) && !technical.has(text)) report(node, `literal UI copy: ${text}`);
  };
  function visit(node) {
    if (ts.isIdentifier(node) && retired.has(node.text)) report(node, `retired localization path: ${node.text}`);
    if (ts.isNewExpression(node) && node.expression.getText(sf) === 'BusinessError'
      && (node.arguments?.length !== 2 || ts.isStringLiteralLike(node.arguments[1]))) report(node, 'BusinessError must carry semantic detail only');
    if (web) {
      if (ts.isJsxText(node)) copy(node, node.text);
      if (ts.isJsxAttribute(node) && node.initializer && ['placeholder', 'aria-label', 'title', 'alt'].includes(node.name.getText(sf))
        && ts.isStringLiteral(node.initializer)) copy(node, node.initializer.text);
      if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteralLike(node.expression)) {
        const attributes = ts.isJsxAttribute(node.parent) ? node.parent.parent.properties : [];
        const codeExample = attributes.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(sf) === 'translate'
          && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === 'no');
        if (!codeExample) copy(node, node.expression.text);
      }
      if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && /\p{Script=Han}/u.test(node.getText(sf))
        && !(file === 'apps/web/src/components/settings/settings-page.tsx' && ts.isStringLiteral(node) && node.text === '简体中文')) {
        report(node, 'Chinese UI literal outside catalogs');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return result;
}

const sourceFiles = (directory, relative) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
  ? sourceFiles(new URL(`${entry.name}/`, directory), `${relative}/${entry.name}`)
  : /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')
    ? [{ path: `${relative}/${entry.name}`, url: new URL(entry.name, directory) }] : []);

test('first-party UI has one catalog path and no retired Chinese builders or dual error fields', () => {
  const failures = ['apps/web/src', 'apps/server/src', 'packages/contracts/src'].flatMap((directory) =>
    sourceFiles(new URL(`../${directory}/`, import.meta.url), directory).flatMap(({ path, url }) => sourceViolations(path, readFileSync(url, 'utf8'))));
  assert.deepEqual(failures, []);
});

test('the source audit rejects planted Chinese and English bypasses and old error constructors', () => {
  const file = 'apps/web/src/components/audit-probe.tsx';
  for (const source of ['<button>Save changes</button>', '<input placeholder="Untranslated" />', '<p>{"遗漏中文"}</p>',
    'throw new BusinessError(400, "旧错误", { code: "INVALID_REQUEST" })', 'const value = response.errorDetail']) {
    assert.ok(sourceViolations(file, source).length, source);
  }
  assert.deepEqual(sourceViolations(file, '<button>{t("actions.save")}</button>'), []);
});
