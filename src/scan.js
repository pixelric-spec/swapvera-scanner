'use strict';
// Nucleo del escaner: sin dependencias, funciones puras salvo walk/readFile.
const fs = require('fs');
const path = require('path');

const DEFAULT_EXTENSIONS = new Set([
  '.py', '.ipynb', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.go', '.rb', '.java', '.kt',
  '.cs', '.php', '.rs', '.swift', '.scala', '.ex', '.exs', '.yaml', '.yml', '.json', '.toml',
  '.ini', '.cfg', '.env', '.tf', '.sh', '.sql',
]);
const DEFAULT_FILENAMES = new Set(['.env', '.env.example', '.env.local', '.env.production', 'Dockerfile']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'vendor', 'venv', '.venv', 'env',
  '__pycache__', '.mypy_cache', '.pytest_cache', 'coverage', 'target', '.terraform', '.tox',
]);
const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Cargo.lock', 'uv.lock',
  'swapvera-scan.json', 'swapvera-report.json',
]);
const MAX_FILE_BYTES = 1024 * 1024;
const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9._-]*/g;
// Sufijos de instantanea: -2024-05-13, -20250929, -0613, -001
const SNAPSHOT_RE = /-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4}|\d{3})$/;
const QUOTES = new Set(['"', "'", '`']);
const DAY_MS = 86400000;

function buildIndex(registry) {
  const index = new Map();
  for (const entry of registry.entries) {
    for (const id of entry.ids) {
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(entry);
    }
  }
  const endpoints = (registry.endpoints || []).map((e) => ({
    entry: e,
    regexes: e.patterns.map((p) => new RegExp(p)),
  }));
  return { index, endpoints };
}

/** Quita prefijos y sufijos de plataforma (Bedrock: us.anthropic.claude-...-v1). */
function normalizeToken(token) {
  let id = token;
  let platform = null;
  const regional = id.match(/^(us|eu|apac|global|jp|au)\.(.+)$/);
  if (regional) id = regional[2];
  if (id.startsWith('anthropic.')) {
    id = id.slice('anthropic.'.length);
    platform = 'bedrock';
    id = id.replace(/-v\d+$/, '');
  }
  if (id.startsWith('models.')) id = id.slice('models.'.length);
  id = id.replace(/\.+$/, '');
  return { id, platform };
}

function candidateIds(id) {
  const out = [id];
  const stripped = id.replace(SNAPSHOT_RE, '');
  if (stripped !== id) out.push(stripped);
  return out;
}

function fileHints(text) {
  const hints = new Set();
  if (/bedrock|anthropic\.claude/i.test(text)) hints.add('bedrock');
  if (/vertexai|vertex_ai|aiplatform|google-cloud\/vertexai|VertexAI|vertex-ai/i.test(text)) hints.add('vertex-ai');
  return hints;
}

/** Elige la entrada que aplica a este fichero cuando un id tiene fechas por plataforma. */
function chooseEntry(entries, hints) {
  const byPlatform = (p) => entries.find((e) => e.platform === p);
  if (hints.has('bedrock') && byPlatform('bedrock')) return { entry: byPlatform('bedrock'), uncertain: false };
  if (hints.has('vertex-ai') && byPlatform('vertex-ai')) return { entry: byPlatform('vertex-ai'), uncertain: false };
  const firstParty = entries.find((e) => e.platform !== 'bedrock' && e.platform !== 'vertex-ai');
  if (firstParty) return { entry: firstParty, uncertain: false };
  // Solo hay fecha en una plataforma que el fichero no menciona.
  return { entry: entries[0], uncertain: true };
}

function isQuoted(line, start, end) {
  return QUOTES.has(line[start - 1]) && QUOTES.has(line[end]);
}

