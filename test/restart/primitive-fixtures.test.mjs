// Adjacent test for the standalone SQLite multiprocess lease fixtures
// (native OS identity edition).
// Run: node --test --test-isolation=none test/restart/primitive-fixtures.test.mjs
// All waits are IPC/process-event subscriptions with bounded rejection
// deadlines; there are no sleeps and no timing luck. The database is never
// mocked: both contenders are real OS processes using built-in node:sqlite.
// Identity authority is the Windows kernel (held native handle: PID,
// exact creation FILETIME, image, full command line), queried independently by
// the parent; the child's own monotonic stamp is a nonce only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ALL_CASES,
  BUSY_ERRCODE,
  bindOsIdentity,
  claimLease,
  cleanupOwnedDirs,
  isBusyError,
  killTrackedChildren,
  LeaseBusyError,
  openLeaseDb,
  OsIdentityMismatchError,
  ProcessAbsentError,
  queryOsProcess,
  releaseLease,
  spawnLeaseChild,
  terminateByIdentity,
  validateOsIdentity,
} from './primitive-fixtures.mjs';

const dirs = [];

function freshDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'lease-test-'));
  dirs.push(d);
  return d;
}

test('openLeaseDb enforces journal_mode=DELETE and busy_timeout=0', () => {
  const db = openLeaseDb(path.join(freshDir(), 'l.sqlite'));
  try {
    assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'delete');
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 0);
    // lease table carries ownership only, no payload columns; the child
    // nonce is recorded, never a child-reported birth authority
    const cols = db.prepare('PRAGMA table_info(lease)').all().map((c) => c.name);
    assert.deepEqual(cols, ['id', 'owner_pid', 'owner_nonce', 'acquired_at']);
  } finally {
    db.close();
  }
});

test('in-process second connection gets immediate SQLITE_BUSY (errcode 5, no retry)', () => {
  const dbPath = path.join(freshDir(), 'l.sqlite');
  const a = openLeaseDb(dbPath);
  const b = openLeaseDb(dbPath);
  try {
    claimLease(a, { pid: process.pid, nonce: 'holder-a' });
    const t0 = process.hrtime.bigint();
    assert.throws(() => claimLease(b, { pid: process.pid, nonce: 'claimant-b' }), (err) => {
      assert.ok(err instanceof LeaseBusyError);
      assert.equal(err.errcode, BUSY_ERRCODE);
      assert.ok(isBusyError(err.cause));
      return true;
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, `busy_timeout=0 must fail fast, took ${ms.toFixed(1)}ms`);
    releaseLease(a);
  } finally {
    try { a.close(); } catch {}
    try { b.close(); } catch {}
  }
});

test('validateOsIdentity rejects birth/exe/argv/pid mismatch and accepts exact identity', () => {
  const bound = { pid: 4242, birth: '134045568001230001', exe: 'C:\\x\\node.exe', argvDigest: 'a'.repeat(64) };
  for (const [field, tampered] of [
    ['birth', { ...bound, birth: (BigInt(bound.birth) + 1n).toString() }],
    ['exe', { ...bound, exe: 'C:\\y\\node.exe' }],
    ['argvDigest', { ...bound, argvDigest: 'b'.repeat(64) }],
    ['pid', { ...bound, pid: bound.pid + 1 }],
  ]) {
    assert.throws(
      () => validateOsIdentity(bound, tampered),
      (err) => err instanceof OsIdentityMismatchError && err.field === field,
      `expected rejection on ${field}`,
    );
  }
  validateOsIdentity(bound, bound);
});

test('terminateByIdentity records absence for a dead PID instead of inventing a kill', () => {
  assert.throws(
    () => terminateByIdentity({ pid: 4194303, birth: 1, exe: process.execPath, commandLine: 'no-such-process' }),
    (err) => err instanceof ProcessAbsentError,
  );
});

test('bindOsIdentity rejects a live process whose command line lacks the spawn nonce', () => {
  // this test process is live but was not spawned by the fixture layer, so
  // its command line cannot contain the fixture nonce (it also lacks the
  // fixture path as a child argv, so either rejection field is valid)
  assert.throws(
    () => bindOsIdentity(process.pid, { nonce: 'n-not-this-process' }),
    (err) => err instanceof OsIdentityMismatchError && String(err.field).startsWith('argv:'),
  );
});

for (const [name, runCase] of Object.entries(ALL_CASES)) {
  test(`multiprocess lease case: ${name}`, async () => {
    const receipt = await runCase({ dir: freshDir() });
    assert.equal(receipt.ok, true, `case ${name} receipt not ok: ${JSON.stringify(receipt)}`);
    assert.equal(receipt.case, name);
    assert.ok(receipt.dbPath, 'receipt must bind the exact fixture path');
    if (name === 'handle-acquisition-substitution') {
      assert.equal(receipt.observedRealPidReuse, false);
      assert.equal(receipt.refusal.native.pid, receipt.substituted.os.pid);
      assert.equal(receipt.refusal.native.birth, receipt.substituted.os.birth);
      assert.notEqual(receipt.refusal.native.pid, receipt.holder.os.pid);
      assert.ok(['birth', 'pid'].includes(receipt.refusal.field));
      assert.equal(receipt.refusal.native.terminated, false);
      assert.equal(receipt.refusal.native.closed, true);
      assert.deepEqual(receipt.untouchedAfterRefusal.map((p) => p.pid), [receipt.holder.os.pid, receipt.substituted.os.pid]);
      for (const termination of [receipt.terminationA, receipt.terminationB]) {
        assert.equal(termination.native.wait, 0);
        assert.equal(termination.native.exitCode, 1);
        assert.equal(termination.native.closed, true);
        assert.equal(termination.native.birth, termination.birth);
      }
    }
  });
}

test('no child process is left alive after the suite', async () => {
  const dbPath = path.join(freshDir(), 'l.sqlite');
  const h = spawnLeaseChild({ dbPath, action: 'claim' });
  await h.ipc.expect('held');
  const bound = bindOsIdentity(h.pid, { nonce: h.nonce });
  terminateByIdentity(bound);
  const exit = await h.exitEvent();
  assert.equal(exit.pid, h.pid);
  assert.ok(queryOsProcess(h.pid) === null, 'kernel snapshot must confirm absence');
});

test('owned temporary fixture directories are exactly cleaned', () => {
  const dir = freshDir();
  const { cleaned, failed } = cleanupOwnedDirs([dir]);
  assert.deepEqual(failed, []);
  assert.deepEqual(cleaned, [dir]);
  const idx = dirs.indexOf(dir);
  if (idx >= 0) dirs.splice(idx, 1);
});

test.after(async () => {
  await killTrackedChildren();
  assert.deepEqual(cleanupOwnedDirs(dirs).failed, []);
});
