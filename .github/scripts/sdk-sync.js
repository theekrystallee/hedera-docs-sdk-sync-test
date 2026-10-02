#!/usr/bin/env node
// Syncs the docs with the latest stable release of one hiero-ledger SDK and
// writes a review report used as the body of the automated PR.
//
// Usage:
//   node sdk-sync.js --sdk java [--from 2.76.0] [--report report.md]
//
// State lives in .github/sdk-sync/<sdk>.json: the SDK version the docs were last
// reviewed against, plus the package identity seen at that version. Merging the
// sync PR is what advances it. When a newer stable release exists, this script:
//  1. bumps explicit install pins in the docs to the latest version
//  2. diffs the public Transaction/Query classes and their methods between the
//     two tags (from the source trees, not the changelog), and cross-references
//     every change against the docs
//  3. flags breaking/deprecation notes from every release in between
//  4. flags a package rename upstream, and retired identifiers still in the docs
//  5. writes the new state and the report
//
// Requires Node 22+ (global fetch). Set GH_TOKEN to avoid API rate limits.
// Writes changed/from/to/name to $GITHUB_OUTPUT when running in Actions.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const SOURCES = require('./lib/sdk-sources');

const ROOT = path.resolve(__dirname, '../..');
const STATE_DIR = path.join(ROOT, '.github/sdk-sync');
// Historical changelogs and generated API references are never edited or scanned.
const EXCLUDED_PATHS = new Set(['node_modules', '.git', 'networks/release-notes', 'reference']);
// Non-MDX files that pin an SDK version (the CI harness that runs the docs examples).
const EXTRA_PIN_FILES = ['.github/scripts/java-gradle-bootstrap.sh'];
const STABLE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
// GitHub caps PR bodies at 65,536 characters.
const MAX_REPORT = 60000;

