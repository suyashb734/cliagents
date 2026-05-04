#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const mapPath = path.join(repoRoot, 'docs', 'CANONICAL-MAP.json');
const indexPath = path.join(repoRoot, 'docs', 'INDEX.md');
const agentsPath = path.join(repoRoot, 'AGENTS.md');

const REQUIRED_ENTRY_FIELDS = [
  'path',
  'status',
  'type',
  'scope',
  'related_code',
  'supersedes',
  'last_reviewed'
];

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function assertRepoPathExists(relativePath, label) {
  const resolved = path.join(repoRoot, relativePath);
  assert(fs.existsSync(resolved), `${label} path does not exist: ${relativePath}`);
}

function run() {
  const map = JSON.parse(readText(mapPath));
  const indexText = readText(indexPath);
  const agentsText = readText(agentsPath);
  const allowedStatuses = new Set(map.allowedStatuses || []);

  assert(Array.isArray(map.entries), 'canonical map must include entries');
  assert(map.entries.length > 0, 'canonical map entries must not be empty');
  assert(allowedStatuses.size > 0, 'canonical map must define allowedStatuses');

  const seenPaths = new Set();
  for (const entry of map.entries) {
    for (const field of REQUIRED_ENTRY_FIELDS) {
      assert(Object.prototype.hasOwnProperty.call(entry, field), `map entry missing ${field}`);
    }

    assert.strictEqual(typeof entry.path, 'string', 'entry.path must be a string');
    assert(!path.isAbsolute(entry.path), `entry.path must be repo-relative: ${entry.path}`);
    assert(!seenPaths.has(entry.path), `duplicate canonical map path: ${entry.path}`);
    seenPaths.add(entry.path);

    assert(allowedStatuses.has(entry.status), `invalid status for ${entry.path}: ${entry.status}`);
    assert(Array.isArray(entry.scope), `entry.scope must be an array for ${entry.path}`);
    assert(Array.isArray(entry.related_code), `entry.related_code must be an array for ${entry.path}`);
    assert(Array.isArray(entry.supersedes), `entry.supersedes must be an array for ${entry.path}`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(entry.last_reviewed), `invalid last_reviewed for ${entry.path}`);

    if (entry.status === 'canonical' || entry.status === 'active-plan') {
      assertRepoPathExists(entry.path, 'canonical or active-plan');
      if (entry.path !== 'docs/INDEX.md') {
        assert(
          indexText.includes(entry.path) || indexText.includes(entry.path.replace(/^docs\//, './')),
          `docs/INDEX.md should link canonical or active-plan path: ${entry.path}`
        );
      }
    }
  }

  assert(indexText.includes('docs/research/'), 'docs/INDEX.md should explain research docs status');
  assert(indexText.includes('CANONICAL-MAP.json'), 'docs/INDEX.md should link the canonical map');
  assert(agentsText.includes('docs/INDEX.md'), 'AGENTS.md should point agents to docs/INDEX.md');
  assert(agentsText.includes('docs/CANONICAL-MAP.json'), 'AGENTS.md should point agents to docs/CANONICAL-MAP.json');

  console.log('✅ Canonical docs map is internally consistent');
}

try {
  run();
} catch (error) {
  console.error('Canonical docs map test failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
