import * as filesystem from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const parentSlotSchema = 'omo-herdr-dashboard/parent-slot/2';
const actors = globalThis[Symbol.for(parentSlotSchema)] ??= new Map();
const roleOwner = { todo: 'todo', dag: 'dag', workers: 'dag' };
const phases = ['DISCOVER', 'CLAIMED', 'PREPARED', 'RECOVERING', 'READY', 'DRAINING', 'RELEASED', 'BLOCKED'];
const text = value => typeof value === 'string' && value.length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, required, optional = []) => object(value) &&
  required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const shell = value => keys(value, ['pid', 'birth']) && positive(value.pid) && text(value.birth);
const native = value => keys(value, ['pid', 'birth', 'executable', 'argvDigest']) &&
  shell({ pid: value.pid, birth: value.birth }) && text(value.executable) && digest(value.argvDigest);
const sameNative = (a, b) => a && b &&
  ['pid', 'birth', 'executable', 'argvDigest'].every(key => a[key] === b[key]);
const sameParent = (a, b) => a && b && a.paneId === b.paneId && a.tabId === b.tabId &&
  a.shell?.pid === b.shell?.pid && a.shell?.birth === b.shell?.birth;
const parentIdentity = value => keys(value, ['paneId', 'tabId', 'shell']) &&
  text(value.paneId) && text(value.tabId) && shell(value.shell);
const targetKeys = ['viewer', 'statePath', 'sourcePath', 'cachePath', 'prefsPath', 'launchToken', 'controlToken'];
const locatorKeys = ['statePath', 'sourcePath', 'cachePath', 'prefsPath'];
const targetIdentity = value => keys(value, ['paneId', 'tabId', 'shell'], targetKeys) &&
  parentIdentity({ paneId: value.paneId, tabId: value.tabId, shell: value.shell }) &&
  Object.keys(value).every(key => !targetKeys.includes(key) ||
    (key === 'viewer' ? native(value[key]) : text(value[key])));
const fail = (code, cause) => Object.assign(new Error(code, cause ? { cause } : undefined),
  { code, inlineFallback: true });
const keyFor = (socket, pane) => createHash('sha256').update(JSON.stringify([socket, pane])).digest('hex');