function scanText(text, file, compiled) {
  const findings = [];
  const hints = fileHints(text);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.length > 2000) return; // lineas minificadas
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(line)) !== null) {
      const token = m[0];
      if (token.length < 2 || token.length > 90) continue;
      const norm = normalizeToken(token);
      for (const cand of candidateIds(norm.id)) {
        const entries = compiled.index.get(cand);
        if (!entries) continue;
        const localHints = new Set(hints);
        if (norm.platform) localHints.add(norm.platform);
        const { entry, uncertain } = chooseEntry(entries, localHints);
        if ((entry.ambiguous_ids || []).includes(cand) && !isQuoted(line, m.index, m.index + token.length)) break;
        findings.push({ file, line: i + 1, column: m.index + 1, token, id: cand, slug: entry.slug, uncertain, kind: 'model' });
        break;
      }
    }
    for (const ep of compiled.endpoints) {
      for (const re of ep.regexes) {
        const em = line.match(re);
        if (em) {
          findings.push({ file, line: i + 1, column: (em.index || 0) + 1, token: em[0], id: ep.entry.name, slug: ep.entry.slug, uncertain: false, kind: 'endpoint' });
          break;
        }
      }
    }
  });
  return findings;
}

function shouldScanFile(name) {
  if (SKIP_FILES.has(name)) return false;
  if (DEFAULT_FILENAMES.has(name) || name.startsWith('.env')) return true;
  return DEFAULT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function* walk(dir, root, ignore) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    const full = path.join(dir, item.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (ignore.some((p) => rel === p || rel.startsWith(p.replace(/\/$/, '') + '/'))) continue;
    if (item.isDirectory()) {
      if (SKIP_DIRS.has(item.name)) continue;
      yield* walk(full, root, ignore);
    } else if (item.isFile() && shouldScanFile(item.name)) {
      yield { full, rel };
    }
  }
}

function scanDir(root, registry, options = {}) {
  const compiled = buildIndex(registry);
  const ignore = options.ignore || [];
  const findings = [];
  let files = 0;
  for (const { full, rel } of walk(root, root, ignore)) {
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (text.includes('\u0000')) continue; // binario
    files += 1;
    findings.push(...scanText(text, rel, compiled));
  }
  return { files, findings };
}

function parseDate(s) {
  return Date.parse(`${s}T00:00:00Z`);
}

function evaluate(entry, today, warnDays, uncertain) {
  const days = Math.round((parseDate(entry.shutdown) - parseDate(today)) / DAY_MS);
  let status;
  let severity;
  if (entry.shutdown_kind === 'not_before') {
    // Sin retirada anunciada: el proveedor solo promete no retirarlo antes de esa fecha, y avisa antes
    status = days < 0 ? 'may_retire_anytime' : 'tentative';
    severity = 'notice';
  } else if (days < 0) {
    status = 'retired';
    severity = 'error';
  } else if (days <= warnDays) {
    status = 'retiring_soon';
    severity = 'warning';
  } else {
    status = 'scheduled';
    severity = 'notice';
  }
  if (uncertain) severity = 'notice';
  return { status, severity, daysLeft: days };
}

const SEVERITY_RANK = { error: 3, warning: 2, notice: 1 };

function groupFindings(findings, registry, today, warnDays = 90) {
  const bySlug = new Map();
  const all = [...registry.entries, ...(registry.endpoints || [])];
  for (const f of findings) {
    if (!bySlug.has(f.slug)) {
      const entry = all.find((e) => e.slug === f.slug);
      bySlug.set(f.slug, { entry, locations: [], tokens: new Set(), uncertain: true });
    }
    const g = bySlug.get(f.slug);
    g.locations.push({ file: f.file, line: f.line, column: f.column, token: f.token });
    g.tokens.add(f.id);
    g.uncertain = g.uncertain && f.uncertain;
  }
  const groups = [];
  for (const [slug, g] of bySlug) {
    const ev = evaluate(g.entry, today, warnDays, g.uncertain);
    groups.push({ slug, entry: g.entry, ids: [...g.tokens].sort(), locations: g.locations, uncertain: g.uncertain, ...ev });
  }
  groups.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.daysLeft - b.daysLeft);
  return groups;
}

