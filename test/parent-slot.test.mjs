import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { claimParentSlot, parentSlotPaths, validParentSlot } from '../src/parent-slot.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const producer = { pid: 123, birth: '133900000000000000', executable: 'node.exe', argvDigest: hash('producer') };
const parent = { paneId: 'qa:parent', tabId: 'qa:tab', shell: { pid: 456, birth: '133800000000000000' } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = promise => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('event deadline')), 10000);
  })]).finally(() => clearTimeout(timer));
};
async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'parent-slot-'));
  const socketPath = join(root, 'control.sock');
  await fs.writeFile(socketPath, '');
  const options = { stateDir: join(root, 'state'), socketPath, parent, producer, sessionId: 'session-a',
    observe: async ({ target }) => ({ parent, producer, target }), ...extra };
  const actors = [];
  t.after(async () => {
    for (const actor of actors) {
      for (const [name, entry] of Object.entries(actor.snapshot.participants)) {
        await actor.drain(name, entry.lifetimeId);
      }
      await actor.release();
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, options, actors, async claim(overrides = {}) {
    const actor = await claimParentSlot({ ...options, ...overrides });
    if (!actors.includes(actor)) actors.push(actor);
    return actor;
  } };
}
async function joinBoth(actor) {
  await actor.join('todo', 'w-life');
  await actor.join('dag', 'd-life');
}
const intent = (type = 'split') => ({ type, target: { paneId: parent.paneId, tabId: parent.tabId, shell: parent.shell } });
const effect = async () => ({ result: 'done', effects: Promise.resolve() });
const cap = (actor, participant = 'todo', role = 'todo') => actor.capability(participant, role);

test('canonical aliases and simultaneous participants share one process actor, not a session or tab key', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.options.stateDir);
  const alias = join(f.root, 'alias');
  await fs.symlink(f.options.stateDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const [a, b] = await Promise.all([f.claim(), f.claim({ stateDir: alias })]);
  assert.equal(a, b);
  await joinBoth(a);
  const paths = await parentSlotPaths(f.options);
  assert.equal(paths.layoutKey, hash(JSON.stringify([paths.canonicalSocketPath, parent.paneId])));
  assert.equal(paths.directory, join(paths.canonicalStateDir, 'parent-slots', paths.layoutKey));
  await assert.rejects(f.claim({ sessionId: 'session-b' }), { code: 'LIVE_INCUMBENT', inlineFallback: true });
  await assert.rejects(f.claim({ parent: { ...parent, tabId: 'other-tab' } }), { code: 'PARENT_MISMATCH' });
  await assert.rejects(f.claim({ parent: { ...parent, shell: { ...parent.shell, birth: 'wrong' } } }), { code: 'PARENT_MISMATCH' });
});

test('lease is a held DELETE journal transaction, timeout zero, and does not allow a second database claimant', async t => {
  const f = await fixture(t), actor = await f.claim();
  const other = new DatabaseSync(actor.paths.leasePath, { timeout: 0 });
  try {
    other.exec('PRAGMA busy_timeout = 0');
    assert.throws(() => other.exec('BEGIN EXCLUSIVE'), error => error.errcode === 5);
  } finally { other.close(); }
  assert.equal(actor.leaseHeld, true);
  assert.equal(actor.snapshot.phase, 'CLAIMED');
});

test('a held reader cannot prevent writer admission or grant a second writer ownership', async t => {
  const f = await fixture(t), paths = await parentSlotPaths(f.options);
  await fs.mkdir(paths.directory, { recursive: true });
  const reader = new DatabaseSync(paths.leasePath, { timeout: 0 });
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT name FROM sqlite_schema').all();
    const actor = await f.claim();
    assert.equal(reader.isTransaction, true);
    assert.equal(actor.leaseHeld, true);
    assert.equal(actor.db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(actor.db.prepare('PRAGMA busy_timeout').get().timeout, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(paths.slotPath, 'utf8')), actor.snapshot);
    const other = new DatabaseSync(paths.leasePath, { timeout: 0 });
    try { assert.throws(() => other.exec('BEGIN IMMEDIATE'), error => error.errcode === 5); }
    finally { other.close(); }
    await actor.release();
    assert.equal(actor.leaseHeld, false);
    assert.equal(reader.isTransaction, true);
  } finally { reader.exec('ROLLBACK'); reader.close(); }
});

test('schema rejects payloads, unknown keys, invalid identities, phases and journal correlations', async t => {
  const f = await fixture(t), actor = await f.claim();
  assert.equal(validParentSlot(actor.snapshot), true);
  for (const value of [
    null, {}, { ...actor.snapshot, tasks: [] }, { ...actor.snapshot, revision: 0 },
    { ...actor.snapshot, phase: 'WAIT' }, { ...actor.snapshot, layoutKey: hash('wrong') },
    { ...actor.snapshot, producer: { ...producer, pid: 0 } },
    { ...actor.snapshot, participants: { invalid: { lifetimeId: 'x', drained: false } } },
    { ...actor.snapshot, transaction: { id: 'x', phase: 'READY' } },
  ]) assert.equal(validParentSlot(value), false);
});

