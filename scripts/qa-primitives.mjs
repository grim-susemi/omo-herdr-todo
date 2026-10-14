#!/usr/bin/env node
// Standalone lease-primitive QA runner (task-1 lease lane, test infrastructure).
//
// Runs every real-multiprocess SQLite lease case from
// test/restart/primitive-fixtures.mjs against real child processes and the
// built-in node:sqlite DatabaseSync, and records machine receipts into an
// evidence directory:
//   receipts/<case>.json, result.json, resources.json, cleanup.json, STATUS.md
//
// Usage:
//   node scripts/qa-primitives.mjs --evidence-dir <dir>

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sqliteReal from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import {
  ALL_CASES,
  childResources,
  cleanupOwnedDirs,
  fixtureTempDirs,
  nativeOperations,
  ownedTempDirs,
} from '../test/restart/primitive-fixtures.mjs';

const { DatabaseSync } = sqliteReal;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--')) throw new Error(`unexpected arg: ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  if (!out['evidence-dir']) throw new Error('--evidence-dir is required');
  return out;
}

const args = parseArgs(process.argv);
const evidenceDir = path.resolve(args['evidence-dir']);
// Emit the full receipt packet without creating files when evidence must be
// materialized by apply_patch. Normal CLI mode retains its per-case files.
const emitOnly = args['emit-only'] === 'true';
const artifacts = {};
function writeJson(file, value) {
  artifacts[path.relative(evidenceDir, file).replaceAll('\\', '/')] = value;
  if (!emitOnly) writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
if (!emitOnly) mkdirSync(path.join(evidenceDir, 'receipts'), { recursive: true });

const statusFile = path.join(evidenceDir, 'STATUS.md');
const statusLines = [];
function status(line) {
  statusLines.push(`- ${new Date().toISOString()} ${line}`);
  if (!emitOnly) appendFileSync(statusFile, `${statusLines[statusLines.length - 1]}\n`);
}

if (!emitOnly && !existsSync(statusFile)) {
  writeFileSync(statusFile, `# task-1 lease primitives STATUS\n\n`);
}
status(`qa-primitives start node=${process.version} pid=${process.pid}`);

// Resources spawned by this run are registered before triggering each case
// and closed by exact identity after receipts are captured.
const resources = [];
const tempDirs = [];
const results = [];
let allOk = true;

for (const [name, runCase] of Object.entries(ALL_CASES)) {
  status(`case ${name} running`);
  let receipt;
  try {
    receipt = await runCase({});
    tempDirs.push(...ownedTempDirs(receipt));
    resources.push({
      case: name,
      identityAuthority: receipt.identityAuthority ?? null,
      dbPath: receipt.dbPath,
      osIdentities: {
        holder: receipt.holder?.os ?? receipt.first?.os ?? null,
        killed: receipt.killed?.os ?? null,
        successor: receipt.successor?.os ?? null,
        termination: receipt.termination ?? null,
        postSnapshot: receipt.postSnapshot ?? null,
        rejections: receipt.rejections ?? null,
      },
      spawnedChildPids: (receipt.exits ? Object.entries(receipt.exits).map(([k, v]) => ({ slot: k, exitCode: v.code, signal: v.signal ?? null })) : []),
      killed: receipt.killed?.identity ?? receipt.killed ?? null,
      holder: receipt.holder?.identity ?? receipt.holder ?? receipt.first?.identity ?? receipt.crashedCreator?.identity ?? null,
      successor: receipt.successor?.identity ?? receipt.successor ?? null,
    });
    results.push(receipt);
    status(`case ${name} ok`);
  } catch (err) {
    allOk = false;
    receipt = { case: name, ok: false, error: err.stack ?? String(err) };
    results.push(receipt);
    status(`case ${name} FAILED: ${err.message}`);
  }
  writeJson(path.join(evidenceDir, 'receipts', `${name}.json`), receipt);
}

const cleanup = cleanupOwnedDirs([...new Set([...tempDirs, ...fixtureTempDirs])]);
const unclosedChildren = childResources.filter((r) => !r.exit || !r.close || !r.close.stderrEof);
const unclosedHandles = nativeOperations.filter((r) => r.handle && !r.closed);
allOk = allOk && cleanup.failed.length === 0 && unclosedChildren.length === 0 && unclosedHandles.length === 0;
status(`cleanup cleaned=${cleanup.cleaned.length} failed=${cleanup.failed.length}`);

const sqliteProbe = new DatabaseSync(':memory:');
const sqliteVersion = sqliteProbe.prepare('select sqlite_version() v').get().v;
sqliteProbe.close();
writeJson(path.join(evidenceDir, 'resources.json'), {
  runner: { pid: process.pid, node: process.version, platform: process.platform },
  sqlite: { module: 'node:sqlite', version: sqliteVersion, journal_mode: 'delete', busy_timeout: 0, claim: 'BEGIN EXCLUSIVE' },
  registered: resources,
  children: childResources,
  nativeOperations,
});

writeJson(path.join(evidenceDir, 'cleanup.json'), {
  at: new Date().toISOString(),
  ownedTempDirs: [...new Set([...tempDirs, ...fixtureTempDirs])],
  ...cleanup,
  unclosedChildren,
  unclosedHandles,
  remainingOwnedResources: unclosedChildren.length + unclosedHandles.length + cleanup.failed.length,
  broaderHistoricalClosureClaim: false,
  originalCleanupPreserved: true,
  note: 'Only fixture-owned temp directories and runner-spawned children were closed; receipt files are preserved.',
});

writeJson(path.join(evidenceDir, 'result.json'), {
  ok: allOk,
  runner: 'scripts/qa-primitives.mjs',
  node: process.version,
  platform: process.platform,
  sqlite: 'node:sqlite DatabaseSync',
  cases: Object.fromEntries(results.map((r) => [r.case, r.ok === true])),
  startedAt: statusLines[0] ? statusLines[0].match(/\d{4}-\d{2}-\d{2}T[^ ]+/)?.[0] : null,
  endedAt: new Date().toISOString(),
  receipts: results.map((r) => `receipts/${r.case}.json`),
  caseReceipts: results,
  cleanup: { cleaned: cleanup.cleaned.length, failed: cleanup.failed.length },
});
status(allOk ? 'qa-primitives ok' : 'qa-primitives FAILED');
if (emitOnly) {
  const packet = deflateSync(Buffer.from(JSON.stringify({ artifacts, statusLines }))).toString('base64');
  // Bound each line below terminal width; a large single PTY line can be
  // rewritten by terminal wrapping before a caller collects its raw receipt.
  for (let i = 0; i < packet.length; i += 80) console.log(`QA_DATA ${packet.slice(i, i + 80)}`);
  console.log('QA_PACKET_END');
}
// Let stdout and captured child stream events drain before Node exits.
process.exitCode = allOk ? 0 : 1;