function shouldFail(failOn, groups) {
  const v = String(failOn || 'retired').trim();
  if (v === 'never') return false;
  if (v === 'retired') return groups.some((g) => g.status === 'retired');
  if (v === 'soon') return groups.some((g) => g.severity === 'error' || g.status === 'retiring_soon');
  const days = v.match(/^days:(\d+)$/);
  if (days) {
    const n = Number(days[1]);
    return groups.some((g) => g.status === 'retired' || (g.entry.shutdown_kind === 'exact' && g.daysLeft <= n));
  }
  throw new Error(`fail-on invalido: ${v} (usa retired, soon, never o days:N)`);
}

function statusLabel(g) {
  switch (g.status) {
    case 'retired': return `**Retired** ${-g.daysLeft} days ago, requests fail`;
    case 'retiring_soon': return `**${g.daysLeft} days left**`;
    case 'scheduled': return `${g.daysLeft} days left`;
    case 'tentative': return `No shutdown announced; not before ${g.entry.shutdown}`;
    case 'may_retire_anytime': return 'No shutdown announced; the provider may announce one';
    default: return g.status;
  }
}

function migrationUrl(siteUrl, g, source) {
  if (g.entry.seo_page === false || !g.entry.replacement) return `${siteUrl}/?utm_source=${source}`;
  return `${siteUrl}/migrate/${g.slug}/?utm_source=${source}`;
}

function renderMarkdown(groups, opts) {
  const { siteUrl, repoUrl, sha, source = 'scanner', today } = opts;
  if (groups.length === 0) {
    return `### Swapvera: no deprecated AI models found\n\nScanned on ${today}. No model IDs in this repository have an announced retirement date.\n`;
  }
  const lines = [];
  const urgent = groups.filter((g) => g.severity !== 'notice').length;
  lines.push(`### Swapvera: ${urgent} of ${groups.length} model groups need attention`);
  lines.push('');
  lines.push(`Scanned on ${today}. Retirement dates come from provider announcements; each row links its source.`);
  lines.push('');
  lines.push('| Model | Status | Shutdown | Replacement | Found in |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const g of groups) {
    const loc = g.locations.slice(0, 3).map((l) => {
      const label = `${l.file}:${l.line}`;
      return repoUrl && sha ? `[${label}](${repoUrl}/blob/${sha}/${l.file}#L${l.line})` : `\`${label}\``;
    });
    if (g.locations.length > 3) loc.push(`+${g.locations.length - 3} more`);
    const repl = g.entry.replacement_name || '-';
    const date = `${g.entry.shutdown_kind === 'not_before' ? 'not before ' : ''}${g.entry.shutdown}${g.entry.platform && g.entry.platform !== 'anthropic-api' && g.entry.platform !== 'openai-api' && g.entry.platform !== 'gemini-api' ? ` (${g.entry.platform})` : ''}`;
    lines.push(`| ${g.entry.name}<br>\`${g.ids.join('`, `')}\` | ${statusLabel(g)}${g.uncertain ? ' (date applies to another platform)' : ''} | ${date} | ${repl} | ${loc.join('<br>')} |`);
  }
  lines.push('');
  const migratable = groups.filter((g) => g.severity !== 'notice' && g.entry.replacement);
  if (migratable.length) {
    lines.push('**Is the replacement safe for your app?** Swapping the model ID is a one-line change; knowing whether answers got worse is not. Swapvera runs your prompts on both models and gives a statistical verdict.');
    lines.push('');
    for (const g of migratable.slice(0, 5)) {
      lines.push(`- [Check ${g.ids[0]} -> ${g.entry.replacement}](${migrationUrl(siteUrl, g, source)})`);
    }
    lines.push('');
  }
  const srcs = [...new Set(groups.map((g) => g.entry.source))];
  lines.push(`<sub>Sources: ${srcs.map((s) => `[${s}](${(opts.sources || {})[s] || '#'})`).join(' · ')}. Report a wrong date by opening an issue.</sub>`);
  return lines.join('\n') + '\n';
}

module.exports = {
  buildIndex, normalizeToken, candidateIds, fileHints, chooseEntry, scanText, scanDir,
  evaluate, groupFindings, shouldFail, renderMarkdown, statusLabel, migrationUrl,
};