test('conversation paths and old metadata are locators only and remain isolated', async t => {
  const f = await fixture(t), actor = await f.claim();
  const old = join(f.root, 'old-source.json');
  await fs.writeFile(old, JSON.stringify({ tasks: ['old-task'] }));
  await joinBoth(actor);
  const record = { paneId: 'qa:todo', tabId: parent.tabId, shell: parent.shell,
    viewer: producer, statePath: join(f.root, 'session-a', 'todo.json'),
    sourcePath: old, cachePath: join(f.root, 'session-a', 'todo.cache.json'),
    prefsPath: join(f.root, 'session-a', 'todo.view.json'), launchToken: 'launch-a', controlToken: 'control-a' };
  await actor.registerRole(cap(actor), record);
  assert.equal(await fs.readFile(old, 'utf8'), '{"tasks":["old-task"]}');
  assert.equal(actor.snapshot.roles.todo.statePath, record.statePath);
  assert.equal(JSON.stringify(actor.snapshot).includes('old-task'), false);
  const retired = actor.snapshot;
  await actor.drain('todo', 'w-life'); await actor.drain('dag', 'd-life');
  await actor.release();
  const fresh = await f.claim({ sessionId: 'session-b' });
  assert.equal(fresh.snapshot.generation, retired.generation + 1);
  assert.equal(fresh.snapshot.sessionId, 'session-b');
  assert.equal(fresh.snapshot.roles.todo.sessionId, 'session-a');
  assert.equal(fresh.snapshot.roles.todo.ack, null);
  await joinBoth(fresh);
  await assert.rejects(fresh.registerRole(cap(fresh), record), { code: 'ROLE_MISMATCH' });
  const next = { ...record, statePath: join(f.root, 'session-b', 'todo.json'),
    sourcePath: join(f.root, 'session-b', 'source.json'), cachePath: join(f.root, 'session-b', 'todo.cache.json'),
    prefsPath: join(f.root, 'session-b', 'todo.view.json'), launchToken: 'launch-b', controlToken: 'control-b' };
  await fresh.registerRole(cap(fresh), next);
  assert.equal(fresh.snapshot.roles.todo.statePath, next.statePath);
  assert.equal(await fs.readFile(old, 'utf8'), '{"tasks":["old-task"]}');
});

for (const kind of ['statePath', 'sourcePath', 'cachePath', 'prefsPath']) {
  for (const route of ['same-role', 'other-role', 'next-generation']) {
    test(`prior conversation ${kind} rejects retarget after replacement through ${route}`, async t => {
      const f = await fixture(t), a = await f.claim();
      const locators = ['statePath', 'sourcePath', 'cachePath', 'prefsPath'];
      const record = session => ({ paneId: 'qa:todo', tabId: parent.tabId, shell: parent.shell,
        viewer: producer, ...Object.fromEntries(locators.map(key => [key, join(f.root, `${session}-${key}.json`)])),
        launchToken: `launch-${session}`, controlToken: `control-${session}` });
      const old = record('a'), current = record('b');
      const payloads = new Map();
      for (const key of locators) {
        const bytes = Buffer.from(JSON.stringify({ session: 'a', tasks: [`old-${key}`] }));
        await fs.writeFile(old[key], bytes); payloads.set(old[key], bytes);
      }
      await joinBoth(a); await a.registerRole(cap(a), old);
      await a.drain('todo', 'w-life'); await a.drain('dag', 'd-life'); await a.release();
      let b = await f.claim({ sessionId: 'session-b' });
      await joinBoth(b); await b.registerRole(cap(b), current);
      // Reusing current-session locators remains valid with refreshed capabilities.
      await b.registerRole(cap(b), current);
      if (route === 'next-generation') {
        await b.drain('todo', 'w-life'); await b.drain('dag', 'd-life'); await b.release();
        const nextProducer = { ...producer, pid: 124, birth: '133900000000000001' };
        b = await f.claim({ sessionId: 'session-c', producer: nextProducer,
          observe: async ({ target }) => ({ parent, producer: nextProducer, target }) });
        assert.equal(b.snapshot.generation, 3);
        await joinBoth(b); await b.registerRole(cap(b), record('c'));
      }
      const participant = route === 'other-role' ? 'dag' : 'todo';
      const role = route === 'other-role' ? 'workers' : 'todo';
      const candidate = { ...record(route === 'next-generation' ? 'c' : 'b'),
        paneId: route === 'other-role' ? 'qa:workers' : 'qa:todo',
        [kind]: join(f.root, '.', `a-${kind}.json`) };
      const before = b.snapshot, disk = await fs.readFile(b.paths.slotPath);
      const rejection = await b.registerRole(cap(b, participant, role), candidate).then(
        () => null, error => ({ code: error.code, inlineFallback: error.inlineFallback }));
      for (const [path, bytes] of payloads) assert.deepEqual(await fs.readFile(path), bytes);
      assert.deepEqual(rejection, { code: 'ROLE_MISMATCH', inlineFallback: true });
      assert.deepEqual(b.snapshot, before);
      assert.deepEqual(await fs.readFile(b.paths.slotPath), disk);
    });
  }
}

test('locator ownership survives same-session replacement and allows current-session shared locators', async t => {
  const f = await fixture(t), a = await f.claim(); await joinBoth(a);
  const record = suffix => ({ paneId: 'qa:todo', tabId: parent.tabId, shell: parent.shell, viewer: producer,
    ...Object.fromEntries(['statePath', 'sourcePath', 'cachePath', 'prefsPath'].map(key =>
      [key, join(f.root, `${suffix}-${key}.json`)])), launchToken: suffix, controlToken: suffix });
  const first = record('a1'), second = record('a2');
  await a.registerRole(cap(a), first); await a.registerRole(cap(a), second);
  await a.registerRole(cap(a, 'dag', 'workers'), { ...second, paneId: 'qa:workers' });
  assert.equal(a.snapshot.locatorOwners.length, 8);
  await a.drain('todo', 'w-life'); await a.drain('dag', 'd-life'); await a.release();
  const b = await f.claim({ sessionId: 'session-b' }); await joinBoth(b);
  const current = record('b'); await b.registerRole(cap(b), current);
  for (const [index, kind] of ['statePath', 'sourcePath', 'cachePath', 'prefsPath'].entries()) {
    const destination = ['sourcePath', 'cachePath', 'prefsPath', 'statePath'][index];
    const oldPath = process.platform === 'win32' ? first[kind].toUpperCase().replaceAll('/', '\\') : first[kind];
    const before = b.snapshot, disk = await fs.readFile(b.paths.slotPath);
    await assert.rejects(b.registerRole(cap(b), { ...current, [destination]: oldPath }), { code: 'ROLE_MISMATCH' });
    assert.deepEqual(b.snapshot, before); assert.deepEqual(await fs.readFile(b.paths.slotPath), disk);
  }
});

