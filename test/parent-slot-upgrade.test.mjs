import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { claimParentSlot, validParentSlot } from '../src/parent-slot.mjs';

const parent = { paneId: 'parent', tabId: 'tab', shell: { pid: 101, birth: 'parent-birth' } };
const producer = { pid: 202, birth: 'producer-birth', executable: 'node', argvDigest: 'a'.repeat(64) };
const target = { paneId: 'role-pane', tabId: 'tab', shell: { pid: 303, birth: 'role-birth' } };

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'upgrade-slot-'));
  const socketPath = join(root, 'socket');
  await fs.writeFile(socketPath, '');
  let missing = false, fault, currentProducer = producer;
  const actors = [];
  const options = { stateDir: root, socketPath, parent, producer, sessionId: 'session',
    observe: async ({ target: requested, locator }) => {
      if (fault === 'membership') throw Object.assign(new Error('membership unreadable'), { code: 'MEMBERSHIP_UNREADABLE' });
      const gone = missing && (requested ?? locator)?.paneId === target.paneId;
      return { parent: fault === 'parent' ? { ...parent, tabId: 'foreign' } : parent,
        producer: currentProducer, target: !gone ? requested : undefined,
        missing: gone ? {
          code: fault === 'ambiguous' ? 'transport_error' : 'pane_not_found',
          paneId: fault === 'wrong-pane' ? 'other' : (requested ?? locator).paneId,
        } : undefined };
    },
    observePrevious: async identity => ({ identity, state: 'dead' }) };
  t.after(async () => {
    for (const actor of actors) if (actor.db.isOpen) {
      if (actor.db.isTransaction) actor.db.exec('ROLLBACK');
      actor.db.close();
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, options, setMissing: value => { missing = value; }, setFault: value => { fault = value; },
    async claim(overrides = {}) {
      currentProducer = overrides.producer ?? producer;
      const actor = await claimParentSlot({ ...options, ...overrides });
      actors.push(actor);
      return actor;
    } };
}

async function blocked(actor, role = 'todo', type = 'arrange') {
  const participant = role === 'todo' ? 'todo' : 'dag';
  await actor.join(participant, 'lifetime');
  const record = { ...target, viewer: producer,
    statePath: join(actor.paths.directory, 'state.json'), sourcePath: join(actor.paths.directory, 'source.json'),
    cachePath: join(actor.paths.directory, 'cache.json'), prefsPath: join(actor.paths.directory, 'prefs.json'),
    launchToken: 'launch-secret', controlToken: 'control-secret' };
  await actor.registerRole(actor.capability(participant, role), record);
  await assert.rejects(actor.perform(actor.capability(participant, role), { type, target: record },
    async () => { throw new Error('placement response lost'); }), { code: 'EFFECT_UNKNOWN' });
  return actor.snapshot.operations.at(-1);
}

for (const status of ['UNKNOWN', 'DISPATCHED'])
  test(`authoritative target disappearance settles ${status} without replaying placement`, async t => {
    const f = await fixture(t), actor = await f.claim(), op = await blocked(actor);
    if (status === 'DISPATCHED') await actor.publish({ ...actor.snapshot,
      operations: actor.snapshot.operations.map(item => ({ ...item, status })) });
    f.setMissing(true);
    await actor.reconcile(op.id);
    const settled = actor.snapshot.operations.at(-1);
    assert.equal(settled.status, 'SETTLED');
    assert.deepEqual(settled.settlement, { reason: 'target_gone', code: 'pane_not_found', paneId: target.paneId });
    assert.equal(actor.blocked, false);
    assert.ok(actor.snapshot.closures.some(entry => entry.role === 'todo' && entry.reason === 'pane_not_found'));
    assert.equal(validParentSlot(actor.snapshot), true);
    assert.deepEqual(JSON.parse(await fs.readFile(actor.paths.slotPath, 'utf8')), actor.snapshot);
  });

for (const fault of ['ambiguous', 'wrong-pane', 'membership', 'parent', 'lease'])
  test(`target disappearance stays blocked for ${fault}`, async t => {
    const f = await fixture(t), actor = await f.claim(), op = await blocked(actor);
    const before = actor.snapshot, disk = await fs.readFile(actor.paths.slotPath);
    f.setMissing(true); f.setFault(fault);
    if (fault === 'lease') actor.db.exec('ROLLBACK');
    await assert.rejects(actor.reconcile(op.id));
    assert.deepEqual(actor.snapshot, before);
    assert.deepEqual(await fs.readFile(actor.paths.slotPath), disk);
    assert.equal(actor.blocked, true);
  });

test('blocked release closes SQLite and permits rename and target-gone successor recovery', async t => {
  const f = await fixture(t), actor = await f.claim(), op = await blocked(actor, 'workers');
  const before = actor.snapshot;
  await assert.rejects(actor.release(), { code: 'EFFECT_UNKNOWN' });
  assert.equal(actor.db.isOpen, false);
  assert.equal(actor.leaseHeld, false);
  assert.deepEqual(JSON.parse(await fs.readFile(actor.paths.slotPath, 'utf8')), before);
  await fs.rename(actor.paths.directory, `${actor.paths.directory}.moved`);
  await fs.rename(`${actor.paths.directory}.moved`, actor.paths.directory);
  const db = new DatabaseSync(actor.paths.leasePath);
  db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); db.close();
  f.setMissing(true);
  const successor = await f.claim({ producer: { ...producer, pid: 203, birth: 'successor-birth' } });
  assert.equal(successor.snapshot.phase, 'CLAIMED');
  assert.notEqual(successor.snapshot.ownerNonce, before.ownerNonce);
  assert.equal(successor.snapshot.operations.find(item => item.id === op.id).settlement.reason, 'target_gone');
  await successor.join('dag', 'next-lifetime');
  await successor.perform(successor.capability('dag', 'workers'), { type: 'split', target: parent },
    async () => ({ effects: Promise.resolve(), result: 'created' }));
  await successor.drain('dag', 'next-lifetime'); await successor.release();
});

