'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scan = require('../src/scan');

const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'registry.json'), 'utf8'));
const compiled = scan.buildIndex(registry);
const TODAY = '2026-11-01';

function find(text, file = 'app.py') {
  return scan.scanText(text, file, compiled);
}

test('detects exact ids and snapshot variants', () => {
  const f = find('client.messages.create(model="claude-sonnet-4-5-20250929")\nm = "gpt-4o-2024-08-06"');
  assert.deepStrictEqual(f.map((x) => x.id), ['claude-sonnet-4-5', 'gpt-4o']);
  assert.strictEqual(f[0].slug, 'claude-sonnet-4-5-to-claude-sonnet-5-5');
});

test('a specific snapshot wins over the family', () => {
  const f = find('model: gpt-4o-2024-05-13');
  assert.strictEqual(f[0].slug, 'gpt-4-gpt-3-5-o1-o3-mini-o4-mini-retired');
});

test('does not confuse related ids', () => {
  assert.deepStrictEqual(find('use gpt-4o-mini and gpt-5.6-luna and claude-sonnet-5-5').map((x) => x.id), ['gpt-4o-mini']);
  assert.strictEqual(find('gpt-4.1-mini').at(0).id, 'gpt-4.1-mini');
});

test('ambiguous short ids need quotes', () => {
  assert.strictEqual(find('let o1 = vec.o1; // o3 here').length, 0);
  assert.strictEqual(find('model = "o3"').at(0).id, 'o3');
  assert.strictEqual(find("model: 'o1'").at(0).id, 'o1');
});

test('bedrock ids use bedrock dates', () => {
  const f = find('modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0"', 'infra.ts');
  assert.strictEqual(f[0].slug, 'claude-sonnet-4-5-bedrock');
});

test('vertex-only dates are uncertain without vertex hints', () => {
  const plain = find('model = "gemini-2.5-flash"');
  assert.strictEqual(plain[0].uncertain, true);
  const vertex = find('import vertexai\nmodel = "gemini-2.5-flash"');
  assert.strictEqual(vertex[0].uncertain, false);
});

test('endpoint patterns are detected', () => {
  const f = find('const a = await openai.beta.assistants.create({})', 'a.ts');
  assert.strictEqual(f[0].slug, 'openai-assistants-api-retired');
});

test('evaluate statuses', () => {
  const e = (shutdown, kind = 'exact') => ({ shutdown, shutdown_kind: kind });
  assert.strictEqual(scan.evaluate(e('2026-10-23'), TODAY, 90, false).status, 'retired');
  assert.strictEqual(scan.evaluate(e('2026-11-30'), TODAY, 90, false).daysLeft, 29);
  assert.strictEqual(scan.evaluate(e('2026-11-30'), TODAY, 90, false).severity, 'warning');
  assert.strictEqual(scan.evaluate(e('2027-04-01'), TODAY, 90, false).severity, 'notice');
  assert.strictEqual(scan.evaluate(e('2026-10-15', 'not_before'), TODAY, 90, false).status, 'may_retire_anytime');
  assert.strictEqual(scan.evaluate(e('2026-10-23'), TODAY, 90, true).severity, 'notice');
});

test('scanDir walks files, skips node_modules and lockfiles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'llm.ts'), 'const MODEL = "gpt-5-mini";\n');
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), 'gpt-4');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '"gpt-4"');
  fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_MODEL=gpt-4o\n');
  const { files, findings } = scan.scanDir(dir, registry);
  assert.strictEqual(files, 2);
  const groups = scan.groupFindings(findings, registry, TODAY, 90);
  assert.deepStrictEqual(groups.map((g) => g.slug).sort(), ['gpt-4o-and-gpt-4-1-to-gpt-6-luna', 'gpt-5-mini-to-gpt-5-6-terra']);
  const g5 = groups.find((g) => g.slug === 'gpt-5-mini-to-gpt-5-6-terra');
  assert.strictEqual(g5.daysLeft, 40);
});

test('shouldFail modes', () => {
  const g = (status, daysLeft, severity) => ({ status, daysLeft, severity, entry: { shutdown_kind: 'exact' } });
  const soon = [g('retiring_soon', 29, 'warning')];
  assert.strictEqual(scan.shouldFail('retired', soon), false);
  assert.strictEqual(scan.shouldFail('soon', soon), true);
  assert.strictEqual(scan.shouldFail('days:30', soon), true);
  assert.strictEqual(scan.shouldFail('days:7', soon), false);
  assert.strictEqual(scan.shouldFail('never', [g('retired', -5, 'error')]), false);
  assert.throws(() => scan.shouldFail('bogus', soon));
});

test('markdown links to migration page with utm', () => {
  const findings = find('model="claude-sonnet-4-5"');
  const groups = scan.groupFindings(findings, registry, TODAY, 90);
  const md = scan.renderMarkdown(groups, { siteUrl: 'https://x.test', today: TODAY, sources: registry.sources });
  assert.match(md, /29 days left/);
  assert.match(md, /https:\/\/x\.test\/migrate\/claude-sonnet-4-5-to-claude-sonnet-5-5\/\?utm_source=scanner/);
});

test('every registry entry has dates in ISO format', () => {
  for (const e of [...registry.entries, ...registry.endpoints]) {
    assert.match(e.shutdown, /^\d{4}-\d{2}-\d{2}$/, e.slug);
    assert.ok(registry.sources[e.source], e.slug);
  }
});