test('strict ownership schema and journal negatives reject malformed fields and correlations', async t => {
  const f = await fixture(t), actor = await f.claim(); await joinBoth(actor);
  await actor.perform(cap(actor), intent(), effect);
  const record = { paneId: 'qa:todo', tabId: parent.tabId, shell: parent.shell, viewer: producer,
    statePath: join(f.root, 's.json'), sourcePath: join(f.root, 'source.json'),
    cachePath: join(f.root, 'cache.json'), prefsPath: join(f.root, 'prefs.json'),
    launchToken: 'launch', controlToken: 'control' };
  await actor.registerRole(cap(actor), record);
  await actor.ackRole({ ...cap(actor), paneId: record.paneId, statePath: record.statePath,
    launchToken: record.launchToken, controlToken: record.controlToken, sequence: 1, painted: true });
  await actor.closeRole(cap(actor), { paneId: record.paneId, reason: 'q' });
  const valid = actor.snapshot;
  assert.equal(validParentSlot(valid), true);
  let rejected = 0;
  const reject = change => {
    const value = structuredClone(valid); change(value);
    assert.equal(validParentSlot(value), false); rejected++;
  };
  for (const key of Object.keys(valid)) reject(value => { delete value[key]; });
  for (const select of [v => v.parent, v => v.parent.shell, v => v.producer, v => v.transaction,
    v => v.participants.todo, v => v.roles.todo, v => v.roles.todo.viewer, v => v.roles.todo.ack,
    v => v.locatorOwners[0], v => v.operations[0], v => v.operations[0].target, v => v.closures[0]]) {
    for (const key of Object.keys(select(valid))) reject(value => { delete select(value)[key]; });
    reject(value => { select(value).tasks = []; });
  }
  for (const owners of [null, {}, [null], [{}], [], [...valid.locatorOwners, valid.locatorOwners[0]],
    valid.locatorOwners.map((entry, i) => i ? entry : { ...entry, sessionId: 'wrong' }),
    valid.locatorOwners.map((entry, i) => i ? entry : { ...entry, path: 'relative.json' }),
    valid.locatorOwners.map((entry, i) => i ? entry : { ...entry, path: '' }),
    valid.locatorOwners.map((entry, i) => i ? entry : { ...entry, sessionId: 1 })]) {
    reject(value => { value.locatorOwners = owners; });
  }
  for (const patch of [{ generation: 0 }, { generation: valid.generation + 1 }, { participant: 'dag' },
    { role: 'dag' }, { preparedRevision: 0 }, { preparedRevision: valid.revision + 1 },
    { ownerNonce: 'wrong' }, { sessionId: 'wrong' }, { lifetimeId: 'wrong' }, { status: 'WAIT' },
    { type: 'payload' }, { target: { ...valid.operations[0].target, tabId: 'wrong' } }]) {
    reject(value => { Object.assign(value.operations[0], patch); });
  }
  reject(value => { value.operations.push(value.operations[0]); });
  for (const patch of [{ generation: 0 }, { generation: valid.generation + 1 }, { participant: 'dag' },
    { role: 'workers' }, { tabId: 'wrong' }, { sessionId: 'wrong' }, { ack: { sequence: 0, painted: true } },
    { ack: { sequence: 1, painted: 'true' } }, { lifetimeId: 'wrong' }]) {
    reject(value => { Object.assign(value.roles.todo, patch); });
  }
  for (const patch of [{ role: 'foreign' }, { paneId: '' }, { reason: 'restart' }, { sessionId: '' },
    { generation: 0 }, { generation: valid.generation + 1 }]) {
    reject(value => { Object.assign(value.closures[0], patch); });
  }
  reject(value => { value.phase = value.transaction.phase = 'READY'; });
  reject(value => { value.phase = value.transaction.phase = 'RELEASED'; });
  reject(value => { value.phase = value.transaction.phase = 'PREPARED'; });
  reject(value => { value.transaction.id = 'missing'; });
  reject(value => { value.schema = 'omo-herdr-dashboard/parent-slot/1'; });
  t.diagnostic(`strict-negative-count=${rejected}`);
});

test('ownership history cannot be removed reordered or reassigned by publication', async t => {
  const f = await fixture(t), actor = await f.claim(); await joinBoth(actor);
  await actor.registerRole(cap(actor), { paneId: 'qa:todo', tabId: parent.tabId, shell: parent.shell, viewer: producer,
    statePath: join(f.root, 's'), sourcePath: join(f.root, 'source'), cachePath: join(f.root, 'cache'),
    prefsPath: join(f.root, 'prefs'), launchToken: 'launch', controlToken: 'control' });
  const before = actor.snapshot, disk = await fs.readFile(actor.paths.slotPath);
  for (const locatorOwners of [[], [...before.locatorOwners].reverse(),
    before.locatorOwners.map(entry => ({ ...entry, sessionId: 'other' }))]) {
    const candidate = { ...before, roles: {}, locatorOwners };
    assert.equal(validParentSlot(candidate), true);
    await assert.rejects(actor.publish(candidate), { code: 'SLOT_CORRUPT' });
    assert.deepEqual(actor.snapshot, before); assert.deepEqual(await fs.readFile(actor.paths.slotPath), disk);
  }
});

