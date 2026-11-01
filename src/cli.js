#!/usr/bin/env node
'use strict';
// Uso: npx swapvera-scan [ruta] [--fail-on retired|soon|never|days:N] [--json] [--today AAAA-MM-DD]
const fs = require('fs');
const path = require('path');
const { scanDir, groupFindings, shouldFail, statusLabel } = require('./scan');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'registry.json'), 'utf8'));
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));
const root = path.resolve(positional[0] || '.');
const today = arg('today', new Date().toISOString().slice(0, 10));
const failOn = arg('fail-on', 'retired');
const { files, findings } = scanDir(root, registry);
const groups = groupFindings(findings, registry, today, Number(arg('warn-days', '90')));

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ files, groups: groups.map((g) => ({ ...g, entry: undefined, name: g.entry.name, shutdown: g.entry.shutdown, replacement: g.entry.replacement })) }, null, 2) + '\n');
} else {
  process.stdout.write(`Scanned ${files} files in ${root}\n`);
  if (!groups.length) process.stdout.write('No deprecated AI models found.\n');
  for (const g of groups) {
    const mark = g.severity === 'error' ? 'X' : g.severity === 'warning' ? '!' : '-';
    process.stdout.write(`\n[${mark}] ${g.entry.name}: ${statusLabel(g).replace(/\*/g, '')} (shutdown ${g.entry.shutdown})\n`);
    process.stdout.write(`    replacement: ${g.entry.replacement_name || 'see provider'}\n`);
    for (const l of g.locations.slice(0, 5)) process.stdout.write(`    ${l.file}:${l.line}  ${l.token}\n`);
    if (g.locations.length > 5) process.stdout.write(`    ... ${g.locations.length - 5} more\n`);
  }
}
process.exitCode = shouldFail(failOn, groups) ? 1 : 0;
