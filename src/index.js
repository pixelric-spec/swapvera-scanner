'use strict';
// Punto de entrada de la GitHub Action. Sin dependencias: usa los ficheros de
// comandos de Actions (GITHUB_OUTPUT, GITHUB_STEP_SUMMARY) y fetch de Node 20.
const fs = require('fs');
const path = require('path');
const { scanDir, groupFindings, shouldFail, renderMarkdown } = require('./scan');

const MARKER = '<!-- swapvera-scan -->';

function input(name, fallback = '') {
  const v = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return v === undefined || v === '' ? fallback : v.trim();
}

function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProp(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function annotate(level, loc, title, message) {
  const props = `file=${escapeProp(loc.file)},line=${loc.line},col=${loc.column},title=${escapeProp(title)}`;
  process.stdout.write(`::${level} ${props}::${escapeData(message)}\n`);
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function gh(method, url, token, body) {
  const res = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'swapvera-scanner',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function upsertIssue(token, repo, groups, body) {
  const open = await gh('GET', `/repos/${repo}/issues?state=open&per_page=100&labels=swapvera`, token).catch(() => []);
  const existing = (open || []).find((i) => (i.body || '').includes(MARKER));
  const urgent = groups.filter((g) => g.severity !== 'notice');
  if (urgent.length === 0) {
    if (existing) {
      await gh('POST', `/repos/${repo}/issues/${existing.number}/comments`, token, { body: 'All deprecated models were removed. Closing.' });
      await gh('PATCH', `/repos/${repo}/issues/${existing.number}`, token, { state: 'closed' });
    }
    return null;
  }
  const retired = urgent.filter((g) => g.status === 'retired').length;
  const upcoming = urgent.filter((g) => g.status !== 'retired');
  const parts = [];
  if (retired) parts.push(`${retired} AI model group(s) already retired`);
  if (upcoming.length) {
    const soonest = Math.min(...upcoming.map((g) => Math.max(g.daysLeft, 0)));
    parts.push(`${upcoming.length} retiring, first in ${soonest} days`);
  }
  const title = `Swapvera: ${parts.join('; ')}`;
  const full = `${MARKER}\n${body}`;
  if (existing) {
    await gh('PATCH', `/repos/${repo}/issues/${existing.number}`, token, { title, body: full });
    return existing.number;
  }
  try {
    const created = await gh('POST', `/repos/${repo}/issues`, token, { title, body: full, labels: ['swapvera'] });
    return created.number;
  } catch (e) {
    const created = await gh('POST', `/repos/${repo}/issues`, token, { title, body: full });
    return created.number;
  }
}

async function main() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'registry.json'), 'utf8'));
  const root = path.resolve(workspace, input('path', '.'));
  const today = input('today', new Date().toISOString().slice(0, 10));
  const warnDays = Number(input('warn-days', '90'));
  const failOn = input('fail-on', 'retired');
  const siteUrl = input('site-url', registry.site_url).replace(/\/$/, '');
  const outFile = input('output-file', 'swapvera-scan.json');
  const ignore = input('ignore', '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  // Nunca escanear nuestro propio informe de la ejecucion anterior.
  ignore.push(path.relative(root, path.resolve(workspace, outFile)).split(path.sep).join('/'));

  const { files, findings } = scanDir(root, registry, { ignore });
  const groups = groupFindings(findings, registry, today, warnDays);

  for (const g of groups) {
    const level = g.severity === 'error' ? 'error' : g.severity === 'warning' ? 'warning' : 'notice';
    const msg = g.status === 'retired'
      ? `${g.entry.name} was retired on ${g.entry.shutdown}; requests to it fail. Replacement: ${g.entry.replacement_name || 'see provider'}.`
      : g.entry.shutdown_kind === 'not_before'
        ? `No shutdown announced for ${g.entry.name}; the provider will not retire it before ${g.entry.shutdown}. Newer model: ${g.entry.replacement_name || 'see provider'}.`
        : `${g.entry.name} shuts down on ${g.entry.shutdown}. Replacement: ${g.entry.replacement_name || 'see provider'}.`;
    const title = g.entry.shutdown_kind === 'not_before' ? `AI model with no shutdown date yet: ${g.ids[0]}` : `Deprecated AI model: ${g.ids[0]}`;
    for (const loc of g.locations.slice(0, 10)) annotate(level, loc, title, msg);
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const md = renderMarkdown(groups, {
    siteUrl, today, sources: registry.sources, sha: process.env.GITHUB_SHA,
    repoUrl: repo ? `${server}/${repo}` : null,
  });
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  process.stdout.write(`Scanned ${files} files, ${findings.length} matches in ${groups.length} model groups.\n`);

  const report = {
    scanned_at: today, files, registry_updated: registry.updated,
    groups: groups.map((g) => ({
      slug: g.slug, name: g.entry.name, ids: g.ids, status: g.status, severity: g.severity,
      days_left: g.daysLeft, shutdown: g.entry.shutdown, replacement: g.entry.replacement,
      locations: g.locations,
    })),
  };
  fs.writeFileSync(path.resolve(workspace, outFile), JSON.stringify(report, null, 2));

  const urgent = groups.filter((g) => g.severity !== 'notice');
  setOutput('found', String(groups.length));
  setOutput('retired', String(groups.filter((g) => g.status === 'retired').length));
  setOutput('soonest-days', urgent.length ? String(Math.min(...urgent.map((g) => g.daysLeft))) : '');
  setOutput('report-file', outFile);

  const token = input('github-token');
  if (input('create-issue', 'true') === 'true' && token && repo) {
    try {
      const n = await upsertIssue(token, repo, groups, md);
      if (n) setOutput('issue-number', String(n));
    } catch (e) {
      process.stdout.write(`::warning::Could not create or update the issue (needs 'issues: write'): ${escapeData(e.message)}\n`);
    }
  }

  if (shouldFail(failOn, groups)) {
    process.stdout.write(`::error::Swapvera failed (fail-on: ${failOn}).\n`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stdout.write(`::error::${escapeData(e.stack || e.message)}\n`);
  process.exitCode = 1;
});