test('role and locator ownership publish atomically and failed registration reserves nothing', async t => {
  let denied = false;
  const publications = [];
  const f = await fixture(t, { fs: { ...fs, rename: async (from, to) => {
    if (denied) throw Object.assign(new Error('owned denial'), { code: 'EPERM' });
    await fs.rename(from, to); publications.push(JSON.parse(await fs.readFile(to, 'utf8')));
  } } }), actor = await f.claim(); await joinBoth(actor);
  const record = { paneId: 'qa:todo', tabId: parent.tabId, shell: parent.shell, viewer: producer,
    statePath: join(f.root, 's'), sourcePath: join(f.root, 'source'), cachePath: join(f.root, 'cache'),
    prefsPath: join(f.root, 'prefs'), launchToken: 'launch', controlToken: 'control' };
  const before = actor.snapshot, disk = await fs.readFile(actor.paths.slotPath);
  denied = true;
  await assert.rejects(actor.registerRole(cap(actor), record), { code: 'PUBLISH_FAILED' });
  assert.deepEqual(actor.snapshot, before); assert.deepEqual(await fs.readFile(actor.paths.slotPath), disk);
  assert.equal((await fs.readdir(actor.paths.directory)).some(name => name.endsWith('.pending')), false);
  denied = false; await actor.drain('todo', 'w-life'); await actor.drain('dag', 'd-life'); await actor.release();
  const next = await f.claim({ sessionId: 'session-b' }); await joinBoth(next);
  await next.registerRole(cap(next), record);
  assert.equal(next.snapshot.locatorOwners.length, 4);
  assert.equal(publications.every(validParentSlot), true);
  const published = publications.find(value => value.roles.todo);
  assert.deepEqual(published.roles.todo.statePath, record.statePath);
  assert.equal(published.locatorOwners.length, 4);
});

test('older incomplete ownership schema rejects on disk without changing its bytes', async t => {
  const f = await fixture(t), actor = await f.claim();
  await actor.release();
  const legacy = { ...actor.snapshot, schema: 'omo-herdr-dashboard/parent-slot/1' };
  delete legacy.locatorOwners;
  const bytes = Buffer.from(JSON.stringify(legacy)); await fs.writeFile(actor.paths.slotPath, bytes);
  await assert.rejects(f.claim({ sessionId: 'session-b' }), { code: 'SLOT_CORRUPT' });
  assert.deepEqual(await fs.readFile(actor.paths.slotPath), bytes);
});

test('role registration and READY require current tokens, exact scope and painted sequence for all roles', async t => {
  let changedViewer = false;
  const f = await fixture(t, { observe: async ({ target }) => ({ parent, producer,
    target: changedViewer && target?.paneId === 'qa:dag'
      ? { ...target, viewer: { ...target.viewer, birth: 'wrong' } } : target,
  }) }), actor = await f.claim();
  await joinBoth(actor);
  await actor.perform(cap(actor), intent(), effect);
  await assert.rejects(actor.ready(), { code: 'ROLES_NOT_READY' });
  for (const [participant, role] of [['todo', 'todo'], ['dag', 'dag'], ['dag', 'workers']]) {
    const record = { paneId: `qa:${role}`, tabId: parent.tabId, shell: parent.shell, viewer: producer,
      statePath: join(f.root, `${role}.json`), sourcePath: join(f.root, `${role}.source.json`),
      cachePath: join(f.root, `${role}.cache.json`), prefsPath: join(f.root, `${role}.prefs.json`),
      launchToken: `launch-${role}`, controlToken: `control-${role}` };
    await actor.registerRole(cap(actor, participant, role), record);
    const binding = { ...cap(actor, participant, role), paneId: record.paneId,
      statePath: record.statePath, launchToken: record.launchToken, controlToken: record.controlToken,
      sequence: 1, painted: true };
    await assert.rejects(actor.ackRole({ ...binding, generation: 0 }), { code: 'STALE_CAPABILITY' });
    await assert.rejects(actor.ackRole({ ...binding, controlToken: 'wrong' }), { code: 'ACK_MISMATCH' });
    await assert.rejects(actor.ackRole({ ...binding, painted: false }), { code: 'ACK_MISMATCH' });
    await actor.ackRole(binding);
  }
  await actor.ready();
  assert.equal(actor.snapshot.phase, 'READY');
  assert.equal(actor.inlineFallback, false);
  const todo = actor.snapshot.roles.todo;
  await actor.perform(cap(actor), intent('retire'), effect);
  assert.equal(actor.snapshot.roles.todo.ack.painted, false);
  await assert.rejects(actor.ready(), { code: 'ROLES_NOT_READY' });
  const nextAck = { ...cap(actor), paneId: todo.paneId, statePath: todo.statePath,
    launchToken: todo.launchToken, controlToken: todo.controlToken, sequence: 1, painted: true };
  await assert.rejects(actor.ackRole(nextAck), { code: 'ACK_MISMATCH' });
  await actor.ackRole({ ...nextAck, sequence: 2 });
  changedViewer = true;
  await assert.rejects(actor.ready(), { code: 'IDENTITY_MISMATCH', inlineFallback: true });
  assert.equal(actor.inlineFallback, true);
});