export function validParentSlot(value) {
  if (!keys(value, ['schema', 'layoutKey', 'canonicalStateDir', 'canonicalSocketPath', 'parent',
    'producer', 'ownerNonce', 'sessionId', 'generation', 'revision', 'phase', 'transaction',
    'participants', 'roles', 'locatorOwners', 'operations', 'closures']) ||
    value.schema !== parentSlotSchema || !text(value.canonicalStateDir) || !text(value.canonicalSocketPath) ||
    !parentIdentity(value.parent) || !native(value.producer) || !text(value.ownerNonce) || !text(value.sessionId) ||
    !positive(value.generation) || !positive(value.revision) || !phases.includes(value.phase) ||
    value.layoutKey !== keyFor(value.canonicalSocketPath, value.parent.paneId) ||
    !keys(value.transaction, ['id', 'phase']) || !text(value.transaction.id) ||
    value.transaction.phase !== value.phase || !object(value.participants) || !object(value.roles) ||
    !Array.isArray(value.locatorOwners) || !Array.isArray(value.operations) || !Array.isArray(value.closures)) return false;
  if (!value.locatorOwners.every(entry => keys(entry, ['path', 'sessionId']) &&
    text(entry.path) && text(entry.sessionId) && entry.path === canonical(resolve(entry.path))) ||
    new Set(value.locatorOwners.map(entry => entry.path)).size !== value.locatorOwners.length) return false;
  if (!Object.entries(value.participants).every(([name, participant]) =>
    ['todo', 'dag'].includes(name) && keys(participant, ['lifetimeId', 'drained']) &&
    text(participant.lifetimeId) && typeof participant.drained === 'boolean')) return false;
  if (!Object.entries(value.roles).every(([role, record]) =>
    Object.hasOwn(roleOwner, role) && keys(record, ['participant', 'lifetimeId', 'role', 'paneId', 'tabId', 'shell',
      'viewer', 'statePath', 'sourcePath', 'cachePath', 'prefsPath', 'launchToken', 'controlToken',
      'sessionId', 'generation', 'ack']) &&
    record.role === role && record.participant === roleOwner[role] && text(record.lifetimeId) &&
    targetIdentity(Object.fromEntries(['paneId', 'tabId', 'shell', ...targetKeys].map(key => [key, record[key]]))) &&
    record.tabId === value.parent.tabId && text(record.sessionId) && positive(record.generation) &&
    record.generation <= value.generation &&
    (record.ack === null || keys(record.ack, ['sequence', 'painted']) &&
      positive(record.ack.sequence) && typeof record.ack.painted === 'boolean' &&
      record.generation === value.generation && record.sessionId === value.sessionId &&
      value.participants[record.participant]?.lifetimeId === record.lifetimeId))) return false;
  if (!Object.values(value.roles).every(record => locatorKeys.every(key =>
    value.locatorOwners.some(entry => entry.path === canonical(resolve(record[key])) &&
      entry.sessionId === record.sessionId)))) return false;
  if (!value.operations.every(op => keys(op, ['id', 'ownerNonce', 'sessionId', 'generation', 'participant',
    'lifetimeId', 'role', 'type', 'target', 'status', 'preparedRevision']) &&
    text(op.id) && text(op.ownerNonce) && text(op.sessionId) && positive(op.generation) &&
    op.generation <= value.generation && roleOwner[op.role] === op.participant && text(op.lifetimeId) &&
    ['split', 'run', 'close', 'arrange', 'retire'].includes(op.type) && targetIdentity(op.target) &&
    op.target.tabId === value.parent.tabId && ['PREPARED', 'DISPATCHED', 'SETTLED', 'UNKNOWN'].includes(op.status) &&
    positive(op.preparedRevision) && op.preparedRevision <= value.revision)) return false;
  if (new Set(value.operations.map(op => op.id)).size !== value.operations.length) return false;
  if (!value.operations.every(op => op.generation !== value.generation ||
    op.ownerNonce === value.ownerNonce && op.sessionId === value.sessionId &&
    value.participants[op.participant]?.lifetimeId === op.lifetimeId)) return false;
  if (['PREPARED', 'RECOVERING'].includes(value.phase)) {
    const current = value.operations.find(op => op.id === value.transaction.id);
    if (!current || current.generation !== value.generation ||
      value.phase === 'PREPARED' && current.status !== 'PREPARED' ||
      value.phase === 'RECOVERING' && !['DISPATCHED', 'SETTLED'].includes(current.status)) return false;
  }
  if (!value.closures.every(closure => keys(closure, ['role', 'paneId', 'reason', 'sessionId', 'generation']) &&
    Object.hasOwn(roleOwner, closure.role) && text(closure.paneId) && ['q', 'X', 'pane_not_found'].includes(closure.reason) &&
    text(closure.sessionId) && positive(closure.generation) && closure.generation <= value.generation)) return false;
  if (value.phase === 'RELEASED' && (Object.values(value.participants).some(p => !p.drained) ||
    value.operations.some(op => op.status !== 'SETTLED'))) return false;
  if (value.phase === 'READY' && !Object.keys(roleOwner).every(role =>
    value.roles[role]?.ack?.painted === true && value.roles[role].generation === value.generation)) return false;
  return true;
}

const canonical = path => process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path;
export async function parentSlotPaths({ stateDir, socketPath, parent }) {
  if (!text(stateDir) || !text(socketPath) || !parentIdentity(parent)) throw fail('INVALID_BINDING');
  await filesystem.mkdir(resolve(stateDir), { recursive: true, mode: 0o700 });
  const canonicalStateDir = canonical(await filesystem.realpath(resolve(stateDir)));
  // A Windows named pipe has no filesystem realpath. Its namespace is case
  // insensitive; filesystem sockets resolve links and dot segments normally.
  const pipe = socketPath.replaceAll('/', '\\');
  const canonicalSocketPath = /^\\\\[.]\\pipe\\/i.test(pipe)
    ? canonical(pipe) : canonical(await filesystem.realpath(resolve(socketPath)));
  const layoutKey = keyFor(canonicalSocketPath, parent.paneId);
  const directory = join(canonicalStateDir, 'parent-slots', layoutKey);
  return { canonicalStateDir, canonicalSocketPath, layoutKey, directory,
    leasePath: join(directory, 'lease.sqlite'), slotPath: join(directory, 'slot.json') };
}