function parseArgs(argv) {
  const parsed = {};

  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];

    if (!key || !key.startsWith('--')) {
      throw new Error(`Invalid argument "${key || ''}". Expected --key value.`);
    }

    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for argument "${key}".`);
    }

    parsed[key.slice(2)] = value;
  }

  return parsed;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function normalize(identifier) {
  return identifier.toLowerCase().replace(/_/g, '');
}

function setOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
}

// ── GitHub ────────────────────────────────────────────────────────────────

async function gh(endpoint) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'hedera-docs-sdk-sync' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;

  const res = await fetch(`https://api.github.com/${endpoint}`, { headers });
  if (!res.ok) throw new Error(`GET ${endpoint} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function rawFile(repo, tag, file) {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${tag}/${file}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Fetching ${repo}@${tag}:${file} failed: ${res.status}`);
  return res.text();
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// Stable releases only (no drafts, prereleases, or suffixed tags), oldest first.
async function stableReleases(repo) {
  const releases = [];

  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`repos/${repo}/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) break;
  }

  return releases
    .filter(r => !r.draft && !r.prerelease && STABLE_TAG.test(r.tag_name))
    .map(r => ({
      tag: r.tag_name,
      version: r.tag_name.replace(/^v/, ''),
      url: r.html_url,
      date: (r.published_at || '').slice(0, 10),
      body: r.body || '',
    }))
    .sort((a, b) => compareVersions(a.version, b.version));
}

// ── API surface diff ──────────────────────────────────────────────────────

async function classInventory(sdk, tag) {
  const tree = await gh(`repos/${sdk.repo}/git/trees/${encodeURIComponent(tag)}?recursive=1`);
  const classes = new Map();

  for (const entry of tree.tree) {
    if (entry.type !== 'blob') continue;
    const match = entry.path.match(sdk.classFile);
    if (!match) continue;
    const name = sdk.className ? sdk.className(match[1]) : match[1];
    classes.set(name, { path: entry.path, sha: entry.sha });
  }

  return { classes, truncated: tree.truncated };
}

async function diffApi(sdk, fromTag, toTag, warnings) {
  const [before, after] = await Promise.all([classInventory(sdk, fromTag), classInventory(sdk, toTag)]);

  if (before.truncated || after.truncated) {
    warnings.push('The upstream source tree listing was truncated, so the class diff may be incomplete.');
  }
  if (after.classes.size === 0) {
    warnings.push(
      `No Transaction/Query source files matched at ${toTag}. The SDK layout may have changed; ` +
        'update `classFile` in `.github/scripts/lib/sdk-sources.js`.'
    );
  }

  const added = [...after.classes.keys()].filter(name => !before.classes.has(name)).sort();
  const removed = [...before.classes.keys()].filter(name => !after.classes.has(name)).sort();
  // Same class, different blob: the only files worth downloading.
  const modified = [...after.classes.keys()].filter(
    name => before.classes.has(name) && before.classes.get(name).sha !== after.classes.get(name).sha
  );

  const methodChanges = (
    await mapLimit(modified, 8, async name => {
      const [oldSource, newSource] = await Promise.all([
        rawFile(sdk.repo, fromTag, before.classes.get(name).path),
        rawFile(sdk.repo, toTag, after.classes.get(name).path),
      ]);
      if (oldSource === null || newSource === null) return null;

      const oldMethods = sdk.methods(oldSource, name);
      const newMethods = sdk.methods(newSource, name);
      const addedMethods = [...newMethods].filter(m => !oldMethods.has(m)).sort();
      const removedMethods = [...oldMethods].filter(m => !newMethods.has(m)).sort();
      if (addedMethods.length === 0 && removedMethods.length === 0) return null;

      return { name, path: after.classes.get(name).path, added: addedMethods, removed: removedMethods };
    })
  )
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    added: added.map(name => ({ name, path: after.classes.get(name).path })),
    removed: removed.map(name => ({ name, path: before.classes.get(name).path })),
    modifiedCount: modified.length,
    methodChanges,
  };
}

// ── Docs index ────────────────────────────────────────────────────────────

function listFiles(dir = ROOT, rel = '') {
  const files = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (EXCLUDED_PATHS.has(relPath) || entry.name.startsWith('.')) continue;

    if (entry.isDirectory()) {
      files.push(...listFiles(path.join(dir, entry.name), relPath));
    } else if (entry.name.endsWith('.mdx')) {
      files.push(relPath);
    }
  }

  return files;
}

function identifierCounts(text) {
  const counts = new Map();
  for (const [token] of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const key = normalize(token);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// page -> { text, tokens, headingTokens, isReference }
function buildDocsIndex(pages) {
  const index = new Map();

  for (const page of pages) {
    const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const headings = text.match(/^#{1,4}\s.*$/gm) || [];
    index.set(page, {
      text,
      tokens: identifierCounts(text),
      headingTokens: identifierCounts(headings.join('\n')),
      // SDK reference pages carry a Constructor/Methods table; tutorials do not.
      isReference: headings.some(h => /^#+\s+(Methods|Constructor)\b/.test(h)),
    });
  }

  return index;
}

// Pages mentioning an identifier, likely reference page first: a heading naming the
// class beats a method table, which beats living under native/, which beats raw mentions.
function pagesMentioning(index, identifier) {
  const key = normalize(identifier);
  const score = (name, page) =>
    (page.headingTokens.has(key) ? 400 : 0) +
    (page.isReference ? 200 : 0) +
    (name.startsWith('native/') && !name.startsWith('native/tutorials/') ? 100 : 0) +
    Math.min(page.tokens.get(key), 99);

  return [...index.entries()]
    .filter(([, page]) => page.tokens.has(key))
    .sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]))
    .map(([name]) => name);
}

// Method names differ by SDK (setTokenName, SetTokenName, set_token_name, tokenName),
// so a method counts as documented if any accessor-style variant appears on the page.
function methodDocumented(index, pages, method) {
  const base = normalize(method).replace(/^(set|get)(?=.)/, '');
  const variants = [normalize(method), base, `set${base}`, `get${base}`];
  return pages.some(page => variants.some(v => index.get(page).tokens.has(v)));
}

// ── Pins, release notes, identity ─────────────────────────────────────────

function bumpPins(sdk, latest, files) {
  const changes = [];

  for (const file of files) {
    const pins = sdk.pins.filter(pin => pin.file.test(file));
    if (pins.length === 0) continue;

    const abs = path.join(ROOT, file);
    const original = fs.readFileSync(abs, 'utf8');
    const previous = new Set();
    let count = 0;
    let updated = original;

    for (const pin of pins) {
      updated = updated.replace(pin.regex, (match, prefix, version) => {
        if (compareVersions(version, latest) >= 0) return match;
        previous.add(version);
        count++;
        return prefix + latest;
      });
    }

    if (updated !== original) {
      fs.writeFileSync(abs, updated, 'utf8');
      changes.push({ file, previous: [...previous], count });
    }
  }

  return changes;
}

// Release-note lines a reviewer must not miss: anything under a "Breaking" or
// "Deprecat..." heading, plus any line calling out a breaking change or deprecation.
function releaseNoteFlags(release, repo) {
  const flags = [];
  let flaggedSection = false;

  for (const line of release.body.split(/\r?\n/)) {
    const heading = line.match(/^#+\s+(.*)$/);
    if (heading) {
      flaggedSection = /breaking|deprecat|removed/i.test(heading[1]);
      continue;
    }

    const text = line.replace(/^\s*[-*]\s+/, '').trim();
    if (!text || /^```/.test(text)) continue;

    const isBullet = /^\s*[-*]\s+/.test(line);
    const callsOut = /\bbreaking\b|\bdeprecat|^\w+(\([^)]*\))?!:/i.test(text);

    if ((flaggedSection && isBullet) || callsOut) {
      flags.push(neutralize(text.length > 400 ? `${text.slice(0, 400)}…` : text, repo));
    }
  }

  return flags;
}