test('same-session reclaimed compatible roles reach READY without a new layout operation', async t => {
  const f = await fixture(t), first = await f.claim(); await joinBoth(first);
  await first.perform(cap(first), intent(), effect);
  const records = ['todo', 'dag', 'workers'].map(role => ({
    paneId: `qa:${role}`, tabId: parent.tabId, shell: parent.shell, viewer: producer,
    statePath: join(f.root, `${role}.json`), sourcePath: join(f.root, `${role}.source.json`),
    cachePath: join(f.root, `${role}.cache.json`), prefsPath: join(f.root, `${role}.prefs.json`),
    launchToken: `launch-${role}`, controlToken: `control-${role}`,
  }));
  for (const [index, record] of records.entries()) {
    const role = ['todo', 'dag', 'workers'][index], participant = role === 'todo' ? 'todo' : 'dag';
    await first.registerRole(cap(first, participant, role), record);
    await first.ackRole({ ...cap(first, participant, role), ...record, sequence: 1, painted: true });
  }
  await first.ready();
  await assert.rejects(first.join('todo', 'w-next'), { code: 'PARTICIPANT_LIVE' });
  await assert.rejects(first.join('dag', 'd-next'), { code: 'PARTICIPANT_LIVE' });
  await first.drain('todo', 'w-life'); await first.drain('dag', 'd-life'); await first.release();
  const actor = await f.claim();
  await actor.join('todo', 'w-next'); await actor.join('dag', 'd-next');
  for (const [index, record] of records.entries()) {
    const role = ['todo', 'dag', 'workers'][index], participant = role === 'todo' ? 'todo' : 'dag';
    await actor.registerRole(cap(actor, participant, role), record);
    await assert.rejects(actor.ready(), { code: 'ROLES_NOT_READY' });
    await actor.ackRole({ ...cap(actor, participant, role), ...record, sequence: 1, painted: true });
  }
  const before = actor.snapshot;
  assert.equal(before.phase, 'CLAIMED'); assert.equal(before.generation, 2);
  assert.equal(before.operations.filter(op => op.generation === before.generation).length, 0);
  await actor.ready();
  assert.equal(actor.snapshot.phase, 'READY'); assert.equal(actor.inlineFallback, false);
  assert.deepEqual(actor.snapshot.operations, before.operations);
  assert.deepEqual(actor.snapshot.locatorOwners, before.locatorOwners);
});

test('READY compatible role refresh restores fallback and requires increasing current paint', async t => {
  const f = await fixture(t), actor = await f.claim(); await joinBoth(actor);
  await actor.perform(cap(actor), intent(), effect);
  const records = {};
  for (const role of ['todo', 'dag', 'workers']) {
    const participant = role === 'todo' ? 'todo' : 'dag';
    const record = { paneId: `qa:${role}`, tabId: parent.tabId, shell: parent.shell, viewer: producer,
      statePath: join(f.root, `${role}.json`), sourcePath: join(f.root, `${role}.source.json`),
      cachePath: join(f.root, `${role}.cache.json`), prefsPath: join(f.root, `${role}.prefs.json`),
      launchToken: `launch-${role}`, controlToken: `control-${role}` };
    records[role] = record;
    await actor.registerRole(cap(actor, participant, role), record);
    await actor.ackRole({ ...cap(actor, participant, role), ...record, sequence: 7, painted: true });
  }
  await actor.ready();
  const before = actor.snapshot, stale = cap(actor);
  const current = { ...records.todo, cachePath: join(f.root, 'scope-2', 'todo.cache.json') };
  await actor.registerRole(stale, current);
  assert.equal(actor.inlineFallback, true); assert.equal(actor.snapshot.phase, 'CLAIMED');
  assert.equal(actor.snapshot.roles.todo.cachePath, current.cachePath);
  assert.deepEqual(actor.snapshot.roles.todo.ack, { sequence: 7, painted: false });
  assert.deepEqual(actor.snapshot.roles.dag, before.roles.dag);
  assert.deepEqual(actor.snapshot.roles.workers, before.roles.workers);
  await assert.rejects(actor.ready(), { code: 'ROLES_NOT_READY' });
  await assert.rejects(actor.ackRole({ ...stale, ...current, sequence: 8, painted: true }), { code: 'STALE_CAPABILITY' });
  for (const patch of [{ sequence: 7, painted: true }, { sequence: 8, painted: false },
    { sequence: 8, painted: true, controlToken: 'old-token' }]) {
    await assert.rejects(actor.ackRole({ ...cap(actor), ...current, ...patch }), { code: 'ACK_MISMATCH' });
  }
  await actor.ackRole({ ...cap(actor), ...current, sequence: 8, painted: true });
  await actor.ready();
  assert.equal(actor.inlineFallback, false); assert.equal(actor.snapshot.phase, 'READY');
  assert.deepEqual(actor.snapshot.operations, before.operations);
  // Another registration must not erase the established paint sequence floor.
  await actor.registerRole(cap(actor), current);
  await actor.registerRole(cap(actor), current);
  await assert.rejects(actor.ackRole({ ...cap(actor), ...current, sequence: 8, painted: true }),
    { code: 'ACK_MISMATCH' });
  await actor.ackRole({ ...cap(actor), ...current, sequence: 9, painted: true });
  await actor.ready();
});

for (const boundary of ['drained', 'released', 'unknown-effect', 'unsettled-effect',
  'changed-parent', 'changed-producer', 'changed-role']) {
  test(`no-layout readiness rejects ${boundary} without interpreting it as reuse`, async t => {
    let changed = false;
    const f = await fixture(t, { observe: async ({ target }) => ({
      parent: changed && boundary === 'changed-parent'
        ? { ...parent, shell: { ...parent.shell, birth: 'wrong' } } : parent,
      producer: changed && boundary === 'changed-producer' ? { ...producer, birth: 'wrong' } : producer,
      target: changed && boundary === 'changed-role' && target?.paneId === 'qa:workers'
        ? { ...target, viewer: { ...producer, birth: 'wrong' } } : target,
    }) }), actor = await f.claim(); await joinBoth(actor);
    for (const role of ['todo', 'dag', 'workers']) {
      const participant = role === 'todo' ? 'todo' : 'dag';
      const record = { paneId: `qa:${role}`, tabId: parent.tabId, shell: parent.shell, viewer: producer,
        statePath: join(f.root, `${role}.json`), sourcePath: join(f.root, `${role}.source.json`),
        cachePath: join(f.root, `${role}.cache.json`), prefsPath: join(f.root, `${role}.prefs.json`),
        launchToken: `launch-${role}`, controlToken: `control-${role}` };
      await actor.registerRole(cap(actor, participant, role), record);
      await actor.ackRole({ ...cap(actor, participant, role), ...record, sequence: 1, painted: true });
    }
    if (boundary === 'drained') await actor.drain('todo', 'w-life');
    if (boundary === 'released') {
      await actor.drain('todo', 'w-life'); await actor.drain('dag', 'd-life'); await actor.release();
    }
    if (boundary.endsWith('-effect')) {
      // Strict-schema CLAIMED metadata is not proof that its effects settled.
      const operation = { id: 'unresolved', ...cap(actor), type: 'split', target: parent,
        status: boundary === 'unknown-effect' ? 'UNKNOWN' : 'DISPATCHED',
        preparedRevision: actor.snapshot.revision };
      delete operation.revision;
      await actor.publish({ ...actor.snapshot, operations: [operation] });
    }
    const before = actor.snapshot, disk = await fs.readFile(actor.paths.slotPath);
    changed = true;
    await assert.rejects(actor.ready(), {
      code: boundary.startsWith('changed-') ? 'IDENTITY_MISMATCH' : 'ROLES_NOT_READY',
      inlineFallback: true,
    });
    assert.equal(actor.inlineFallback, true);
    assert.deepEqual(actor.snapshot, before); assert.deepEqual(await fs.readFile(actor.paths.slotPath), disk);
    if (boundary.endsWith('-effect')) {
      // Remove only this test's injected journal fault for deterministic cleanup.
      await actor.settle('unresolved', 'SETTLED', 'CLAIMED');
    }
  });
}