async function readSlot(fs, paths) {
  let value;
  try { value = JSON.parse(await fs.readFile(paths.slotPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw fail('SLOT_CORRUPT', error); }
  if (!validParentSlot(value) || value.layoutKey !== paths.layoutKey ||
    value.canonicalStateDir !== paths.canonicalStateDir || value.canonicalSocketPath !== paths.canonicalSocketPath) {
    throw fail('SLOT_CORRUPT');
  }
  return value;
}

function openLease(paths) {
  let db;
  try {
    db = new DatabaseSync(paths.leasePath, { timeout: 0 });
    db.exec('PRAGMA busy_timeout = 0');
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') throw fail('JOURNAL_MODE');
    db.exec('BEGIN IMMEDIATE');
    return db;
  } catch (error) {
    db?.close();
    if (error.errcode === 5) throw fail('SQLITE_BUSY', error);
    throw error.inlineFallback ? error : fail('LEASE_FAILED', error);
  }
}

// observe is an authoritative native boundary, not a liveness heuristic.
// It returns {parent, producer, target}, and, for reconciliation, an exact
// {effect: {id, settled:true}} observation. observePrevious must report the
// exact recorded native identity and witnessed death; unknown is not death.
export async function claimParentSlot(options) {
  const paths = await parentSlotPaths(options);
  if (!native(options.producer) || !text(options.sessionId) || typeof options.observe !== 'function') {
    throw fail('INVALID_BINDING');
  }
  const actorKey = `${paths.canonicalStateDir}:${paths.layoutKey}`;
  const existing = actors.get(actorKey);
  if (existing) {
    const actor = await existing;
    if (!sameParent(options.parent, actor.snapshot.parent)) throw fail('PARENT_MISMATCH');
    if (!sameNative(options.producer, actor.snapshot.producer) || options.sessionId !== actor.snapshot.sessionId ||
      actor.draining || !actor.leaseHeld) throw fail('LIVE_INCUMBENT');
    return actor;
  }
  const pending = (async () => {
    const fs = options.fs ?? filesystem;
    await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const db = openLease(paths);
    try {
      const previous = await readSlot(fs, paths);
      if (previous && !sameParent(previous.parent, options.parent)) throw fail('PARENT_MISMATCH');
      if (previous && previous.phase !== 'RELEASED') {
        const observation = await options.observePrevious?.(structuredClone(previous.producer));
        if (!sameNative(previous.producer, observation?.identity) || observation.state !== 'dead') throw fail('LIVE_INCUMBENT');
        if (previous.operations.some(op => op.status !== 'SETTLED')) throw fail('EFFECT_UNKNOWN');
      }
      const observation = await options.observe({ parent: options.parent, producer: options.producer });
      if (!sameParent(observation?.parent, options.parent) || !sameNative(observation?.producer, options.producer)) {
        throw fail('IDENTITY_MISMATCH');
      }
      const actor = new ParentSlot({ paths, db, fs, options, actorKey, previous });
      await actor.publish({ ...actor.record, phase: 'DISCOVER' });
      await actor.publish({ ...actor.record, phase: 'CLAIMED' });
      return actor;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  })();
  actors.set(actorKey, pending);
  try { return await pending; }
  catch (error) { if (actors.get(actorKey) === pending) actors.delete(actorKey); throw error; }
}

class ParentSlot {
  constructor({ paths, db, fs, options, actorKey, previous }) {
    Object.assign(this, { paths, db, fs, observe: options.observe, actorKey });
    this.tail = Promise.resolve();
    this.epoch = 0;
    this.draining = false;
    this.blocked = false;
    this.releasing = null;
    this.drainChanged = () => {};
    this.record = { schema: parentSlotSchema, layoutKey: paths.layoutKey,
      canonicalStateDir: paths.canonicalStateDir, canonicalSocketPath: paths.canonicalSocketPath,
      parent: structuredClone(options.parent), producer: structuredClone(options.producer), ownerNonce: randomUUID(),
      sessionId: options.sessionId, generation: (previous?.generation ?? 0) + 1,
      revision: previous?.revision ?? 0, phase: 'DISCOVER',
      transaction: { id: randomUUID(), phase: 'DISCOVER' }, participants: {},
      roles: Object.fromEntries(Object.entries(previous?.roles ?? {}).map(([role, record]) =>
        [role, { ...record, ack: null }])), locatorOwners: previous?.locatorOwners ?? [],
      operations: previous?.operations ?? [], closures: previous?.closures ?? [] };
  }
  get snapshot() { return structuredClone(this.record); }
  get leaseHeld() { return this.db.isOpen && this.db.isTransaction; }
  get inlineFallback() { return this.blocked || this.draining || !this.leaseHeld || this.record.phase !== 'READY'; }
  enqueue(job) {
    const next = this.tail.then(job);
    this.tail = next.catch(() => {});
    return next;
  }
  async publish(candidate) {
    if (!this.leaseHeld) throw fail('LEASE_LOST');
    const next = structuredClone({ ...candidate, revision: this.record.revision + 1,
      transaction: { ...candidate.transaction, phase: candidate.phase } });
    if (!validParentSlot(next) ||
      !same(next.locatorOwners.slice(0, this.record.locatorOwners.length), this.record.locatorOwners)) {
      throw fail('SLOT_CORRUPT');
    }
    const temporary = `${this.paths.slotPath}.${this.record.ownerNonce}.pending`;
    let file;
    try {
      file = await this.fs.open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify(next));
      await file.sync();
      await file.close(); file = null;
      await this.fs.rename(temporary, this.paths.slotPath);
      // Flush the rename's directory entry on filesystem-socket platforms.
      if (process.platform !== 'win32') {
        const directory = await this.fs.open(dirname(this.paths.slotPath), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      this.record = next;
    } catch (error) {
      this.blocked = true;
      throw fail('PUBLISH_FAILED', error);
    } finally {
      if (file) await file.close();
      await this.fs.rm(temporary, { force: true });
    }
  }
  capability(participant, role) {
    const entry = this.record.participants[participant];
    if (!entry || entry.drained || roleOwner[role] !== participant || this.draining || this.blocked || !this.leaseHeld) {
      throw fail('STALE_CAPABILITY');
    }
    return { ownerNonce: this.record.ownerNonce, sessionId: this.record.sessionId, generation: this.record.generation,
      revision: this.record.revision, participant, lifetimeId: entry.lifetimeId, role };
  }
  check(capability, epoch) {
    if (epoch !== this.epoch || this.draining || this.blocked || !this.leaseHeld ||
      !['ownerNonce', 'sessionId', 'generation', 'revision'].every(key => capability?.[key] === this.record[key]) ||
      !text(capability.lifetimeId) || this.record.participants[capability.participant]?.lifetimeId !== capability.lifetimeId ||
      this.record.participants[capability.participant]?.drained || roleOwner[capability.role] !== capability.participant) {
      throw fail('STALE_CAPABILITY');
    }
  }
  async validateTarget(target, operation) {
    const observation = await this.observe({ parent: this.record.parent, producer: this.record.producer, target, operation });
    if (!sameParent(observation?.parent, this.record.parent) || !sameNative(observation?.producer, this.record.producer) ||
      target && (!targetIdentity(target) || !same(target, observation?.target))) {
      this.blocked = true;
      this.epoch++;
      throw fail('IDENTITY_MISMATCH');
    }
    return observation;
  }
  join(participant, lifetimeId) {
    return this.enqueue(async () => {
      if (!['todo', 'dag'].includes(participant) || !text(lifetimeId) || this.draining || this.blocked || !this.leaseHeld) {
        throw fail('STALE_CAPABILITY');
      }
      const current = this.record.participants[participant];
      if (current && (current.lifetimeId !== lifetimeId || current.drained)) throw fail('PARTICIPANT_LIVE');
      if (!current) await this.publish({ ...this.record,
        participants: { ...this.record.participants, [participant]: { lifetimeId, drained: false } } });
    });
  }
  perform(capability, intent, dispatch, beforeDispatch) {
    if (this.draining || this.blocked || !this.leaseHeld) return Promise.reject(fail('STALE_CAPABILITY'));
    const epoch = this.epoch;
    const selected = structuredClone({ capability, intent });
    return this.enqueue(async () => {
      this.check(selected.capability, epoch);
      if (!keys(selected.intent, ['type', 'target']) ||
        !['split', 'run', 'close', 'arrange', 'retire'].includes(selected.intent.type) ||
        !targetIdentity(selected.intent.target) || typeof dispatch !== 'function' ||
        beforeDispatch !== undefined && typeof beforeDispatch !== 'function') throw fail('INVALID_INTENT');
      await this.validateTarget(selected.intent.target);
      this.check(selected.capability, epoch);
      const operation = { id: randomUUID(), ...selected.capability, type: selected.intent.type,
        target: selected.intent.target, status: 'PREPARED', preparedRevision: this.record.revision + 1 };
      delete operation.revision;
      try {
        await this.publish({ ...this.record, phase: 'PREPARED', transaction: { id: operation.id },
          operations: [...this.record.operations, operation],
          roles: Object.fromEntries(Object.entries(this.record.roles).map(([role, record]) =>
            [role, record.ack && (role === selected.capability.role || selected.intent.type === 'arrange')
              ? { ...record, ack: { ...record.ack, painted: false } } : record])) });
        if (epoch !== this.epoch) throw fail('STALE_CAPABILITY');
        await this.publish({ ...this.record, phase: 'RECOVERING',
          operations: this.record.operations.map(op => op.id === operation.id ? { ...op, status: 'DISPATCHED' } : op) });
        const persisted = await readSlot(this.fs, this.paths);
        if (!same(persisted, this.record)) throw fail('SLOT_CORRUPT');
        await beforeDispatch?.({ operation: structuredClone(operation) });
        await this.validateTarget(operation.target);
        if (epoch !== this.epoch) throw fail('STALE_CAPABILITY');
        if (!this.leaseHeld) throw fail('LEASE_LOST');
      } catch (error) {
        this.blocked = true;
        // No dispatch occurred on this branch. Keep its positive no-effect
        // fact for cooperative drain even if publication itself is unavailable.
        this.record = { ...this.record, phase: 'BLOCKED', transaction: { ...this.record.transaction, phase: 'BLOCKED' },
          operations: this.record.operations.map(op => op.id === operation.id ? { ...op, status: 'SETTLED' } : op) };
        throw error;
      }
      // The command reply is not effect settlement. Callers must provide an
      // independently subscribed completion promise covering every late effect.
      try {
        const dispatched = await dispatch({ operation: structuredClone(operation) });
        if (!dispatched || typeof dispatched.effects?.then !== 'function') throw fail('EFFECT_UNKNOWN');
        await dispatched.effects;
        await this.settle(operation.id, 'SETTLED');
        return dispatched.result;
      } catch (error) {
        this.blocked = true;
        await this.settle(operation.id, 'UNKNOWN', 'BLOCKED');
        throw fail('EFFECT_UNKNOWN', error);
      }
    });
  }
  settle(id, status, phase = this.record.phase) {
    return this.publish({ ...this.record, phase,
      operations: this.record.operations.map(op => op.id === id ? { ...op, status } : op) });
  }
  registerRole(capability, record) {
    if (this.draining || this.blocked || !this.leaseHeld) return Promise.reject(fail('STALE_CAPABILITY'));
    const epoch = this.epoch, selected = structuredClone({ capability, record });
    return this.enqueue(async () => {
      this.check(selected.capability, epoch);
      const c = selected.capability, r = selected.record;
      const oldPaths = this.record.locatorOwners.filter(entry => entry.sessionId !== c.sessionId).map(entry => entry.path);
      if (!keys(r, ['paneId', 'tabId', 'shell', ...targetKeys]) || !targetIdentity(r) ||
        r.tabId !== this.record.parent.tabId ||
        locatorKeys.some(key => oldPaths.includes(canonical(resolve(r[key])))) ||
        Object.entries(this.record.roles).some(([role, entry]) => role !== c.role && entry.paneId === r.paneId)) {
        throw fail('ROLE_MISMATCH');
      }
      await this.validateTarget(r);
      this.check(c, epoch);
      const locatorOwners = [...this.record.locatorOwners];
      for (const key of locatorKeys) {
        const path = canonical(resolve(r[key]));
        if (!locatorOwners.some(entry => entry.path === path)) locatorOwners.push({ path, sessionId: c.sessionId });
      }
      const previous = this.record.roles[c.role];
      await this.publish({ ...this.record, phase: this.record.phase === 'READY' ? 'CLAIMED' : this.record.phase,
        roles: { ...this.record.roles, [c.role]: { ...r,
        role: c.role, participant: c.participant, lifetimeId: c.lifetimeId,
        sessionId: c.sessionId, generation: c.generation,
        ack: previous?.generation === c.generation && previous.ack
          ? { sequence: previous.ack.sequence, painted: false } : null } }, locatorOwners });
    });
  }
  ackRole(message) {
    if (this.draining || this.blocked || !this.leaseHeld) return Promise.reject(fail('STALE_CAPABILITY'));
    const epoch = this.epoch, selected = structuredClone(message);
    return this.enqueue(async () => {
      this.check(selected, epoch);
      const record = this.record.roles[selected.role];
      if (!record || !['paneId', 'statePath', 'launchToken', 'controlToken'].every(key => selected[key] === record[key]) ||
        record.generation !== selected.generation || record.sessionId !== selected.sessionId ||
        selected.painted !== true || !positive(selected.sequence) ||
        selected.sequence <= (record.ack?.sequence ?? 0)) throw fail('ACK_MISMATCH');
      const target = Object.fromEntries(['paneId', 'tabId', 'shell', ...targetKeys].map(key => [key, record[key]]));
      await this.validateTarget(target);
      this.check(selected, epoch);
      await this.publish({ ...this.record, roles: { ...this.record.roles, [selected.role]:
        { ...record, ack: { sequence: selected.sequence, painted: true } } } });
    });
  }
  ready() {
    return this.enqueue(async () => {
      if (this.draining || this.blocked || !this.leaseHeld || !['CLAIMED', 'RECOVERING'].includes(this.record.phase) ||
        this.record.operations.some(op => op.status !== 'SETTLED') ||
        !Object.keys(roleOwner).every(role => this.record.roles[role]?.ack?.painted &&
          this.record.roles[role].generation === this.record.generation &&
          this.record.roles[role].sessionId === this.record.sessionId &&
          this.record.participants[roleOwner[role]]?.lifetimeId === this.record.roles[role].lifetimeId &&
          !this.record.participants[roleOwner[role]].drained)) throw fail('ROLES_NOT_READY');
      await this.validateTarget();
      for (const record of Object.values(this.record.roles)) {
        await this.validateTarget(Object.fromEntries(['paneId', 'tabId', 'shell', ...targetKeys].map(key => [key, record[key]])));
      }
      if (this.draining) throw fail('STALE_CAPABILITY');
      await this.publish({ ...this.record, phase: 'READY' });
    });
  }
  closeRole(capability, closure) {
    if (this.draining || this.blocked || !this.leaseHeld) return Promise.reject(fail('STALE_CAPABILITY'));
    const epoch = this.epoch, selected = structuredClone({ capability, closure });
    return this.enqueue(async () => {
      this.check(selected.capability, epoch);
      if (!keys(selected.closure, ['paneId', 'reason']) || !text(selected.closure.paneId) ||
        !['q', 'X', 'pane_not_found'].includes(selected.closure.reason)) throw fail('CLOSURE_MISMATCH');
      await this.publish({ ...this.record, closures: [...this.record.closures,
        { ...selected.closure, role: selected.capability.role, sessionId: this.record.sessionId,
          generation: this.record.generation }] });
    });
  }
  reconcile(id) {
    return this.enqueue(async () => {
      const operation = this.record.operations.find(op => op.id === id);
      if (!this.leaseHeld || !operation || operation.status !== 'UNKNOWN') throw fail('OPERATION_MISMATCH');
      const observation = await this.observe({ parent: this.record.parent, producer: this.record.producer,
        target: operation.target, operation });
      if (!sameParent(observation?.parent, this.record.parent) || !sameNative(observation?.producer, this.record.producer) ||
        !(same(operation.target, observation?.target) || operation.type === 'close' &&
          same(operation.target, observation?.retiredTarget) && observation.missing?.code === 'pane_not_found' &&
          observation.missing.paneId === operation.target.paneId)) throw fail('IDENTITY_MISMATCH');
      if (observation.effect?.id !== id || observation.effect.settled !== true) throw fail('EFFECT_UNKNOWN');
      const unresolved = this.record.operations.some(op => op.id !== id && op.status !== 'SETTLED');
      await this.settle(id, 'SETTLED', unresolved ? 'BLOCKED' :
        this.record.transaction.id === id ? 'RECOVERING' : 'CLAIMED');
      this.blocked = unresolved;
    });
  }
  obsoleteLocator(capability, record) {
    const epoch = this.epoch, selected = structuredClone({ capability, record });
    return this.enqueue(async () => {
      this.check(selected.capability, epoch);
      const r = selected.record;
      if (r.role !== selected.capability.role || !text(r.paneId) || !text(r.sessionId) ||
        r.parentPaneId !== this.record.parent.paneId || r.tabId !== this.record.parent.tabId)
        throw fail('CLOSURE_MISMATCH');
      const observation = await this.observe({ parent: this.record.parent, producer: this.record.producer, locator: r });
      if (!sameParent(observation?.parent, this.record.parent) || !sameNative(observation?.producer, this.record.producer) ||
        observation.missing?.code !== 'pane_not_found' || observation.missing.paneId !== r.paneId)
        throw fail('CLOSURE_MISMATCH');
      this.check(selected.capability, epoch);
      if (this.record.closures.some(entry => entry.role === r.role && entry.paneId === r.paneId &&
        entry.sessionId === r.sessionId && entry.reason === 'pane_not_found')) return;
      const locatorOwners = [...this.record.locatorOwners];
      for (const key of locatorKeys) if (text(r[key])) {
        const path = canonical(resolve(r[key])), old = locatorOwners.find(entry => entry.path === path);
        if (old && old.sessionId !== r.sessionId) throw fail('ROLE_MISMATCH');
        if (!old) locatorOwners.push({ path, sessionId: r.sessionId });
      }
      await this.publish({ ...this.record, locatorOwners, closures: [...this.record.closures,
        { role: r.role, paneId: r.paneId, reason: 'pane_not_found', sessionId: r.sessionId, generation: this.record.generation }] });
    });
  }
  drain(participant, lifetimeId) {
    return this.enqueue(async () => {
      if (!this.leaseHeld && this.record.phase === 'RELEASED') return;
      const current = this.record.participants[participant];
      if (!current || current.lifetimeId !== lifetimeId) throw fail('STALE_CAPABILITY');
      if (!current.drained) await this.publish({ ...this.record,
        participants: { ...this.record.participants, [participant]: { ...current, drained: true } } });
      this.drainChanged();
    });
  }
  release() {
    if (!this.leaseHeld && this.record.phase === 'RELEASED') return Promise.resolve();
    if (this.releasing) return this.releasing;
    this.draining = true;
    this.epoch++;
    const begin = this.enqueue(async () => {
      if (this.record.operations.some(op => op.status !== 'SETTLED')) throw fail('EFFECT_UNKNOWN');
      await this.publish({ ...this.record, phase: 'DRAINING' });
    });
    this.releasing = begin.then(async () => {
      while (Object.values(this.record.participants).some(p => !p.drained)) {
        // Installed before yielding; drain jobs run on the actor queue.
        await new Promise(resolve => { this.drainChanged = resolve; });
      }
      await this.enqueue(async () => {
        await this.publish({ ...this.record, phase: 'RELEASED' });
        this.db.exec('ROLLBACK');
        this.db.close();
        actors.delete(this.actorKey);
      });
    }).catch(error => { this.releasing = null; throw error; });
    return this.releasing;
  }
}