// Keep upstream release text from pinging people or auto-linking to this repo's issues.
function neutralize(text, repo) {
  return text
    .replace(/(^|[^\w`/])@([A-Za-z0-9][\w-]*)/g, '$1@\u200b$2')
    .replace(/(^|[\s(])#(\d+)\b/g, `$1[#$2](https://github.com/${repo}/issues/$2)`);
}

async function upstreamIdentity(sdk, tag) {
  const text = await rawFile(sdk.repo, tag, sdk.identity.file);
  if (text === null) return null;
  try {
    return sdk.identity.parse(text) || null;
  } catch {
    return null;
  }
}

function legacyUsage(sdk, index) {
  return sdk.legacy
    .map(({ find, use }) => ({
      find,
      use,
      pages: [...index.entries()].filter(([, page]) => page.text.includes(find)).map(([page]) => page),
    }))
    .filter(entry => entry.pages.length > 0);
}

// ── Report ────────────────────────────────────────────────────────────────

const code = value => `\`${value}\``;
const pageList = pages => pages.map(code).join(', ');

function buildReport(ctx) {
  const { sdk, key, from, latest, releases, pins, api, flags, identity, legacy, index, warnings } = ctx;
  const repoUrl = `https://github.com/${sdk.repo}`;
  const src = (tag, file) => `${repoUrl}/blob/${tag}/${file}`;
  const out = [];

  out.push(`## ${sdk.name} docs sync: v${from.version} → v${latest.version}`, '');
  out.push(
    `Source of truth: [${sdk.repo}](${repoUrl}) · ` +
      `[Compare ${from.tag}...${latest.tag}](${repoUrl}/compare/${from.tag}...${latest.tag})`,
    ''
  );

  if (releases.length > 0) {
    out.push(`**Releases covered:** ${releases.map(r => `[${r.tag}](${r.url}) (${r.date})`).join(', ')}`, '');
  }

  for (const warning of warnings) out.push(`> [!WARNING]`, `> ${warning}`, '');

  if (identity.renamed) {
    out.push(
      '> [!CAUTION]',
      `> **Package renamed upstream:** ${code(identity.previous)} → ${code(identity.current)} ` +
        `(read from ${code(sdk.identity.file)}). Update install instructions, imports, and pins across the docs, ` +
        'then add the new coordinates to `pins` and the old ones to `legacy` in `.github/scripts/lib/sdk-sources.js`.',
      ''
    );
  }

  const undocumentedClasses = api ? api.added.filter(c => pagesMentioning(index, c.name).length === 0) : [];
  const methodGaps = api ? api.methodChanges.length : 0;

  out.push('### Summary', '', '| Check | Result |', '| --- | --- |');
  out.push(
    `| Install pins bumped to v${latest.version} | ${
      pins.length ? `${pins.reduce((n, p) => n + p.count, 0)} in ${pins.length} file(s)` : 'none needed'
    } |`
  );
  if (api) {
    out.push(`| New Transaction/Query classes | ${api.added.length} (${undocumentedClasses.length} not in docs) |`);
    out.push(`| Removed classes | ${api.removed.length} |`);
    out.push(`| Classes with public method changes | ${methodGaps} (of ${api.modifiedCount} modified files) |`);
  }
  out.push(`| Breaking/deprecation notes in releases | ${flags.reduce((n, f) => n + f.lines.length, 0)} |`);
  out.push(`| Retired identifiers still in docs | ${legacy.length ? legacy.map(l => code(l.find)).join(', ') : 'none'} |`);
  out.push('');

  if (pins.length > 0) {
    out.push('### Install pins updated (automated)', '');
    for (const pin of pins) {
      out.push(`- ${code(pin.file)}: ${pin.previous.join(', ')} → ${latest.version} (${pin.count})`);
    }
    out.push('');
  }

  if (flags.length > 0) {
    out.push('### Breaking changes and deprecations (from release notes)', '');
    for (const flag of flags) {
      out.push(`**[${flag.tag}](${flag.url})**`, '');
      for (const line of flag.lines) out.push(`- [ ] ${line}`);
      out.push('');
    }
  }

  if (api && (api.added.length || api.removed.length || api.methodChanges.length)) {
    out.push(`### API surface changes (${from.tag} → ${latest.tag})`, '');
    out.push('_Diffed from the SDK source trees. Each item needs a reviewer decision: document it, or tick it as not needed._', '');

    if (api.added.length > 0) {
      out.push('#### New classes', '');
      for (const cls of api.added) {
        const pages = pagesMentioning(index, cls.name);
        out.push(
          `- [ ] [${code(cls.name)}](${src(latest.tag, cls.path)}): ` +
            (pages.length ? `mentioned in ${pageList(pages.slice(0, 5))}` : '**not mentioned anywhere in the docs**')
        );
      }
      out.push('');
    }

    if (api.removed.length > 0) {
      out.push('#### Removed classes', '');
      for (const cls of api.removed) {
        const pages = pagesMentioning(index, cls.name);
        out.push(
          `- [ ] ${code(cls.name)}: ` +
            (pages.length ? `**still referenced in** ${pageList(pages)}` : 'not referenced in the docs')
        );
      }
      out.push('');
    }

    if (api.methodChanges.length > 0) {
      out.push('#### Method changes', '');
      for (const change of api.methodChanges) {
        const pages = pagesMentioning(index, change.name);
        out.push(
          `- [ ] [${code(change.name)}](${src(latest.tag, change.path)}) ` +
            (pages.length ? `(reference page: ${code(pages[0])})` : '(class not in docs)')
        );
        if (change.added.length) {
          const items = change.added.map(m =>
            pages.length && methodDocumented(index, pages, m) ? code(m) : `${code(m)} **(not in docs)**`
          );
          out.push(`  - Added: ${items.join(', ')}`);
        }
        if (change.removed.length) {
          const items = change.removed.map(m =>
            pages.length && methodDocumented(index, pages, m) ? `${code(m)} **(still in docs)**` : code(m)
          );
          out.push(`  - Removed: ${items.join(', ')}`);
        }
      }
      out.push('');
    }
  }

  if (legacy.length > 0) {
    out.push('### Retired identifiers still in the docs (not auto-fixed)', '');
    out.push('_Some mentions may be intentional (migration notes). Fix the rest here or in a follow-up._', '');
    for (const entry of legacy) {
      out.push(`- ${code(entry.find)} → ${code(entry.use)}: ${pageList(entry.pages)}`);
    }
    out.push('');
  }

  out.push(
    '### Review checklist',
    '',
    `- [ ] Read the [release notes](${repoUrl}/releases) for every release covered above`,
    '- [ ] Resolve each API and breaking-change item above (push doc fixes to this branch)',
    '- [ ] Update code examples whose APIs changed, and keep the EVM-address terminology rules in `CLAUDE.md`',
    '- [ ] Run `mint broken-links` locally',
    '',
    `Merging this PR records v${latest.version} as the reviewed ${sdk.name} version in ${code(
      `.github/sdk-sync/${key}.json`
    )}.`
  );

  return out.join('\n') + '\n';
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const key = args.sdk;
  const sdk = SOURCES[key];

  if (!sdk) {
    throw new Error(`Usage: node sdk-sync.js --sdk <${Object.keys(SOURCES).join('|')}> [--from X.Y.Z] [--report file]`);
  }

  const statePath = path.join(STATE_DIR, `${key}.json`);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const fromVersion = (args.from || state.version).replace(/^v/, '');

  if (!STABLE_TAG.test(fromVersion)) {
    throw new Error(`Invalid baseline version "${fromVersion}". Expected X.Y.Z.`);
  }

  const releases = await stableReleases(sdk.repo);
  if (releases.length === 0) throw new Error(`No stable releases found for ${sdk.repo}.`);

  const latest = releases[releases.length - 1];
  const from = releases.find(r => r.version === fromVersion) || { version: fromVersion, tag: `v${fromVersion}` };
  const hasNewRelease = compareVersions(latest.version, from.version) > 0;
  const covered = releases.filter(
    r => compareVersions(r.version, from.version) > 0 && compareVersions(r.version, latest.version) <= 0
  );

  const pages = listFiles();
  const pins = bumpPins(sdk, latest.version, [...pages, ...EXTRA_PIN_FILES]);

  const current = await upstreamIdentity(sdk, latest.tag);
  const identity = {
    previous: state.package,
    current: current || state.package,
    renamed: Boolean(current && state.package && current !== state.package),
  };

  if (!hasNewRelease && pins.length === 0 && !identity.renamed) {
    console.log(`${sdk.name}: docs are in sync with v${latest.version}. Nothing to do.`);
    setOutput({ changed: 'false' });
    return;
  }

  const warnings = [];
  if (!current) {
    warnings.push(`Could not read the package name from ${code(sdk.identity.file)} at ${latest.tag}.`);
  }

  const api = hasNewRelease ? await diffApi(sdk, from.tag, latest.tag, warnings) : null;
  const flags = covered
    .map(release => ({ tag: release.tag, url: release.url, lines: releaseNoteFlags(release, sdk.repo) }))
    .filter(flag => flag.lines.length > 0)
    .reverse();
  // Index after bumping pins so the report reflects the updated pages.
  const index = buildDocsIndex(pages);
  const legacy = legacyUsage(sdk, index);

  const report = buildReport({ sdk, key, from, latest, releases: covered, pins, api, flags, identity, legacy, index, warnings });
  const reportPath = args.report || path.join(process.env.RUNNER_TEMP || os.tmpdir(), `sdk-sync-${key}.md`);
  const bodyPath = reportPath.replace(/(\.md)?$/, '.body.md');
  fs.writeFileSync(reportPath, report, 'utf8');
  fs.writeFileSync(
    bodyPath,
    report.length > MAX_REPORT
      ? report.slice(0, MAX_REPORT) +
          '\n\n_Report truncated. The full report is attached to the workflow run as an artifact._\n'
      : report,
    'utf8'
  );

  if (!args.from || compareVersions(latest.version, state.version) > 0) {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ ...state, version: latest.version, package: identity.current }, null, 2) + '\n',
      'utf8'
    );
  }

  console.log(
    `${sdk.name}: v${from.version} → v${latest.version}. ` +
      `${pins.length} pinned file(s) updated` +
      (api
        ? `, ${api.added.length} new / ${api.removed.length} removed classes, ${api.methodChanges.length} with method changes`
        : '') +
      `. Report: ${reportPath}`
  );

  setOutput({
    changed: 'true',
    name: sdk.name,
    from: from.version,
    to: latest.version,
    report: reportPath,
    body: bodyPath,
  });
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