test('actual persisted PREPARED intent is required before dispatch, with correlated operation id', async t => {
  const publications = [];
  const f = await fixture(t, { fs: { ...fs, rename: async (from, to) => {
    await fs.rename(from, to);
    publications.push(JSON.parse(await fs.readFile(to, 'utf8')));
  } } }), actor = await f.claim();
  await joinBoth(actor);
  let count = 0;
  const result = await actor.perform(cap(actor), intent(), async ({ operation }) => {
    const disk = JSON.parse(await fs.readFile(actor.paths.slotPath, 'utf8'));
    const op = disk.operations.find(value => value.id === operation.id);
    assert.equal(validParentSlot(disk), true);
    assert.equal(disk.transaction.id, operation.id);
    assert.equal(op.preparedRevision > 0, true);
    assert.equal(op.status, 'DISPATCHED');
    assert.equal(disk.phase, 'RECOVERING');
    const prepared = publications.find(value => value.phase === 'PREPARED' && value.transaction.id === operation.id);
    assert.ok(prepared);
    assert.equal(prepared.operations.at(-1).status, 'PREPARED');
    count++;
    return { result: 'native-result', effects: Promise.resolve() };
  });
  assert.equal(result, 'native-result');
  assert.equal(count, 1);
  assert.equal(actor.snapshot.operations[0].status, 'SETTLED');
});

test('task5 custody invalidation observes exact persisted provenance before dispatch', async t => {
  const f = await fixture(t), actor = await f.claim();
  await joinBoth(actor);
  const entered = deferred(), acknowledged = deferred();
  let dispatched = 0, observed;
  const pending = actor.perform(cap(actor), intent(), async () => {
    dispatched++;
    return effect();
  }, async ({ operation }) => {
    observed = operation;
    entered.resolve();
    await acknowledged.promise;
  });
  pending.catch(() => {});
  try {
    await bounded(Promise.race([entered.promise, pending]));
    const disk = JSON.parse(await fs.readFile(actor.paths.slotPath, 'utf8'));
    assert.equal(dispatched, 0);
    assert.equal(observed.ownerNonce, disk.ownerNonce);
    assert.equal(observed.generation, disk.generation);
    assert.equal(observed.lifetimeId, disk.participants.todo.lifetimeId);
    assert.equal(observed.id, disk.transaction.id);
    assert.deepEqual(observed.target, intent().target);
    assert.equal(disk.operations.at(-1).status, 'DISPATCHED');
    acknowledged.resolve();
    await bounded(pending);
    assert.equal(dispatched, 1);
    assert.equal(actor.snapshot.operations.at(-1).status, 'SETTLED');
  } finally { acknowledged.resolve(); await Promise.allSettled([pending]); }
});

test('task5 rejected custody invalidation forbids dispatch and preserves inline fallback', async t => {
  const f = await fixture(t), actor = await f.claim();
  await joinBoth(actor);
  const refused = Object.assign(new Error('custody unavailable'), { code: 'CUSTODY_LOST' });
  let dispatched = 0;
  await assert.rejects(actor.perform(cap(actor), intent(), async () => {
    dispatched++;
    return effect();
  }, async () => { throw refused; }), error => error === refused);
  assert.equal(dispatched, 0);
  assert.equal(actor.inlineFallback, true);
  assert.equal(actor.snapshot.phase, 'BLOCKED');
  assert.equal(actor.snapshot.operations.at(-1).status, 'SETTLED');
  const disk = JSON.parse(await fs.readFile(actor.paths.slotPath, 'utf8'));
  assert.equal(disk.operations.at(-1).id, actor.snapshot.operations.at(-1).id);
  assert.equal(disk.operations.at(-1).status, 'DISPATCHED');
});

test('task5 release during pending custody invalidation prevents the queued effect', async t => {
  const f = await fixture(t), actor = await f.claim();
  await joinBoth(actor);
  const entered = deferred(), acknowledged = deferred();
  let dispatched = 0;
  const pending = actor.perform(cap(actor), intent(), async () => {
    dispatched++;
    return effect();
  }, async () => { entered.resolve(); await acknowledged.promise; });
  pending.catch(() => {});
  try {
    await bounded(Promise.race([entered.promise, pending]));
    const releasing = actor.release();
    const draining = Promise.all([actor.drain('todo', 'w-life'), actor.drain('dag', 'd-life')]);
    acknowledged.resolve();
    await assert.rejects(pending, { code: 'STALE_CAPABILITY', inlineFallback: true });
    await bounded(Promise.all([releasing, draining]));
    assert.equal(dispatched, 0);
    assert.equal(actor.snapshot.phase, 'RELEASED');
    assert.equal(actor.leaseHeld, false);
    assert.equal(actor.snapshot.operations.at(-1).status, 'SETTLED');
  } finally { acknowledged.resolve(); await Promise.allSettled([pending]); }
});

