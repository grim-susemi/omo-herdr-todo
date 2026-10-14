import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TodoPane, readRoleState } from '../src/controller.mjs';
import { claimParentSlot } from '../src/parent-slot.mjs';

test('managed refresh reopens verified q/X-closed retained roles without refreshing dead panes',
  { timeout: 10000 }, async t => {
    const directory = join(tmpdir(), `todo-reopen-${process.pid}-${randomUUID()}`);
    console.log(JSON.stringify({ event: 'resource-planned', pid: process.pid, directory }));
    await mkdir(directory);
    const events = new EventEmitter(), subscriptions = new AbortController();
    const signal = () => AbortSignal.any([subscriptions.signal, AbortSignal.timeout(2000)]);
    const socketPath = join(directory, 'logical-herdr'), sessionId = 'reopen-current';
    const parent = { paneId: 'qa:parent', tabId: 'qa:tab', shell: { pid: 7100, birth: 'parent-birth' } };
    const producer = { pid: process.pid, birth: 'producer-birth', executable: process.execPath,
      argvDigest: createHash('sha256').update('reopen-fixture').digest('hex') };
    const owner = new TodoPane({
      ctx: { sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(directory, 'current.jsonl') } },
      environment: { HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: parent.paneId },
      stateDir: directory, cwd: directory, node: process.execPath,
      viewer: join(directory, 'todo-viewer.mjs'), managed: true,
    });
    const panes = new Map([[parent.paneId, { pane_id: parent.paneId, tab_id: parent.tabId }]]);
    const rows = new Map([[parent.shell.pid, [{ ProcessId: parent.shell.pid, Birth: parent.shell.birth,
      ExecutablePath: 'powershell.exe', CommandLine: 'powershell.exe', CreationDate: '2026-10-14T00:00:00.000Z' }]],
      [process.pid, [{ ProcessId: process.pid, ParentProcessId: parent.shell.pid, Birth: producer.birth,
        ExecutablePath: process.execPath, CommandLine: 'reopen-fixture', CreationDate: '2026-10-14T00:00:00.000Z' }]]]);
    const records = new Map(), calls = [], registrations = new Map();
    let actor, nextPane = 0, extraPanes = [], getError;
    owner.scopeEpoch = 1;
    owner.storage = { path: join(owner.directory, 'scope-1', 'todo.cache.json') };
    owner.bridge = { readinessChanged() {}, invalidate() {} };
    owner.presence = {
      idle: async () => {},
      offer: role => ({ v: 1, ...owner.binding, role, scopeEpoch: 1 }),
      rotateRole: role => ({ v: 1, ...owner.binding, role, scopeEpoch: 1 }),
    };
    owner.inspectShell = async pid => rows.get(pid) ?? [];
    owner.watchRecoveryMembership = async () => {};
    await mkdir(owner.directory, { recursive: true });
    t.after(async () => {
      subscriptions.abort();
      await owner.tail; await owner.managedIdle(); await owner.roleTail;
      owner.stopped = true; owner.stopSignal.abort();
      await actor?.tail;
      if (actor?.leaseHeld) {
        for (const [participant, entry] of Object.entries(actor.snapshot.participants))
          if (!entry.drained) await actor.drain(participant, entry.lifetimeId);
        await actor.release();
      }
      assert.equal(actor?.db.isOpen ?? false, false);
      await rm(directory, { recursive: true, force: true });
      await assert.rejects(access(directory), { code: 'ENOENT' });
      console.log(JSON.stringify({ event: 'resource-cleaned', pid: process.pid, directory,
        sqliteClosed: true, directoryAbsent: true, nativeResourcesCreated: false }));
    });

    const makeRecord = (role, paneId, shellPid, launchToken) => {
      const statePath = role === 'todo' ? owner.stateFile : join(owner.directory, `${role}.state.json`);
      return { schema: 'omo-herdr-dashboard/pane/1', ...owner.binding, role, paneId,
        tabId: parent.tabId, scopeEpoch: 1, launchToken, statePath, viewerPath: owner.viewer,
        nodePath: process.execPath, creationProcessId: shellPid, creationDate: '2026-10-14T00:00:00.000Z',
        creationBirth: `shell-${shellPid}`, prepared: true, ready: false, manualClose: false };
    };
    const launch = record => {
      const argv = [record.nodePath, record.viewerPath, '--state', record.statePath,
        '--close-pane', record.paneId, '--launch-token', record.launchToken];
      const pid = record.creationProcessId + 1000;
      rows.get(record.creationProcessId).push({ ProcessId: pid, ParentProcessId: record.creationProcessId,
        Birth: `viewer-${pid}`, ExecutablePath: process.execPath,
        CommandLine: argv.map(value => `"${value}"`).join(' '), CreationDate: '2026-10-14T00:00:01.000Z', argv });
      return { ...record, processId: pid, viewerBirth: `viewer-${pid}`, ready: true };
    };
    const shell = (paneId, pid) => {
      panes.set(paneId, { pane_id: paneId, tab_id: parent.tabId, shellPid: pid });
      rows.set(pid, [{ ProcessId: pid, Birth: `shell-${pid}`, ExecutablePath: 'powershell.exe',
        CommandLine: 'powershell.exe', CreationDate: '2026-10-14T00:00:00.000Z' }]);
    };
    const target = async record => {
      const member = await owner.membership(record.paneId);
      assert.equal(member.tabId, record.tabId);
      return { paneId: record.paneId, tabId: record.tabId,
        shell: { pid: record.creationProcessId, birth: record.creationBirth },
        ...(record.processId ? { viewer: { pid: record.processId, birth: record.viewerBirth,
          executable: process.execPath, argvDigest: createHash('sha256')
            .update(rows.get(record.creationProcessId)[1].CommandLine).digest('hex') } } : {}),
        statePath: record.statePath, sourcePath: join(directory, 'current.jsonl'),
        cachePath: `${record.statePath}.cache.json`, prefsPath: `${record.statePath}.view.json`,
        launchToken: record.launchToken, controlToken: owner.controlToken };
    };
    // The native CLI, viewer launch receipts and D provider are logical boundaries.
    // W schedule/ensureTodo/native observation, SQLite publication and mutation
    // authorization remain real; every effect subscription precedes dispatch.
    owner.herdr = async (...args) => {
      calls.push(args);
      if (args[0] === 'list') return { panes: [...panes.values(), ...extraPanes] };
      if (args[0] === 'get') {
        if (getError) throw getError;
        if (!panes.has(args[1])) throw Object.assign(new Error('Exact native absence'), { code: 'pane_not_found' });
        return { pane: panes.get(args[1]) };
      }
      if (args[0] === 'process-info') {
        const pid = args[2] === parent.paneId ? parent.shell.pid : panes.get(args[2])?.shellPid;
        const values = rows.get(pid) ?? [], child = values[1];
        return { process_info: { pane_id: args[2], shell_pid: pid,
          foreground_processes: child ? [{ pid: child.ProcessId, argv: child.argv }] :
            [{ pid, argv: ['powershell.exe'] }] } };
      }
      if (args[0] === 'close') {
        panes.delete(args[1]); events.emit(`closed:${args[1]}`); return {};
      }
      if (args[0] === 'split') {
        assert.ok(panes.has(args[args.indexOf('--pane') + 1]));
        const paneId = `qa:reopened${++nextPane}`;
        shell(paneId, 7300 + nextPane);
        return { pane: { pane_id: paneId } };
      }
      if (args[0] === 'run') {
        const prepared = args[1] === records.get('workers')?.paneId ? records.get('workers') :
          JSON.parse(await readFile(owner.recordFile, 'utf8'));
        const record = launch(prepared);
        records.set(record.role, record);
        if (record.role === 'todo') {
          await writeFile(owner.recordFile, JSON.stringify(record));
          await writeFile(owner.stateFile, JSON.stringify(owner.roleState(record)));
        }
        const registration = owner.registerManagedRole(record.role, () => record.role === 'todo' ?
          owner.nativePane(record.paneId, record) : target(record));
        registrations.set(record.role, registration);
        if (record.role === 'todo') {
          owner.launchRegistrations.set(record.launchToken, registration);
          owner.events.emit(`created:${record.launchToken}`, record.paneId);
        }
        return {};
      }
      throw new Error(`Unexpected native command: ${args[0]}`);
    };
    owner.mutate = (role, type, selected, args, effect) => {
      const completed = once(events, `effect:${role}:${type}`, { signal: signal() });
      return owner.perform(role, type, selected, async () => {
        const result = await owner.herdr(...args);
        events.emit(`effect:${role}:${type}`);
        return { result, effects: effect ? Promise.all([completed, effect]) : completed };
      });
    };
    owner.provider = {
      lifetimeId: 'reopen-dag-lifetime', sourceReady: Promise.resolve(),
      observeTarget: selected => target([...records.values()].find(record => record.paneId === selected.paneId)),
      setOffers: async () => {},
      async openPair({ force, forceRoles }) {
        let workers = records.get('workers');
        if (!panes.has(workers.paneId) && force && forceRoles.includes('workers')) {
          assert.ok(actor.snapshot.closures.some(entry => entry.role === 'workers' &&
            entry.paneId === workers.paneId && entry.sessionId === workers.sessionId));
          const split = await owner.mutate('workers', 'split', await target(records.get('dag')),
            ['split', '--pane', records.get('dag').paneId, '--no-focus']);
          workers = makeRecord('workers', split.pane.pane_id, panes.get(split.pane.pane_id).shellPid, 'new-workers-token');
          records.set('workers', workers);
          await owner.mutate('workers', 'run', await target(workers), ['run', workers.paneId, 'logical-worker-launch']);
          await registrations.get('workers');
        }
        return { dag: records.get('dag'), workers: records.get('workers') };
      },
    };
    await writeFile(socketPath, 'synthetic native marker');
    const options = { stateDir: directory, socketPath, parent, producer, sessionId,
      observe: request => owner.observeManaged(request) };
    actor = await claimParentSlot({ ...options, sessionId: 'reopen-prior' });
    await actor.release();
    actor = await claimParentSlot(options);
    owner.actor = actor;
    await actor.join('todo', owner.lifetimeId);
    await actor.join('dag', owner.provider.lifetimeId);
    owner.publisherScope = Object.freeze({ ownerNonce: actor.snapshot.ownerNonce, generation: actor.snapshot.generation,
      sessionId, lifetimeId: owner.lifetimeId, parent, producer });
    for (const [index, role] of ['todo', 'dag', 'workers'].entries()) {
      const paneId = `qa:${role}`, shellPid = 7200 + index;
      shell(paneId, shellPid);
      const record = launch(makeRecord(role, paneId, shellPid, `old-${role}-token`));
      records.set(role, record);
      if (role === 'todo') {
        await writeFile(owner.recordFile, JSON.stringify(record));
        await writeFile(owner.stateFile, JSON.stringify(owner.roleState(record)));
      }
      await owner.registerManagedRole(role, () => role === 'todo' ? owner.nativePane(paneId, record) : target(record));
    }
    assert.equal(actor.snapshot.generation, 2);
    const originalRoles = actor.snapshot.roles;
    const qClosed = once(events, 'closed:qa:todo', { signal: signal() });
    await owner.coordinator().closeRole('todo', 'qa:todo');
    await writeFile(owner.recordFile, JSON.stringify({ ...records.get('todo'), manualClose: true }));
    await owner.mutate('todo', 'close', await owner.nativePane('qa:todo', records.get('todo')), ['close', 'qa:todo']);
    await qClosed;
    const xClosed = once(events, 'closed:qa:workers', { signal: signal() });
    await owner.herdr('close', 'qa:workers');
    await xClosed;
    await owner.managedWrite(current => current.obsoleteLocator(current.capability('dag', 'workers'), records.get('workers')));
    const closures = actor.snapshot.closures, operations = actor.snapshot.operations;
    assert.deepEqual(closures.map(entry => [entry.role, entry.reason]), [['todo', 'q'], ['workers', 'pane_not_found']]);
    assert.deepEqual(actor.snapshot.roles, originalRoles);
    const beforeMutations = calls.filter(args => ['split', 'run', 'close'].includes(args[0])).length;
    const reopen = () => owner.schedule({ forceRoles: ['todo', 'workers'] });
    for (const fault of ['no-closure', 'foreign-closure', 'unknown-membership', 'ambiguous-parent', 'foreign-tab', 'ambiguous-target']) {
      if (fault === 'no-closure' || fault === 'foreign-closure') {
        const snapshot = actor.snapshot;
        owner.actor = new Proxy(actor, { get(selected, key) {
          return key === 'snapshot' ? { ...snapshot, closures: fault === 'no-closure' ? [] :
            closures.map(entry => ({ ...entry, sessionId: 'foreign-session' })) } : Reflect.get(selected, key);
        } });
      } else if (fault === 'unknown-membership') getError = Object.assign(new Error('Unverified native error'), { code: 'invalid_request' });
      else if (fault === 'ambiguous-parent') extraPanes = [panes.get(parent.paneId)];
      else {
        panes.set('qa:todo', { pane_id: 'qa:todo', tab_id: fault === 'foreign-tab' ? 'foreign:tab' : parent.tabId });
        if (fault === 'ambiguous-target') extraPanes = [panes.get('qa:todo')];
      }
      try {
        await assert.rejects(reopen(), fault === 'unknown-membership' ? { code: 'invalid_request' } :
          /layout-waiting: missing or ambiguous owned anchor/);
        assert.deepEqual(actor.snapshot.closures, closures);
        assert.deepEqual(actor.snapshot.operations, operations);
        assert.equal(calls.filter(args => ['split', 'run', 'close'].includes(args[0])).length, beforeMutations);
      } finally {
        owner.actor = actor; getError = undefined; extraPanes = []; panes.delete('qa:todo');
      }
    }

    const publish = actor.publish.bind(actor), replacements = new Set();
    actor.publish = async candidate => {
      await publish(candidate);
      for (const role of ['todo', 'workers']) if (!replacements.has(role) &&
        actor.snapshot.roles[role].paneId !== originalRoles[role].paneId) {
        replacements.add(role); events.emit(`replacement:${role}`, actor.snapshot.roles[role]);
      }
    };
    const todoPublished = once(events, 'replacement:todo', { signal: signal() });
    const workersPublished = once(events, 'replacement:workers', { signal: signal() });
    const mutationStart = calls.length;
    await reopen();
    const [todo] = await todoPublished, [workers] = await workersPublished;
    for (const [role, replacement] of [['todo', todo], ['workers', workers]]) {
      assert.notEqual(replacement.paneId, originalRoles[role].paneId);
      assert.notDeepEqual(replacement.shell, originalRoles[role].shell);
      assert.notDeepEqual(replacement.viewer, originalRoles[role].viewer);
      assert.notEqual(replacement.launchToken, originalRoles[role].launchToken);
      assert.equal(replacement.sessionId, sessionId); assert.equal(replacement.generation, 2);
      assert.ok(panes.has(replacement.paneId));
    }
    assert.deepEqual(actor.snapshot.roles.dag.shell, originalRoles.dag.shell);
    assert.deepEqual(actor.snapshot.roles.dag.viewer, originalRoles.dag.viewer);
    assert.equal(actor.snapshot.roles.dag.paneId, originalRoles.dag.paneId);
    assert.deepEqual(actor.snapshot.closures.slice(0, closures.length), closures);
    assert.deepEqual(calls.slice(mutationStart).filter(args => ['split', 'run', 'close'].includes(args[0]))
      .map(args => args[0]), ['split', 'run', 'split', 'run']);
    assert.deepEqual(actor.snapshot.operations.slice(operations.length).map(op => [op.role, op.type, op.status]),
      [['workers', 'split', 'SETTLED'], ['workers', 'run', 'SETTLED'], ['todo', 'split', 'SETTLED'], ['todo', 'run', 'SETTLED']]);
    const saved = JSON.parse(await readFile(actor.paths.slotPath, 'utf8'));
    assert.deepEqual(saved.roles, actor.snapshot.roles);
    assert.deepEqual(saved.closures, actor.snapshot.closures);
    assert.equal((await readRoleState(owner.stateFile)).paneId, todo.paneId);
    assert.equal(JSON.parse(await readFile(owner.recordFile, 'utf8')).manualClose, false);
    console.log(JSON.stringify({ event: 'reopen-proof', pid: process.pid, nativeProof: false,
      refusalCases: 6, todo: todo.paneId, workers: workers.paneId, closures: saved.closures,
      reopenMutations: 4, operationsSettled: true }));
  });