test('release closes SQLite even when DRAINING publication fails', async t => {
  const f = await fixture(t);
  let deny = false;
  const actor = await f.claim({ fs: { ...fs, rename: (...args) => {
    if (deny) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return fs.rename(...args);
  } } });
  deny = true;
  await assert.rejects(actor.release(), { code: 'PUBLISH_FAILED' });
  assert.equal(actor.db.isOpen, false);
  await fs.rename(actor.paths.directory, `${actor.paths.directory}.moved`);
  await fs.rename(`${actor.paths.directory}.moved`, actor.paths.directory);
});

test('same-process reload recognizes only its exact cooperatively released blocked journal', async t => {
  const f = await fixture(t), actor = await f.claim();
  await blocked(actor);
  await assert.rejects(actor.release());
  f.setMissing(true);
  const successor = await f.claim({ observePrevious: undefined });
  assert.equal(successor.snapshot.phase, 'CLAIMED');
  assert.equal(successor.snapshot.operations.at(-1).settlement.reason, 'target_gone');
  await successor.release();
});

test('blocked release retains the lease until an already queued drain publication completes', async t => {
  const f = await fixture(t), actor = await f.claim();
  await blocked(actor);
  const entered = Promise.withResolvers(), complete = Promise.withResolvers();
  const filesystem = actor.fs;
  actor.fs = { ...filesystem, rename: async (...args) => {
    entered.resolve();
    await complete.promise;
    return filesystem.rename(...args);
  } };
  const released = actor.release();
  const rejected = assert.rejects(released, { code: 'EFFECT_UNKNOWN' });
  const drained = actor.drain('todo', 'lifetime');
  const signal = AbortSignal.timeout(2000);
  await Promise.race([entered.promise, new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
  assert.equal(actor.leaseHeld, true);
  complete.resolve();
  await Promise.all([rejected, drained]);
  assert.equal(actor.db.isOpen, false);
});

test('failed successor recovery preserves the blocked journal and releases its attempted lease', async t => {
  const f = await fixture(t), actor = await f.claim();
  await blocked(actor);
  await assert.rejects(actor.release());
  const bytes = await fs.readFile(actor.paths.slotPath);
  f.setMissing(true); f.setFault('ambiguous');
  await assert.rejects(f.claim({ producer: { ...producer, pid: 203, birth: 'successor-birth' } }));
  assert.deepEqual(await fs.readFile(actor.paths.slotPath), bytes);
  const db = new DatabaseSync(actor.paths.leasePath);
  db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); db.close();
});

test('blocked diagnostic ring is bounded, allowlisted and excludes authority and content', async t => {
  const f = await fixture(t), actor = await f.claim();
  await blocked(actor);
  for (let index = 0; index < 210; index++)
    await actor.diagnose('reconcile', Object.assign(new Error('secret C:/private conversation-id'), { code: 'EFFECT_UNKNOWN' }),
      { type: 'arrange', role: 'workers', id: 'conversation-id', token: 'launch-secret' });
  const path = join(actor.paths.directory, 'blocked-diagnostics.jsonl');
  const bytes = await fs.readFile(path, 'utf8'), entries = bytes.trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 200);
  assert.ok(Buffer.byteLength(bytes) <= 65536);
  assert.ok(entries.every(entry => Object.keys(entry).sort().join(',') === 'branch,code,role,time,type' &&
    Number.isFinite(Date.parse(entry.time)) && entry.branch === 'reconcile' &&
    entry.code === 'EFFECT_UNKNOWN' && entry.type === 'arrange' && entry.role === 'workers'));
  assert.doesNotMatch(bytes, /secret|private|conversation-id|launch-secret/);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
});