test('nonce revision generation lifetime and role capabilities reject before any effect', async t => {
  const f = await fixture(t), actor = await f.claim();
  await joinBoth(actor);
  const c = cap(actor);
  let effects = 0;
  for (const patch of [{ ownerNonce: 'old' }, { generation: 0 }, { revision: 0 },
    { lifetimeId: 'old' }, { participant: 'dag' }, { role: 'workers' }, { sessionId: 'old' }]) {
    await assert.rejects(actor.perform({ ...c, ...patch }, intent(), () => { effects++; return effect(); }),
      { code: 'STALE_CAPABILITY', inlineFallback: true });
  }
  assert.equal(effects, 0);
  await actor.perform(c, intent(), effect);
  await assert.rejects(actor.perform(c, intent(), effect), { code: 'STALE_CAPABILITY' });
});

test('wrong native birth tab producer and target membership block effects rather than allocate a slot', async t => {
  for (const field of ['birth', 'tab', 'producer', 'target']) {
    let changed = false;
    const f = await fixture(t, { observe: async ({ target }) => ({
      parent: changed && field === 'birth' ? { ...parent, shell: { ...parent.shell, birth: 'wrong' } } :
        changed && field === 'tab' ? { ...parent, tabId: 'wrong' } : parent,
      producer: changed && field === 'producer' ? { ...producer, birth: 'wrong' } : producer,
      target: changed && field === 'target' ? { ...target, tabId: 'wrong' } : target,
    }) });
    const actor = await f.claim(); await joinBoth(actor); changed = true;
    let effects = 0;
    await assert.rejects(actor.perform(cap(actor), intent(), () => { effects++; return effect(); }),
      { code: 'IDENTITY_MISMATCH', inlineFallback: true });
    assert.equal(effects, 0);
    assert.equal(actor.inlineFallback, true);
  }
});

test('publication failure keeps the lease, old bytes, inline availability and forbids layout effects', async t => {
  let fail = false;
  const f = await fixture(t, { fs: { ...fs, rename: async (...args) => {
    if (fail) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return fs.rename(...args);
  } } });
  const actor = await f.claim(); await joinBoth(actor);
  const prior = await fs.readFile(actor.paths.slotPath, 'utf8');
  fail = true;
  let effects = 0;
  await assert.rejects(actor.perform(cap(actor), intent(), () => { effects++; return effect(); }),
    { code: 'PUBLISH_FAILED', inlineFallback: true });
  assert.equal(effects, 0);
  assert.equal(actor.leaseHeld, true);
  assert.equal(actor.inlineFallback, true);
  assert.equal(await fs.readFile(actor.paths.slotPath, 'utf8'), prior);
  fail = false;
});

test('tampered published metadata is rejected at actual predispatch read', async t => {
  let tamper = false;
  const f = await fixture(t, { fs: { ...fs, rename: async (from, to) => {
    await fs.rename(from, to);
    if (tamper) await fs.writeFile(to, '{"schema":"corrupt"}');
  } } });
  const actor = await f.claim(); await joinBoth(actor); tamper = true;
  await assert.rejects(actor.perform(cap(actor), intent(), effect), { code: 'SLOT_CORRUPT' });
  tamper = false;
});

test('release invalidates queued actions and ACKs, waits exact late effects and both participant drains', async t => {
  const entered = deferred(), response = deferred(), late = deferred();
  t.after(() => { response.resolve(); late.resolve(); });
  const f = await fixture(t), actor = await f.claim();
  await joinBoth(actor);
  const c = cap(actor);
  const first = actor.perform(c, intent(), async () => {
    entered.resolve();
    await response.promise;
    return { result: 'result', effects: late.promise };
  });
  await bounded(entered.promise);
  const queued = actor.perform(c, intent(), effect);
  const queuedReject = assert.rejects(queued, { code: 'STALE_CAPABILITY' });
  const released = actor.release();
  let finished = false; released.then(() => { finished = true; });
  await assert.rejects(actor.perform(c, intent(), effect), { code: 'STALE_CAPABILITY' });
  await assert.rejects(actor.ackRole({ ...c, painted: true, sequence: 2 }), { code: 'STALE_CAPABILITY' });
  response.resolve();
  assert.equal(actor.leaseHeld, true);
  assert.equal(finished, false);
  const w = actor.drain('todo', 'w-life'), d = actor.drain('dag', 'd-life');
  late.resolve();
  await bounded(Promise.all([first, queuedReject, w, d, released]));
  assert.equal(actor.leaseHeld, false);
  assert.equal(actor.snapshot.phase, 'RELEASED');
  assert.equal(actor.snapshot.operations[0].status, 'SETTLED');
});

test('unknown effect blocks ownership until reconciled rather than replaying split', async t => {
  const f = await fixture(t, { observe: async ({ target, operation }) => ({
    parent, producer, target, effect: operation ? { id: operation.id, settled: true } : null,
  }) }), actor = await f.claim();
  await joinBoth(actor);
  await assert.rejects(actor.perform(cap(actor), intent(), async () => {
    throw Object.assign(new Error('lost real response'), { code: 'TRANSPORT_LOST' });
  }), { code: 'EFFECT_UNKNOWN' });
  assert.equal(actor.snapshot.phase, 'BLOCKED');
  assert.equal(actor.snapshot.operations[0].status, 'UNKNOWN');
  assert.equal(actor.inlineFallback, true);
  // A positive authoritative effect observation while the lease is held, not
  // a retry, settles it. Blocked release now closes the terminal actor; the
  // dedicated upgrade suite covers that separate stop/restart contract.
  await actor.reconcile(actor.snapshot.operations[0].id);
  assert.equal(actor.snapshot.operations[0].status, 'SETTLED');
  assert.equal(actor.blocked, false);
});

test('generation scoped manual closures reject stale roles and are not task payloads', async t => {
  const f = await fixture(t), actor = await f.claim(); await joinBoth(actor);
  const c = cap(actor);
  await actor.closeRole(c, { paneId: 'qa:todo', reason: 'q' });
  assert.equal(actor.snapshot.closures[0].generation, c.generation);
  assert.equal(actor.snapshot.closures[0].sessionId, c.sessionId);
  await assert.rejects(actor.closeRole(c, { paneId: 'qa:todo', reason: 'X' }), { code: 'STALE_CAPABILITY' });
});

test('malformed slot and non DELETE databases reject unchanged instead of deleting takeover files', async t => {
  const f = await fixture(t);
  const paths = await parentSlotPaths(f.options);
  await fs.mkdir(paths.directory, { recursive: true });
  await fs.writeFile(paths.slotPath, '{"tasks":["foreign"]}');
  await assert.rejects(f.claim(), { code: 'SLOT_CORRUPT', inlineFallback: true });
  assert.equal(await fs.readFile(paths.slotPath, 'utf8'), '{"tasks":["foreign"]}');
  await fs.rm(paths.slotPath);
  const db = new DatabaseSync(paths.leasePath, { timeout: 0 });
  db.exec('PRAGMA journal_mode = WAL'); db.close();
  await assert.rejects(f.claim(), { code: 'JOURNAL_MODE' });
});

test('independent processes compete through the shipped module and aliases with one graceful successor', async t => {
  const handles = [];
  t.after(async () => {
    for (const handle of handles) {
      if (handle.processChild.connected) handle.processChild.send({ type: 'release' });
      assert.equal((await bounded(handle.exit)).code, 0);
      assert.deepEqual(await bounded(handle.close), { stdoutEof: true, stderrEof: true });
    }
  });
  const f = await fixture(t);
  await fs.mkdir(f.options.stateDir);
  const alias = join(f.root, 'other-state-path');
  await fs.symlink(f.options.stateDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const script = `
    import { claimParentSlot } from ${JSON.stringify(new URL('../src/parent-slot.mjs', import.meta.url).href)};
    let actor;
    process.on('message', async message => {
      try {
        if (message.type === 'claim') {
          actor = await claimParentSlot({ ...message.options,
            observe: async ({ target }) => ({ parent: message.options.parent, producer: message.options.producer, target }) });
          process.send({ type: 'held', generation: actor.snapshot.generation });
        } else {
          await actor?.release();
          process.send({ type: 'released' });
          process.disconnect();
        }
      } catch (error) { process.send({ type: 'rejected', code: error.code, inlineFallback: error.inlineFallback }); }
    });
    process.send({ type: 'armed' });`;
  const child = () => {
    const processChild = spawn(process.execPath, ['--input-type=module', '--eval', script],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    const queue = [], waiters = [];
    processChild.on('message', message => { const waiter = waiters.shift(); if (waiter) waiter(message); else queue.push(message); });
    processChild.stdout.resume(); processChild.stderr.resume();
    const exit = new Promise(resolve => processChild.once('exit', (code, signal) => resolve({ code, signal })));
    const close = new Promise(resolve => processChild.once('close', () => resolve({
      stdoutEof: processChild.stdout.readableEnded, stderrEof: processChild.stderr.readableEnded,
    })));
    const handle = { processChild, exit, close,
      next: () => bounded(queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve))) };
    handles.push(handle);
    return handle;
  };
  const a = child(), b = child();
  await Promise.all([a.next(), b.next()]);
  const options = stateDir => ({ stateDir, socketPath: f.options.socketPath, parent, producer,
    sessionId: 'unit-process-fixture' });
  const ar = a.next(), br = b.next();
  a.processChild.send({ type: 'claim', options: options(f.options.stateDir) });
  b.processChild.send({ type: 'claim', options: options(alias) });
  const [am, bm] = await Promise.all([ar, br]);
  assert.deepEqual([am.type, bm.type].sort(), ['held', 'rejected']);
  const winner = am.type === 'held' ? a : b, loser = winner === a ? b : a;
  const refusal = winner === a ? bm : am;
  assert.equal(refusal.code, 'SQLITE_BUSY'); assert.equal(refusal.inlineFallback, true);
  const released = winner.next();
  winner.processChild.send({ type: 'release' });
  assert.equal((await released).type, 'released');
  await bounded(winner.close);
  const acquired = loser.next();
  loser.processChild.send({ type: 'claim', options: options(alias) });
  assert.deepEqual(await acquired, { type: 'held', generation: 2 });
});

test('task4 settling one unknown cannot unblock another submitted unknown effect', async t => {
  const f = await fixture(t, { observe: async ({ target, operation }) => ({
    parent, producer, target, effect: operation ? { id: operation.id, settled: true } : null,
  }) }), actor = await f.claim();
  await joinBoth(actor);
  const first = { id: 'first', ...cap(actor), type: 'split', target: parent, status: 'UNKNOWN',
    preparedRevision: actor.snapshot.revision };
  delete first.revision;
  const second = { ...first, id: 'second', type: 'run' };
  await actor.publish({ ...actor.snapshot, phase: 'BLOCKED', operations: [first, second] });
  actor.blocked = true;
  await actor.reconcile(first.id);
  assert.equal(actor.blocked, true);
  assert.equal(actor.snapshot.phase, 'BLOCKED');
  await assert.rejects(async () => actor.perform(cap(actor), intent(), effect));
  await actor.reconcile(second.id);
  assert.equal(actor.blocked, false);
});
