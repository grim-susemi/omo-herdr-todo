import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TodoPane, dashboardChannels, readRoleState, registerRoleViewer, requestRoleClose, viewerProcess, paneViewerProcess, canCleanupPane, parseLaunchCommand } from '../src/controller.mjs';
import net from 'node:net';
import extension from '../extension.mjs';
import * as dashboard from '../src/controller.mjs';
import { claimParentSlot } from '../src/parent-slot.mjs';

const snapshot = { type: 'custom', customType: 'senpi.todo-state', data: {
  schema: 'v2', phases: [{ name: 'Build', tasks: [{ content: 'Native work', status: 'in_progress' }] }],
} };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('previous producer death requires authoritative native inventory', async () => {
  const identity = { pid: 123, birth: 'original-birth', executable: 'node.exe', argvDigest: 'a'.repeat(64) };
  const controller = new TodoPane({ ctx: { sessionManager: { getSessionId: () => 'inventory-session' } },
    environment: { HERDR_SOCKET_PATH: 'synthetic-socket', HERDR_PANE_ID: 'qa:parent' },
    stateDir: tmpdir(), cwd: tmpdir(), viewer: 'viewer.mjs' });
  for (const rows of [[], [{ ProcessId: identity.pid, Birth: 'replacement-birth' }]]) {
    controller.inspectShell = async () => rows;
    assert.deepEqual(await controller.observePreviousProducer(identity), { identity, state: 'dead' });
  }
  controller.inspectShell = async () => [{ ProcessId: identity.pid, Birth: identity.birth }];
  assert.equal(await controller.observePreviousProducer(identity), null);
  for (const rows of [null, [{ ProcessId: identity.pid }],
    [{ ProcessId: identity.pid, Birth: identity.birth }, { ProcessId: identity.pid, Birth: identity.birth }]]) {
    controller.inspectShell = async () => rows;
    await assert.rejects(controller.observePreviousProducer(identity), { inlineFallback: true });
  }
  controller.inspectShell = async () => { throw new Error('inventory unavailable'); };
  await assert.rejects(controller.observePreviousProducer(identity), /inventory unavailable/);
});

test('missing managed target is observed before historical effects and role sources', async () => {
  const parent = { paneId: 'qa:parent', shell: { pid: 456 } };
  const controller = new TodoPane({ ctx: { sessionManager: { getSessionId: () => 'missing-session' } },
    environment: { HERDR_SOCKET_PATH: 'synthetic-socket', HERDR_PANE_ID: parent.paneId },
    stateDir: tmpdir(), cwd: tmpdir(), viewer: 'viewer.mjs',
    inspectShell: async () => [{ ProcessId: process.pid, ParentProcessId: parent.shell.pid,
      Birth: 'producer-birth', ExecutablePath: process.execPath, CommandLine: 'node' }],
    herdr: async (...args) => {
      assert.deepEqual(args, ['get', 'qa:gone']);
      throw Object.assign(new Error('gone'), { code: 'pane_not_found' });
    } });
  controller.nativePane = async paneId => { assert.equal(paneId, parent.paneId); return parent; };
  const operation = { id: 'old-effect', type: 'arrange', status: 'UNKNOWN' };
  controller.effectObservations.set(operation.id, { get promise() { throw new Error('historical effect was read'); } });
  const observed = await controller.observeManaged({ target: { paneId: 'qa:gone', statePath: 'unreadable' }, operation });
  assert.deepEqual(observed.missing, { code: 'pane_not_found', paneId: 'qa:gone' });
  assert.equal(observed.target, undefined);
});

async function fixture(t, branch = [snapshot]) {
  const directory = join(tmpdir(), `todo-controller-${process.pid}-${randomUUID()}`);
  console.log(JSON.stringify({ event: 'resource-planned', pid: process.pid, directory }));
  await mkdir(directory);
  const environment = { HERDR_SOCKET_PATH: 'synthetic-socket', HERDR_PANE_ID: 'qa:parent' };
  const events = new EventEmitter();
  const calls = [], panes = new Map([['qa:parent', { pane_id: 'qa:parent', tab_id: 'qa:tab' }],
    ['qa:dag', { pane_id: 'qa:dag', tab_id: 'qa:tab' }], ['qa:workers', { pane_id: 'qa:workers', tab_id: 'qa:tab' }]]);
  const processes = new Map();
  const ctx = { hasUI: true, mode: 'tui', ui: { setWidget() {} },
    sessionManager: { getSessionFile: () => 'selected.jsonl', getSessionId: () => 'synthetic-session',
      getBranch: () => branch, getLeafId: () => 'leaf' } };
  let number = 0;
  const herdr = async (...args) => {
    calls.push(args);
    if (args[0] === 'list') return { panes: [...panes.values()] };
    if (args[0] === 'split') {
      const pane_id = `qa:todo${++number}`; panes.set(pane_id, { pane_id, tab_id: 'qa:tab' }); return { pane: { pane_id } };
    }
    if (args[0] === 'process-info') return { process_info: { foreground_processes: processes.get(args[2]) ?? [] } };
    if (args[0] === 'close') { panes.delete(args[1]); events.emit(`closed:${args[1]}`); return {}; }
    if (args[0] === 'run') {
      const argv = [...args[2].matchAll(/'((?:''|[^'])*)'/g)].map(match => match[1].replaceAll("''", "'"));
      const file = argv[argv.indexOf('--state') + 1], state = await readRoleState(file);
      processes.set(args[1], [{ pid: 5000 + number, argv }]);
      assert.equal(await registerRoleViewer({ state, paneId: args[1], launchToken: state.launchToken, pid: 5000 + number }), true);
      return {};
    }
    return {};
  };
  const controller = new TodoPane({ ctx, environment, stateDir: directory, cwd: directory,
    node: 'node', viewer: join(directory, 'viewer.mjs'), herdr });
  console.log(JSON.stringify({ event: 'resource-planned', pid: process.pid, controlPipe: controller.controlPath,
    presencePipe: controller.presencePath }));
  t.after(async () => {
    await controller.stop(); await rm(directory, { recursive: true, force: true });
    console.log(JSON.stringify({ event: 'resource-cleaned', pid: process.pid, directory, controlPipe: controller.controlPath,
      presencePipe: controller.presence?.offer('todo').pipePath }));
  });
  await controller.start();
  const source = new EventEmitter(), ready = deferred();
  const provider = {
    lifetimeId: 'synthetic-d-lifetime', binding: controller.binding, sourceReady: ready.promise,
    getSource: () => ({ connected: true, runs: [], tasks: [], updatedAt: 'reported-time' }),
    setCoordinator(value) { this.coordinator = value; },
    subscribeSource(callback) { source.on('source', callback); return () => source.off('source', callback); },
    async openPair({ offers, claim }) {
      assert.equal(controller.presence.state.snapshot?.sequence, 1);
      assert.equal(offers.dag.scopeEpoch, controller.scopeEpoch);
      assert.equal(claim.tabId, 'qa:tab');
      return { dag: { ...controller.binding, role: 'dag', tabId: 'qa:tab', paneId: 'qa:dag' },
        workers: { ...controller.binding, role: 'workers', tabId: 'qa:tab', paneId: 'qa:workers' } };
    },
  };
  const bus = new EventEmitter();
  const pi = { events: { on(name, callback) { bus.on(name, callback); return () => bus.off(name, callback); },
    emit: (name, value) => bus.emit(name, value) } };
  return { controller, calls, panes, processes, events, directory, provider, ready, source, pi, bus };
}

test('fresh native branch opens a waiting Todo and later native commit updates the same pane', async t => {
  const branch = [];
  const f = await fixture(t, branch);
  assert.equal(f.controller.presence.state.snapshot.availability, 'waiting');
  assert.deepEqual(f.controller.bridge.status.masked, []);
  f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const before = await readRoleState(f.controller.stateFile);
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
  branch.push(snapshot);
  f.controller.bridge.observe({ type: 'tool_execution_end' }, f.controller.ctx);
  await f.controller.presence.idle();
  assert.equal(f.controller.presence.state.snapshot.availability, 'current');
  assert.equal(f.controller.presence.state.snapshot.counts.total, 1);
  assert.equal((await readRoleState(f.controller.stateFile)).paneId, before.paneId);
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
});

for (const order of ['provider-first', 'todo-first']) test(`${order}: source readiness, query/reply and concurrent layout create one Todo`, async t => {
  const f = await fixture(t), { controller, pi, bus, provider, ready } = f;
  const reply = event => {
    if (event.kind === 'dag-provider') pi.events.emit(dashboardChannels.reply,
      { v: 1, requestId: event.requestId, kind: 'dag-provider', ...controller.binding, provider });
  };
  if (order === 'provider-first') bus.on(dashboardChannels.query, reply);
  controller.bind(pi);
  if (order === 'todo-first') {
    bus.on(dashboardChannels.query, reply);
    pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...controller.binding, provider });
  }
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 0);
  ready.resolve();
  await Promise.all(Array.from({ length: 6 }, () => controller.schedule()));
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'run').length, 1);
  const split = f.calls.find(call => call[0] === 'split');
  assert.equal(split[split.indexOf('--pane') + 1], 'qa:workers');
  assert.ok(split.includes('--no-focus'));
  assert.equal(split[split.indexOf('--ratio') + 1], '0.5');
  assert.equal(controller.presence.state.snapshot.sequence, 1, 'layout must not republish the baseline');
  assert.equal(controller.status, 'current');
});

test('verified Todo pending readiness remains an owned anchor instead of pretending it is absent', async t => {
  const f = await fixture(t);
  f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const record = JSON.parse(await readFile(f.controller.recordFile, 'utf8'));
  await writeFile(f.controller.recordFile, JSON.stringify({ ...record, ready: false }));
  const anchor = await f.controller.coordinator().inspectTodo();
  assert.equal(anchor?.paneId, record.paneId);
  assert.equal(anchor.ready, false);
});

test('manual close is authenticated, durable and reopened only by an explicit command', async t => {
  const f = await fixture(t);
  f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  let state = await readRoleState(f.controller.stateFile);
  assert.equal(await requestRoleClose({ state, paneId: 'foreign:pane', launchToken: state.launchToken }), false);
  const closed = once(f.events, `closed:${state.paneId}`, { signal: AbortSignal.timeout(2000) });
  assert.equal(await requestRoleClose({ state, paneId: state.paneId, launchToken: state.launchToken, pid: 5001 }), true);
  await closed;
  assert.equal(JSON.parse(await readFile(f.controller.recordFile, 'utf8')).manualClose, true);
  await f.controller.schedule();
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
  await f.controller.schedule({ forceRoles: ['todo'] });
  state = await readRoleState(f.controller.stateFile);
  assert.equal(state.paneId, 'qa:todo2');
  await f.controller.schedule({ forceRoles: ['todo'] });
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 2);
});

test('a concurrent layout adoption cannot overwrite a committed manual close', { timeout: 7000 }, async t => {
  const f = await fixture(t); f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const state = await readRoleState(f.controller.stateFile);
  const entered = new EventEmitter(), release = deferred();
  const original = f.controller.herdr;
  let paused = false;
  f.controller.herdr = async (...args) => {
    if (args[0] === 'process-info' && !paused) {
      paused = true; entered.emit('adoption'); await release.promise;
    }
    return original(...args);
  };
  const adopting = once(entered, 'adoption', { signal: AbortSignal.timeout(2000) });
  const updating = f.controller.schedule();
  await adopting;
  const closed = once(f.events, `closed:${state.paneId}`, { signal: AbortSignal.timeout(2000) });
  try {
    assert.equal(await requestRoleClose({ state, paneId: state.paneId, launchToken: state.launchToken, pid: 5001 }), true);
    await closed;
  } finally { release.resolve(); }
  await updating;
  assert.equal(JSON.parse(await readFile(f.controller.recordFile, 'utf8')).manualClose, true);
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
});

test('current-session q wins over an already pending explicit recovery request', { timeout: 7000 }, async t => {
  const f = await fixture(t);
  f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider',
    ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const state = await readRoleState(f.controller.stateFile);
  const splitCount = f.calls.filter(call => call[0] === 'split').length;
  const entered = once(f.events, 'task5-recovery-entered', { signal: AbortSignal.timeout(2000) });
  const release = deferred(), original = f.provider.openPair;
  f.provider.openPair = async options => {
    f.events.emit('task5-recovery-entered');
    await release.promise;
    return original(options);
  };
  const recovering = f.controller.schedule({ forceRoles: ['todo'] });
  try {
    await entered;
    const closed = once(f.events, `closed:${state.paneId}`, { signal: AbortSignal.timeout(2000) });
    assert.equal(await requestRoleClose({ state, paneId: state.paneId,
      launchToken: state.launchToken, pid: 5001 }), true);
    await closed;
  } finally { release.resolve(); }
  await recovering;
  assert.equal(f.calls.filter(call => call[0] === 'split').length, splitCount);
  assert.equal(JSON.parse(await readFile(f.controller.recordFile, 'utf8')).manualClose, true);
});

test('foreign and ambiguous anchors cannot create, close or resize panes', async t => {
  const f = await fixture(t);
  f.ready.resolve(); f.controller.bind(f.pi);
  f.panes.set('qa:workers', { pane_id: 'qa:workers', tab_id: 'foreign:tab' });
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await assert.rejects(f.controller.schedule(), /layout-waiting/);
  assert.equal(f.calls.filter(call => ['split', 'close', 'resize'].includes(call[0])).length, 0);
});

test('process adoption requires exact PID, state, token and unambiguous argv', () => {
  const record = { paneId: 'qa:pane', statePath: '/synthetic/state.json', viewerPath: '/synthetic/viewer.mjs',
    nodePath: 'node', launchToken: 'launch', processId: 123 };
  const good = { pid: 123, argv: ['node', record.viewerPath, '--state', record.statePath,
    '--close-pane', record.paneId, '--launch-token', record.launchToken] };
  assert.equal(viewerProcess({ process_info: { foreground_processes: [good] } }, record), good);
  for (const processes of [[{ ...good, pid: 124 }], [{ ...good, argv: good.argv.slice(0, -2) }],
    [{ ...good, argv: ['node', '/foreign/launcher.mjs', ...good.argv.slice(1)] }], [good, good]])
    assert.equal(viewerProcess({ process_info: { foreground_processes: processes } }, record), null);
});

test('retired provider and old scope offers cannot affect the current layout', async t => {
  const f = await fixture(t); f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const mutations = () => f.calls.filter(call => ['split', 'run', 'close', 'resize'].includes(call[0])).length;
  const before = mutations();
  f.pi.events.emit(dashboardChannels.retired, { v: 1, ...f.controller.binding, lifetimeId: f.provider.lifetimeId });
  f.source.emit('source', { runs: [{ nodes: [] }], tasks: [] });
  await f.controller.schedule();
  assert.equal(mutations(), before);
  assert.equal(f.controller.status, 'layout-waiting');
});

test('Windows shell-only report verifies only the exact native Node child', async () => {
  if (process.platform !== 'win32') return;
  const root = win32.join('Q' + ':', 'QA space');
  const record = { paneId: 'qa:pane', statePath: win32.join(root, 'state.json'),
    viewerPath: win32.join(root, 'viewer.mjs'), nodePath: win32.join(root, 'nodejs', 'node.exe'),
    launchToken: 'launch', processId: 123, creationProcessId: 456, creationDate: '2026-10-03T00:00:00.000Z' };
  const info = { process_info: { shell_pid: 456, foreground_processes: [{ pid: 456, argv: ['powershell.exe'] }] } };
  const shell = { ProcessId: 456, ExecutablePath: 'powershell.exe', CommandLine: 'powershell.exe',
    CreationDate: record.creationDate };
  const native = { ProcessId: 123, ParentProcessId: 456, ExecutablePath: record.nodePath,
    CreationDate: '2026-10-03T00:00:01.000Z',
    CommandLine: `"${record.nodePath}" "${record.viewerPath}" --state "${record.statePath}" --close-pane qa:pane --launch-token launch` };
  assert.equal((await paneViewerProcess(info, record, 123, async () => [shell, native])).pid, 123);
  for (const child of [null, { ...native, ProcessId: 124 }, { ...native, ParentProcessId: 457 },
    { ...native, ExecutablePath: win32.join(root, 'foreign.exe') },
    { ...native, CommandLine: native.CommandLine.replace('--launch-token launch', '--launch-token stale') },
    { ...native, CommandLine: native.CommandLine.replace('qa:pane', 'qa:foreign') },
    { ...native, CommandLine: native.CommandLine.replace('state.json', 'foreign.json') }])
    assert.equal(await paneViewerProcess(info, record, 123, async () => child ? [shell, child] : [shell]), null);
  let inspected = false;
  for (const report of [{ process_info: { ...info.process_info, shell_pid: 457 } },
    { process_info: { ...info.process_info, foreground_processes: [{ pid: 456 }, { pid: 789 }] } }])
    assert.equal(await paneViewerProcess(report, record, 123, async () => { inspected = true; return native; }), null);
  assert.equal(inspected, false);
  for (const command of [native.CommandLine + ' --once', native.CommandLine + ' --launch-token launch',
    native.CommandLine + ' extra', native.CommandLine.replace('token launch', 'token "launchx'),
    native.CommandLine.replace(`"${record.viewerPath}"`, `"${root}\\"viewer.mjs`)]) {
    const child = { ...native, CommandLine: command };
    assert.equal(await paneViewerProcess(info, record, 123, async () => [shell, child]), null);
    assert.equal(await canCleanupPane(info, record, async () => [shell, child]), false);
  }
  assert.equal(parseLaunchCommand('--launch-token "launchx'), null);
  assert.equal(parseLaunchCommand('"node\\" --state state'), null);
  assert.equal(await canCleanupPane(info, record, async () => [shell]), true);
  assert.equal(await canCleanupPane(info, record, async () => [shell, native]), true);
  for (const rows of [[], [native], [shell, { ...native, ExecutablePath: 'foreign.exe' }],
    [shell, native, { ...native, ProcessId: 789 }], [shell, { ...native, CreationDate: undefined }],
    [{ ...shell, CreationDate: '2026-10-03T00:00:02.000Z' }, native]])
    assert.equal(await canCleanupPane(info, record, async () => rows), false);
  assert.equal(await canCleanupPane(info, record, async () => { throw new Error('CIM failed'); }), false);
  assert.equal(await paneViewerProcess(info, record, 123, async () =>
    [{ ...shell, CreationDate: '2026-10-03T00:00:02.000Z' }, native]), null);
});

test('scope rebinding updates an existing Todo even when the DAG provider has retired', async t => {
  const f = await fixture(t); f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const before = await readRoleState(f.controller.stateFile);
  f.pi.events.emit(dashboardChannels.retired, { v: 1, ...f.controller.binding, lifetimeId: f.provider.lifetimeId });
  await f.controller.rebase(f.controller.ctx);
  const current = await readRoleState(f.controller.stateFile);
  assert.equal(current.scopeEpoch, 2);
  assert.equal(current.presenceOffer.scopeEpoch, 2);
  assert.equal(current.controlOffer.scopeEpoch, 2);
  assert.equal(current.paneId, before.paneId);
  assert.equal(current.launchToken, before.launchToken);
  assert.notEqual(current.cachePath, before.cachePath);
  assert.equal(JSON.parse(await readFile(current.cachePath, 'utf8')).snapshot.scopeEpoch, 2);
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'run').length, 1);
});

test('shell/native child proof supports real registration, reuse and manual close', async t => {
  const f = await fixture(t), original = f.controller.herdr;
  f.controller.herdr = async (...args) => args[0] === 'process-info'
    ? { process_info: { shell_pid: 7100, foreground_processes: [{ pid: 7100, argv: ['powershell.exe'] }] } }
    : original(...args);
  f.controller.inspectShell = async () => [{ ProcessId: 7100, ExecutablePath: 'powershell.exe',
    CommandLine: 'powershell.exe', CreationDate: '2026-10-03T00:00:00.000Z' },
  ...[...f.processes.values()].flat().map(row => ({ ProcessId: row.pid, ParentProcessId: 7100,
    ExecutablePath: row.argv[0], CommandLine: row.argv.map(value => `"${value}"`).join(' '),
    CreationDate: '2026-10-03T00:00:01.000Z' }))];
  f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const state = await readRoleState(f.controller.stateFile);
  await f.controller.schedule();
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
  const closed = once(f.events, `closed:${state.paneId}`, { signal: AbortSignal.timeout(2000) });
  assert.equal(await requestRoleClose({ state, paneId: state.paneId, launchToken: state.launchToken, pid: 5001 }), true);
  await closed;
  assert.equal(JSON.parse(await readFile(f.controller.recordFile, 'utf8')).manualClose, true);
});

test('managed state rejects malformed role or owner identity', async t => {
  const f = await fixture(t), path = join(f.directory, 'invalid.json');
  assert.equal(await readRoleState(path), null);
  await writeFile(path, JSON.stringify({ schema: 'omo-herdr-dashboard/role/1', role: 'todo' }));
  await assert.rejects(readRoleState(path), /Invalid managed/);
});

test('an authenticated protocol ACK without verified pane creation cannot hide native Todo', async t => {
  const f = await fixture(t), offer = f.controller.presence.offer('todo');
  const events = new EventEmitter();
  const ack = once(events, 'ack', { signal: AbortSignal.timeout(2000) });
  const trace = event => { if (event.type === 'ack') events.emit('ack', event); };
  f.controller.presence.events.on('event', trace);
  const socket = net.createConnection(offer.pipePath);
  t.after(() => { socket.destroy(); f.controller.presence.events.off('event', trace); });
  socket.on('error', () => {});
  socket.once('connect', () => socket.write(`${JSON.stringify({ ...offer, type: 'hello' })}\n`));
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    const cut = buffer.indexOf('\n');
    if (cut < 0) return;
    const message = JSON.parse(buffer.slice(0, cut)); buffer = buffer.slice(cut + 1);
    if (message.type === 'snapshot') {
      // Adversarial input: valid protocol fields, deliberately no actual viewer.
      socket.write(`${JSON.stringify({ ...offer, type: 'ack', sequence: message.sequence })}\n`);
    }
  });
  const [received] = await ack;
  const receipt = { ...offer, sequence: received.sequence };
  assert.equal(f.controller.presence.isReady(receipt), true, 'protocol layer alone accepts the bound ACK');
  assert.equal(f.controller.adapter.isReady(receipt), false, 'controller also requires a proven owned role process');
  assert.deepEqual(f.controller.bridge.status.masked, []);
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 0);
});

test('initial native source failure creates no pane and stop closes all local listeners', async t => {
  const directory = join(tmpdir(), `todo-source-failure-${process.pid}-${randomUUID()}`);
  console.log(JSON.stringify({ event: 'resource-planned', pid: process.pid, directory }));
  await mkdir(directory);
  const calls = [];
  const ctx = { hasUI: true, mode: 'tui', ui: { setWidget() {} }, sessionManager: {
    getSessionFile: () => 'parent.jsonl', getSessionId: () => 'source-failure',
    getBranch() { throw new Error('Native branch unavailable'); }, getLeafId: () => 'leaf',
  } };
  const owner = new TodoPane({ ctx, environment: { HERDR_SOCKET_PATH: 'qa:socket', HERDR_PANE_ID: 'qa:parent' },
    stateDir: directory, cwd: directory, viewer: join(directory, 'viewer.mjs'),
    herdr: async (...args) => { calls.push(args); return {}; } });
  t.after(async () => { await owner.stop(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(owner.start(), /Initial native source save failed/);
  await owner.stop();
  assert.equal(owner.control.listening, false);
  assert.equal(calls.length, 0);
});

test('child exclusion precedes UI getters; noninteractive lifecycle and commands create no owner', async () => {
  const handlers = new Map(), commands = new Map();
  const pi = { on(type, handler) { handlers.set(type, handler); return () => {}; },
    registerCommand(name, command) { commands.set(name, command); } };
  extension(pi);
  const child = { sessionManager: { getSessionFile: () => '/synthetic/senpi-task/children/child/session.jsonl' },
    get hasUI() { throw new Error('UI must not be read'); } };
  await handlers.get('session_start')({}, child);
  assert.equal(commands.size, 0, 'the integrated DAG entry owns the one dashboard command');
  await handlers.get('session_start')({}, { hasUI: true, mode: 'rpc',
    sessionManager: { getSessionFile: () => '/synthetic/parent.jsonl' } });
});

test('task3 one shared lifecycle event coalesces both callbacks and drains a superseded start', { timeout: 8000 }, async () => {
  const bus = new EventEmitter(), events = new EventEmitter(), firstStart = deferred(), firstDrain = deferred();
  const created = [];
  const pi = { events: { on(name, callback) { bus.on(name, callback); return () => bus.off(name, callback); },
    emit: (name, value) => bus.emit(name, value) } };
  const service = dashboard.registerManagedDashboard(pi, {
    environment: { HERDR_SOCKET_PATH: 'synthetic-lifecycle', HERDR_PANE_ID: 'qa:parent' }, stateDir: '/synthetic/lifecycle',
    createController(ctx) {
      const index = created.length;
      let stopping;
      const owner = { ctx, lifetimeId: `lifetime-${index}`, stopped: false,
        async start() { events.emit('started', index); if (index === 0) await firstStart.promise; },
        bind() {}, schedule: async () => {},
        stop() {
          if (stopping) return stopping;
          this.stopped = true; events.emit('draining', index);
          return stopping = index === 0 ? firstDrain.promise : Promise.resolve();
        } };
      created.push(owner);
      return owner;
    },
  });
  const ctx = { sessionManager: { getSessionId: () => 'same-session' }, ui: { notify() {} } };
  const event = { type: 'session_start', reason: 'startup' };
  const entered = once(events, 'started', { signal: AbortSignal.timeout(2000) });
  const first = service.start(event, ctx);
  const duplicate = service.start(event, ctx);
  await entered;
  assert.equal(created.length, 1);
  const draining = once(events, 'draining', { signal: AbortSignal.timeout(2000) });
  const replacement = service.start({ type: 'session_start', reason: 'reload' }, ctx);
  await draining;
  assert.equal(created[0].stopped, true);
  assert.equal(created.length, 1, 'replacement must await the publisher drain');
  firstStart.resolve();
  firstDrain.resolve();
  await Promise.all([first, duplicate, replacement]);
  assert.equal(created.length, 2);
  assert.equal(service.controller, created[1]);
  await service.stop();
  assert.equal(created[1].stopped, true);
});

async function arrangeFixture(t, kind = 'swap', outcome = 'matching') {
  const directory = join(tmpdir(), `arrange-controller-${process.pid}-${randomUUID()}`);
  const socketPath = join(directory, 'control.sock');
  // Herdr's Windows GenericNamespaced transport prefixes the marker path.
  const nativeSocketPath = process.platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  console.log(JSON.stringify({ event: 'resource-planned', pid: process.pid, directory, socketPath, nativeSocketPath }));
  await mkdir(directory);
  if (process.platform === 'win32') await writeFile(socketPath, 'synthetic native marker');
  const parent = { paneId: 'qa:parent', tabId: 'qa:tab', shell: { pid: 456, birth: '133800000000000000' } };
  const producer = { pid: 123, birth: '133900000000000000', executable: 'node.exe', argvDigest: 'a'.repeat(64) };
  const dag = { paneId: 'qa:dag', tabId: parent.tabId, shell: { pid: 789, birth: parent.shell.birth } };
  const target = kind === 'resize' ? parent : dag;
  const sockets = new Set();
  let subscriber, requestId;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', data => {
      buffer += data;
      const cut = buffer.indexOf('\n');
      if (cut < 0) return;
      const request = JSON.parse(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 1);
      assert.equal(request.method, 'events.subscribe');
      assert.deepEqual(request.params.subscriptions, [{ type: kind === 'focus' ? 'pane.focused' :
        kind === 'move' ? 'pane.moved' : 'layout.updated' }]);
      subscriber = socket; requestId = request.id;
      socket.write(JSON.stringify({ id: request.id, result: { type: 'subscription_started' } }) + '\n');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(nativeSocketPath, resolve); });
  const actor = await claimParentSlot({ stateDir: join(directory, 'state'), socketPath,
    parent, producer, sessionId: 'arrange-session', observe: async ({ target }) => ({ parent, producer, target }) });
  const calls = [];
  const before = { workspace_id: 'qa', tab_id: parent.tabId, focused_pane_id: kind === 'focus' ? dag.paneId : parent.paneId,
    area: { x: 0, y: 0, width: 100, height: 40 }, zoomed: false,
    splits: [{ id: 'root', direction: 'right', ratio: .5, rect: { x: 0, y: 0, width: 100, height: 40 } }],
    panes: [{ pane_id: parent.paneId, rect: { x: 0, y: 0, width: 50, height: 40 } },
      { pane_id: dag.paneId, rect: { x: 50, y: 0, width: 50, height: 40 } }] };
  if (outcome === 'native-f32') before.splits[0].ratio = .6;
  if (outcome.startsWith('nested-')) {
    before.area.width = 120;
    before.splits = [
      { id: 'split_0_root', direction: 'right', ratio: .6, rect: { x: 0, y: 0, width: 120, height: 40 } },
      { id: 'split_1_1', direction: 'right', ratio: .5, rect: { x: 72, y: 0, width: 48, height: 40 } },
      { id: 'split_2_10', direction: 'down', ratio: .5, rect: { x: 72, y: 0, width: 24, height: 40 } },
    ];
    before.panes = [
      { pane_id: parent.paneId, rect: { x: 0, y: 0, width: 72, height: 40 } },
      { pane_id: dag.paneId, rect: { x: 72, y: 0, width: 24, height: 20 } },
      { pane_id: 'qa:workers', rect: { x: 72, y: 20, width: 24, height: 20 } },
      { pane_id: 'qa:todo', rect: { x: 96, y: 0, width: 24, height: 40 } },
    ];
  }
  const after = structuredClone(before);
  if (kind === 'swap') {
    [after.panes[0].rect, after.panes[1].rect] = [after.panes[1].rect, after.panes[0].rect];
    after.focused_pane_id = dag.paneId;
  } else if (kind === 'resize') {
    after.panes[0].rect.width = 60; after.panes[1].rect.x = 60; after.panes[1].rect.width = 40;
    after.splits[0].ratio = .6;
    if (outcome.startsWith('nested-')) {
      after.panes[0].rect.width = 84;
      for (const index of [1, 2]) Object.assign(after.panes[index].rect, { x: 84, width: 18 });
      Object.assign(after.panes[3].rect, { x: 102, width: 18 });
      after.splits[0].ratio = .7;
      Object.assign(after.splits[1].rect, { x: 84, width: 36 });
      Object.assign(after.splits[2].rect, { x: 84, width: 18 });
      if (outcome === 'nested-leaf-swap')
        [after.panes[1].rect, after.panes[2].rect] = [after.panes[2].rect, after.panes[1].rect];
      if (outcome === 'nested-split-change') {
        after.splits[2].ratio = .75;
        after.panes[1].rect.height = 30;
        Object.assign(after.panes[2].rect, { y: 30, height: 10 });
      }
      if (outcome === 'nested-invalid') after.panes[3].rect.width = 17;
    }
  } else if (kind === 'focus') after.focused_pane_id = parent.paneId;
  const args = kind === 'swap' ? ['swap', '--source-pane', dag.paneId, '--target-pane', parent.paneId] :
    kind === 'focus' ? ['focus', '--pane', dag.paneId, '--direction', 'left'] :
    kind === 'resize' ? ['resize', '--pane', parent.paneId, '--direction', 'right', '--amount', '.1'] :
    ['move', dag.paneId, '--tab', parent.tabId, '--target-pane', parent.paneId, '--split', 'right', '--no-focus'];
  let submitted = false;
  const events = new EventEmitter();
  const owner = new TodoPane({ managed: true, stateDir: directory, cwd: directory,
    environment: { HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: parent.paneId },
    ctx: { sessionManager: { getSessionId: () => 'arrange-session' } },
    herdr: async (...args) => {
      calls.push(args);
      if (args[0] === 'layout') return { layout: structuredClone(submitted ? after : before) };
      if (args[0] === 'neighbor') return { neighbor: { neighbor_pane_id: parent.paneId, layout: before } };
      if (args[0] !== kind) throw new Error('Unexpected native command');
      assert.ok(subscriber, 'native subscription acknowledged before the actual action');
      submitted = true;
      assert.equal(actor.snapshot.operations.at(-1).status, 'DISPATCHED');
      if (outcome === 'source-stale') owner.lifetimeId = 'replacement';
      const event = kind === 'focus' ? { event: 'pane_focused',
        data: { type: 'pane_focused', pane_id: parent.paneId, workspace_id: 'qa' } } :
        { event: 'layout_updated', data: { type: 'layout_updated', layout: after } };
      if (outcome === 'native-f32') {
        event.data.layout = structuredClone(after);
        event.data.layout.splits[0].ratio = Math.fround(.6);
      }
      if (outcome === 'wrong-effect') {
        if (kind === 'focus') event.data.pane_id = dag.paneId;
        else event.data.layout = before;
      }
      if (outcome === 'events-lost') subscriber.end(JSON.stringify({ id: requestId,
        error: { code: 'events_lost', message: 'history overrun' } }) + '\n');
      else if (outcome === 'missing-effect' || kind === 'move') subscriber.end();
      else if (outcome === 'held') events.emit('submitted', subscriber);
      else {
        subscriber.write(JSON.stringify(event) + '\n');
        if (outcome === 'wrong-effect' || outcome === 'native-f32' ||
          ['nested-leaf-swap', 'nested-split-change', 'nested-invalid'].includes(outcome)) subscriber.end();
      }
      if (outcome === 'lost-reply') throw new Error('native reply lost');
      if (outcome === 'early-reply') return {};
      return kind === 'move' ? { type: 'pane_move', move_result: {
        changed: false, reason: 'same_tab', previous_pane_id: dag.paneId, target_layout: before } } :
        { type: kind === 'focus' ? 'pane_focus_direction' : 'pane_' + kind,
          [kind]: { changed: true, source_pane_id: dag.paneId, target_pane_id: parent.paneId,
            pane_id: target.paneId, focused_pane_id: after.focused_pane_id, layout: after } };
    } });
  owner.actor = actor;
  owner.currentTarget = async paneId => {
    const identity = paneId === parent.paneId ? parent : paneId === dag.paneId ? dag :
      { paneId, tabId: parent.tabId, shell: { pid: paneId === 'qa:todo' ? 791 : 790, birth: parent.shell.birth } };
    return submitted && outcome === 'native-stale' ? { ...identity, shell: { ...identity.shell, birth: 'replacement' } } : identity;
  };
  owner.observeManaged = async ({ target }) => ({ parent, producer, target });
  await actor.join('todo', owner.lifetimeId);
  await actor.join('dag', 'd-arrange-lifetime');
  t.after(async () => {
    // An UNKNOWN journal must not be released as settled. Fixture-only disposal
    // closes the original SQLite object after capturing the product failure.
    if (actor.db.isOpen) { if (actor.db.isTransaction) actor.db.exec('ROLLBACK'); actor.db.close(); }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    console.log(JSON.stringify({ event: 'resource-cleaned', pid: process.pid, directory, socketPath }));
  });
  return { owner, actor, calls, events, before, after, directory, run: () => owner.mutate('dag', 'arrange', target, args,
    kind === 'resize' ? { paneId: parent.paneId, rect: after.panes[0].rect } : undefined) };
}

test('task23 nested resize grows the parent while moving and shrinking its sibling subtree', async t => {
  const f = await arrangeFixture(t, 'resize', 'nested-matching');
  await f.run();
  assert.equal(f.actor.snapshot.operations.at(-1).status, 'SETTLED');
  assert.deepEqual(f.after.panes.map(pane => pane.rect), [
    { x: 0, y: 0, width: 84, height: 40 },
    { x: 84, y: 0, width: 18, height: 20 },
    { x: 84, y: 20, width: 18, height: 20 },
    { x: 102, y: 0, width: 18, height: 40 },
  ]);
  assert.notDeepEqual(f.before.panes[1].rect, f.after.panes[1].rect);
  assert.equal(f.calls.filter(args => args[0] === 'resize').length, 1);
});

for (const outcome of ['nested-leaf-swap', 'nested-split-change', 'nested-invalid'])
  test(`task23 resize rejects ${outcome} despite the exact requested parent rectangle`, async t => {
    const f = await arrangeFixture(t, 'resize', outcome);
    await assert.rejects(f.run(), { code: 'EFFECT_UNKNOWN' });
    assert.equal(f.actor.snapshot.operations.at(-1).status, 'UNKNOWN');
    assert.equal(f.actor.snapshot.phase, 'BLOCKED');
    assert.equal(f.actor.inlineFallback, true);
    await assert.rejects(f.run());
    assert.equal(f.calls.filter(args => args[0] === 'resize').length, 1, 'no blind replay');
  });

test('task20 managed arrange cannot settle on a successful unrelated layout', async t => {
  const f = await arrangeFixture(t, 'swap', 'wrong-effect');
  await assert.rejects(f.run(), { code: 'EFFECT_UNKNOWN' });
  assert.equal(f.actor.snapshot.operations.at(-1).status, 'UNKNOWN');
  assert.equal(f.actor.snapshot.phase, 'BLOCKED');
  assert.equal(f.actor.inlineFallback, true);
  assert.equal(f.calls.filter(args => args[0] === 'swap').length, 1, 'no replay');
});

for (const kind of ['swap', 'resize', 'focus']) test(`task20 ${kind} settles only after its matching native signal`, async t => {
  const f = await arrangeFixture(t, kind);
  const result = await f.run();
  assert.equal(result.type, kind === 'focus' ? 'pane_focus_direction' : 'pane_' + kind);
  assert.equal(f.actor.snapshot.operations.at(-1).status, 'SETTLED');
  assert.equal(f.calls.filter(args => args[0] === kind).length, 1);
});

for (const kind of ['swap', 'resize', 'focus']) test(`task20 ${kind} wrong completion stays unknown`, async t => {
  const f = await arrangeFixture(t, kind, 'wrong-effect');
  await assert.rejects(f.run(), { code: 'EFFECT_UNKNOWN' });
  assert.equal(f.actor.snapshot.operations.at(-1).status, 'UNKNOWN');
  assert.equal(f.calls.filter(args => args[0] === kind).length, 1);
});

for (const outcome of ['missing-effect', 'early-reply', 'lost-reply', 'events-lost', 'source-stale', 'native-stale'])
  test(`task20 ${outcome} cannot settle or replay an arrange`, async t => {
    const f = await arrangeFixture(t, 'swap', outcome);
    await assert.rejects(f.run(), { code: 'EFFECT_UNKNOWN' });
    assert.equal(f.actor.snapshot.operations.at(-1).status, 'UNKNOWN');
    assert.equal(f.actor.inlineFallback, true);
    assert.equal(f.calls.filter(args => args[0] === 'swap').length, 1);
  });

test('task20 cancellation closes the armed subscription without settling a pending arrange', async t => {
  const f = await arrangeFixture(t, 'swap', 'held');
  const submitted = once(f.events, 'submitted', { signal: AbortSignal.timeout(2000) });
  const result = f.run();
  const rejected = assert.rejects(result, { code: 'EFFECT_UNKNOWN' });
  await submitted;
  f.owner.stopSignal.abort(new Error('publisher cancelled'));
  await rejected;
  assert.equal(f.actor.snapshot.operations.at(-1).status, 'UNKNOWN');
});

test('task20 native same-tab move refusal is unknown, not a successful rearrangement', async t => {
  const f = await arrangeFixture(t, 'move');
  await assert.rejects(f.run(), { code: 'EFFECT_UNKNOWN' });
  assert.equal(f.actor.snapshot.operations.at(-1).status, 'UNKNOWN');
  assert.equal(f.calls.filter(args => args[0] === 'move').length, 1);
});

test('task20 successful arrange republishes current source for fresh post-paint acknowledgement', async t => {
  const f = await arrangeFixture(t);
  let publications = 0;
  f.owner.bridge = { readinessChanged() {}, invalidate() { publications++; } };
  f.owner.presence = { async idle() {} };
  await f.run();
  assert.equal(f.actor.snapshot.operations.at(-1).status, 'SETTLED');
  assert.equal(publications, 1);
});

test('task22 settled temporary close republishes current source after paint invalidation', async t => {
  const f = await arrangeFixture(t);
  let publications = 0;
  f.owner.bridge = { readinessChanged() {}, invalidate() { publications++; } };
  f.owner.presence = { async idle() {} };
  await f.owner.perform('dag', 'close', await f.owner.currentTarget('qa:dag'),
    async () => ({ result: {}, effects: Promise.resolve() }));
  assert.equal(f.actor.snapshot.operations.at(-1).status, 'SETTLED');
  assert.equal(publications, 1);
});

test('task4 settled placement split refreshes a retained role paint floor', async t => {
  const f = await arrangeFixture(t);
  const target = { paneId: 'qa:dag', tabId: 'qa:tab',
    shell: { pid: 789, birth: '133800000000000000' },
    viewer: { pid: 900, birth: '133900000000000000', executable: 'node.exe', argvDigest: 'b'.repeat(64) },
    statePath: join(f.directory, 'dag.state'), sourcePath: join(f.directory, 'dag.source'),
    cachePath: join(f.directory, 'dag.cache'), prefsPath: join(f.directory, 'dag.prefs'),
    launchToken: 'dag-launch', controlToken: 'dag-control' };
  await f.actor.registerRole(f.actor.capability('dag', 'dag'), target);
  await f.actor.ackRole({ ...f.actor.capability('dag', 'dag'), paneId: target.paneId,
    statePath: target.statePath, launchToken: target.launchToken, controlToken: target.controlToken,
    painted: true, sequence: 5 });
  let publications = 0;
  f.owner.bridge = { readinessChanged() {}, invalidate() { publications++; } };
  f.owner.presence = { async idle() {} };
  await f.owner.perform('dag', 'split', await f.owner.currentTarget('qa:parent'),
    async () => ({ result: {}, effects: Promise.resolve() }));
  assert.equal(f.actor.snapshot.operations.at(-1).status, 'SETTLED');
  assert.deepEqual(f.actor.snapshot.roles.dag.ack, { sequence: 5, painted: false });
  await assert.rejects(f.actor.ackRole({ ...f.actor.capability('dag', 'dag'), paneId: target.paneId,
    statePath: target.statePath, launchToken: target.launchToken, controlToken: target.controlToken,
    painted: true, sequence: 5 }), { code: 'ACK_MISMATCH' });
  assert.equal(publications, 1);
  await f.owner.perform('workers', 'split', await f.owner.currentTarget('qa:parent'),
    async () => ({ result: {}, effects: Promise.resolve() }));
  assert.equal(publications, 1);
});

test('task42 retained run republishes above its preserved paint floor', async t => {
  const f = await arrangeFixture(t);
  const target = { paneId: 'qa:dag', tabId: 'qa:tab',
    shell: { pid: 789, birth: '133800000000000000' },
    viewer: { pid: 900, birth: '133900000000000000', executable: 'node.exe', argvDigest: 'b'.repeat(64) },
    statePath: join(f.directory, 'dag.state'), sourcePath: join(f.directory, 'dag.source'),
    cachePath: join(f.directory, 'dag.cache'), prefsPath: join(f.directory, 'dag.prefs'),
    launchToken: 'dag-launch', controlToken: 'dag-control' };
  await f.actor.registerRole(f.actor.capability('dag', 'dag'), target);
  await f.actor.ackRole({ ...f.actor.capability('dag', 'dag'), paneId: target.paneId,
    statePath: target.statePath, launchToken: target.launchToken, controlToken: target.controlToken,
    painted: true, sequence: 5 });
  let sequence = 5, publications = 0;
  f.owner.bridge = { readinessChanged() {}, invalidate() { sequence++; publications++; } };
  f.owner.presence = { async idle() {} };
  const prepared = { ...target, launchToken: 'replacement-launch' };
  delete prepared.viewer;
  await f.owner.perform('dag', 'run', prepared,
    async () => ({ result: {}, effects: Promise.resolve() }));
  const replacement = { ...prepared, viewer: { ...target.viewer, pid: 901, birth: '133900000010000000' } };
  await f.actor.registerRole(f.actor.capability('dag', 'dag'), replacement);
  assert.equal(f.actor.snapshot.operations.at(-1).status, 'SETTLED');
  assert.deepEqual(f.actor.snapshot.roles.dag.ack, { sequence: 5, painted: false });
  const painted = { ...f.actor.capability('dag', 'dag'), paneId: replacement.paneId,
    statePath: replacement.statePath, launchToken: replacement.launchToken, controlToken: replacement.controlToken,
    painted: true };
  await assert.rejects(f.actor.ackRole({ ...painted, sequence: 5 }), { code: 'ACK_MISMATCH' });
  assert.equal(sequence, 6);
  assert.equal(publications, 1);
  await f.actor.ackRole({ ...painted, sequence });
  assert.deepEqual(f.actor.snapshot.roles.dag.ack, { sequence: 6, painted: true });
  await f.owner.perform('workers', 'run', await f.owner.currentTarget('qa:workers'),
    async () => ({ result: {}, effects: Promise.resolve() }));
  assert.equal(publications, 1);
});

test('task4 stale unpainted floor receipt cannot poison later current paint', async t => {
  const f = await arrangeFixture(t);
  const target = { paneId: 'qa:todo', tabId: 'qa:tab',
    shell: { pid: 791, birth: '133800000000000000' },
    viewer: { pid: 902, birth: '133900000000000000', executable: 'node.exe', argvDigest: 'b'.repeat(64) },
    statePath: join(f.directory, 'todo.state'), sourcePath: join(f.directory, 'todo.source'),
    cachePath: join(f.directory, 'todo.cache'), prefsPath: join(f.directory, 'todo.prefs'),
    launchToken: 'todo-launch', controlToken: 'todo-control' };
  await f.actor.registerRole(f.actor.capability('todo', 'todo'), target);
  await f.actor.ackRole({ ...f.actor.capability('todo', 'todo'), paneId: target.paneId,
    statePath: target.statePath, launchToken: target.launchToken, controlToken: target.controlToken,
    painted: true, sequence: 3 });
  f.owner.bridge = { readinessChanged() {}, invalidate() {} };
  f.owner.presence = { async idle() {}, getOwner: () => f.owner.binding, isReady: () => true };
  f.owner.recoveryBlocked = false;
  await f.owner.perform('todo', 'split', await f.owner.currentTarget('qa:parent'),
    async () => ({ result: {}, effects: Promise.resolve() }));
  assert.deepEqual(f.actor.snapshot.roles.todo.ack, { sequence: 3, painted: false });
  await assert.rejects(f.actor.ackRole({ ...f.actor.capability('todo', 'todo'), paneId: target.paneId,
    statePath: target.statePath, launchToken: target.launchToken, controlToken: target.controlToken,
    painted: true, sequence: 3 }), { code: 'ACK_MISMATCH' });
  f.owner.paintManaged({ role: 'todo', sequence: 3 });
  await f.owner.managedIdle();
  assert.deepEqual(f.actor.snapshot.roles.todo.ack, { sequence: 3, painted: false });
  assert.equal(f.owner.recoveryBlocked, false);
  f.owner.paintManaged({ role: 'todo', sequence: 4 });
  await f.owner.managedIdle();
  assert.deepEqual(f.actor.snapshot.roles.todo.ack, { sequence: 4, painted: true });
  assert.equal(f.actor.blocked, false);
  assert.equal(f.owner.recoveryBlocked, false);
});

for (const caller of ['reconcileLegacy', 'ensureTodo'])
  test(`task4 ${caller} submits obsolete locator after queued paint publication`, async t => {
    const f = await arrangeFixture(t);
    f.owner.viewer = join(f.directory, 'viewer.mjs');
    const record = { schema: 'omo-herdr-dashboard/pane/1', ...f.owner.binding,
      role: 'todo', paneId: 'qa:obsolete', tabId: 'qa:tab', launchToken: 'obsolete-launch',
      statePath: f.owner.stateFile, viewerPath: f.owner.viewer, nodePath: f.owner.node };
    await mkdir(f.owner.directory, { recursive: true });
    await writeFile(f.owner.recordFile, JSON.stringify(record));
    f.owner.herdr = async (...args) => {
      if (args[0] === 'list') return { panes: [{ pane_id: 'qa:parent', tab_id: 'qa:tab' }] };
      if (args[0] === 'get') throw Object.assign(new Error('Native absence'), { code: 'pane_not_found' });
      throw new Error('Unexpected native command');
    };
    const target = { paneId: 'qa:workers', tabId: 'qa:tab',
      shell: { pid: 790, birth: '133800000000000000' },
      viewer: { pid: 901, birth: '133900000000000000', executable: 'node.exe', argvDigest: 'b'.repeat(64) },
      statePath: join(f.directory, 'workers.state'), sourcePath: join(f.directory, 'workers.source'),
      cachePath: join(f.directory, 'workers.cache'), prefsPath: join(f.directory, 'workers.prefs'),
      launchToken: 'workers-launch', controlToken: 'workers-control' };
    await f.actor.registerRole(f.actor.capability('dag', 'workers'), target);
    const release = deferred(), observe = f.actor.observe.bind(f.actor);
    let hold = true, paintRevision, submitted;
    f.actor.observe = async input => {
      if (hold && input.target?.paneId === target.paneId) {
        hold = false;
        f.events.emit('paint-validating');
        await release.promise;
      }
      const actual = await observe(input);
      return input.locator ? { ...actual, missing: { code: 'pane_not_found', paneId: record.paneId } } : actual;
    };
    const validating = once(f.events, 'paint-validating', { signal: AbortSignal.timeout(2000) });
    const painting = f.owner.managedWrite(async actor => {
      await actor.ackRole({ ...actor.capability('dag', 'workers'), paneId: target.paneId,
        statePath: target.statePath, launchToken: target.launchToken, controlToken: target.controlToken,
        painted: true, sequence: 1 });
      paintRevision = actor.snapshot.revision;
    });
    await validating;
    const write = f.owner.managedWrite.bind(f.owner), obsolete = f.actor.obsoleteLocator.bind(f.actor);
    f.owner.managedWrite = job => {
      const result = write(job);
      f.events.emit('tombstone-requested');
      return result;
    };
    f.actor.obsoleteLocator = (capability, locator) => {
      submitted = capability;
      const result = obsolete(capability, locator);
      f.events.emit('tombstone-requested');
      return result;
    };
    const requested = once(f.events, 'tombstone-requested', { signal: AbortSignal.timeout(2000) });
    const tombstone = caller === 'reconcileLegacy' ? f.owner.reconcileLegacy(f.directory) : f.owner.ensureTodo(null, false);
    tombstone.catch(() => {});
    try {
      await requested;
      release.resolve();
      await painting;
      await tombstone;
      assert.equal(submitted.revision, paintRevision);
      assert.equal(f.actor.snapshot.closures.filter(entry => entry.paneId === record.paneId).length, 1);
      assert.equal(f.actor.snapshot.roles.workers.ack.painted, true);
    } finally {
      release.resolve();
      await Promise.allSettled([painting, tombstone]);
    }
  });

for (const scenario of ['dead-viewer', 'dead-node', 'live', 'ambiguous-absence',
  'unreadable-membership', 'owner-unheld', 'reappeared'])
  test(`upgrade legacy Todo recovery: ${scenario}`, async t => {
    const f = await arrangeFixture(t), owner = f.owner;
    owner.viewer = join(f.directory, 'generation-000004', 'viewer.mjs');
    owner.scopeEpoch = 1;
    owner.storage = { path: join(f.directory, 'cache.json') };
    owner.presence = { offer: () => null };
    const record = { schema: 'omo-herdr-dashboard/pane/1', ...owner.binding,
      role: 'todo', paneId: 'qa:legacy', tabId: 'qa:tab', scopeEpoch: 1,
      launchToken: 'generation-3-launch', statePath: owner.stateFile,
      viewerPath: scenario === 'dead-node' ? owner.viewer : join(f.directory, 'generation-000003', 'viewer.mjs'),
      nodePath: scenario === 'dead-node' ? join(f.directory, 'old-node.exe') : owner.node,
      prepared: true, ready: true, manualClose: false, processId: 5001 };
    await mkdir(owner.directory, { recursive: true });
    await writeFile(owner.recordFile, JSON.stringify(record));
    let live = scenario === 'live', authority = false, retirementCalls = 0;
    const calls = [], obsolete = f.actor.obsoleteLocator.bind(f.actor);
    f.actor.obsoleteLocator = (capability, locator) => {
      retirementCalls++;
      assert.equal(authority, true, 'retirement must run through managedWrite');
      return obsolete(capability, locator);
    };
    const managedWrite = owner.managedWrite.bind(owner);
    owner.managedWrite = job => managedWrite(async actor => {
      authority = true;
      try { return await job(actor); } finally { authority = false; }
    });
    owner.herdr = async (...args) => {
      calls.push({ args, authority });
      if (args[0] === 'get') {
        if (live) return { pane: { pane_id: record.paneId } };
        throw Object.assign(new Error('legacy pane unavailable'),
          { code: scenario === 'ambiguous-absence' ? 'transport_error' : 'pane_not_found' });
      }
      if (args[0] === 'list') return { panes: [{ pane_id: 'qa:parent', tab_id: 'qa:tab' },
        { pane_id: 'qa:replacement', tab_id: 'qa:tab' }] };
      if (args[0] === 'split') return { pane: { pane_id: 'qa:replacement' } };
      if (args[0] === 'process-info') return { process_info: { shell_pid: 456, foreground_processes: [] } };
      throw new Error('Unexpected native command: ' + args[0]);
    };
    const observe = f.actor.observe.bind(f.actor);
    f.actor.observe = async request => {
      if (!request.locator) return observe(request);
      if (scenario === 'unreadable-membership') throw new Error('membership unreadable');
      const actual = await observe(request);
      return { ...actual, missing: live ? undefined : { code: 'pane_not_found', paneId: record.paneId } };
    };
    owner.mutate = (role, type, target, args) => owner.managedWrite(actor =>
      actor.perform(actor.capability('todo', role), { type, target },
        async () => ({ result: await owner.herdr(...args), effects: Promise.resolve() })));
    // The launch receipt is synthetic; actual locator recovery, actor validation,
    // split authority and creation-record writes remain integrated.
    owner.launchTodo = async next => {
      await writeFile(owner.recordFile, JSON.stringify({ ...next, ready: true, processId: 5002 }));
      return next.paneId;
    };
    owner.watchRecoveryMembership = async () => {};
    if (scenario === 'owner-unheld') {
      const actor = owner.actor;
      owner.actor = undefined;
      try { await assert.rejects(owner.reconcileLegacy(owner.stateDir), /legacy tombstone requires held owner/); }
      finally { owner.actor = actor; }
    } else if (['live', 'ambiguous-absence', 'unreadable-membership'].includes(scenario)) {
      await assert.rejects(owner.reconcileLegacy(owner.stateDir),
        scenario === 'live' ? /legacy executable or viewer source mismatch/ :
          scenario === 'ambiguous-absence' ? /legacy pane unavailable/ : /membership unreadable/);
    } else {
      await owner.reconcileLegacy(owner.stateDir);
      assert.equal(f.actor.snapshot.closures.filter(entry => entry.paneId === record.paneId).length, 1);
      assert.deepEqual(JSON.parse(await readFile(owner.recordFile)), record,
        'actor retirement preserves the locator as evidence until normal replacement');
      if (scenario === 'reappeared') {
        live = true;
        await assert.rejects(owner.ensureTodo({ paneId: 'qa:parent', tabId: 'qa:tab' }, true));
      } else {
        assert.equal(await owner.ensureTodo({ paneId: 'qa:parent', tabId: 'qa:tab' }, true), 'qa:replacement');
        const current = JSON.parse(await readFile(owner.recordFile));
        assert.equal(current.viewerPath, owner.viewer);
        assert.equal(current.nodePath, owner.node);
        assert.notEqual(current.launchToken, record.launchToken);
        assert.ok(retirementCalls >= 2, 'consuming the tombstone revalidates actor authority and native absence');
        assert.ok(calls.filter(call => call.args[0] === 'split').every(call => call.authority));
      }
    }
    if (!scenario.startsWith('dead-')) {
      assert.deepEqual(JSON.parse(await readFile(owner.recordFile)), record);
      assert.equal(calls.filter(call => call.args[0] === 'split').length, 0);
    }
    assert.equal(calls.filter(call => call.args[0] === 'close').length, 0);
  });

test('task20 an already-painted current receipt still revalidates RECOVERING to READY', async t => {
  const f = await arrangeFixture(t);
  for (const [index, role] of ['todo', 'dag', 'workers'].entries()) {
    const participant = role === 'todo' ? 'todo' : 'dag';
    const target = { paneId: 'qa:' + role, tabId: 'qa:tab',
      shell: { pid: 800 + index, birth: '133800000000000000' },
      viewer: { pid: 900 + index, birth: '133900000000000000', executable: 'node.exe', argvDigest: 'b'.repeat(64) },
      statePath: join(f.directory, role + '.state'), sourcePath: join(f.directory, role + '.source'),
      cachePath: join(f.directory, role + '.cache'), prefsPath: join(f.directory, role + '.prefs'),
      launchToken: role + '-launch', controlToken: role + '-control' };
    await f.actor.registerRole(f.actor.capability(participant, role), target);
    await f.actor.ackRole({ ...f.actor.capability(participant, role), paneId: target.paneId,
      statePath: target.statePath, launchToken: target.launchToken, controlToken: target.controlToken,
      painted: true, sequence: 1 });
  }
  await f.actor.ready();
  await f.run();
  for (const role of ['todo', 'dag', 'workers']) {
    const target = f.actor.snapshot.roles[role];
    await f.actor.ackRole({ ...f.actor.capability(role === 'todo' ? 'todo' : 'dag', role),
      paneId: target.paneId, statePath: target.statePath, launchToken: target.launchToken,
      controlToken: target.controlToken, painted: true, sequence: 2 });
  }
  assert.equal(f.actor.snapshot.phase, 'RECOVERING');
  f.owner.presence = { getOwner: () => ({ ...f.owner.binding, scopeEpoch: 1 }), isReady: () => true };
  f.owner.bridge = { readinessChanged() {} };
  f.owner.paintManaged({ role: 'todo', sequence: 2 });
  await f.owner.managedIdle();
  assert.equal(f.actor.snapshot.phase, 'READY');
});

test('task20 native float32 split serialization does not lose exact swap completion', async t => {
  const f = await arrangeFixture(t, 'swap', 'native-f32');
  const result = await f.run();
  assert.equal(result.type, 'pane_swap');
  assert.equal(f.actor.snapshot.operations.at(-1).status, 'SETTLED');
});

test('task4 discovery is confined to the configured root and exact parent and socket', async t => {
  const f = await fixture(t);
  const own = { ...f.controller.binding, role: 'todo', paneId: 'qa:legacy' };
  const paths = [join(f.directory, 'old', 'todo.pane.json'),
    join(f.directory, 'other', 'todo.pane.json'), join(f.directory, 'socket', 'todo.pane.json')];
  for (const path of paths) await mkdir(join(path, '..'), { recursive: true });
  await writeFile(paths[0], JSON.stringify(own));
  await writeFile(paths[1], JSON.stringify({ ...own, parentPaneId: 'foreign:parent' }));
  await writeFile(paths[2], JSON.stringify({ ...own, socketPath: 'foreign-socket' }));
  const records = await dashboard.discoverLegacyRecords(f.directory, f.controller.binding);
  assert.deepEqual(records.map(entry => entry.path), [paths[0]]);
  assert.deepEqual(records[0].record, own);
});

test('task4 legacy identity requires native birth even when Herdr reports matching argv', async () => {
  const record = { paneId: 'qa:legacy', creationProcessId: 456, creationDate: '2026-10-03T00:00:00.000Z',
    creationBirth: '133800000000000000', processId: 123, viewerBirth: '133800000010000000',
    nodePath: 'node.exe', viewerPath: 'viewer.mjs', statePath: 'state.json', launchToken: 'launch' };
  const argv = ['node.exe', 'viewer.mjs', '--state', 'state.json', '--close-pane', 'qa:legacy', '--launch-token', 'launch'];
  const info = { process_info: { pane_id: record.paneId, shell_pid: 456, foreground_processes: [{ pid: 123, argv }] } };
  const shell = { ProcessId: 456, Birth: record.creationBirth, CreationDate: record.creationDate,
    ExecutablePath: 'powershell.exe', CommandLine: 'powershell.exe' };
  const child = { ProcessId: 123, ParentProcessId: 456, Birth: record.viewerBirth,
    CreationDate: '2026-10-03T00:00:01.000Z', ExecutablePath: 'node.exe', CommandLine: argv.join(' ') };
  assert.equal((await dashboard.legacyPaneIdentity(info, record, async () => [shell, child])).viewer.pid, 123);
  for (const rows of [[shell, { ...child, Birth: 'changed' }], [shell, child, { ...child, ProcessId: 124 }],
    [{ ...shell, Birth: 'changed' }, child], [shell, { ...child, CommandLine: child.CommandLine + ' extra' }]])
    assert.equal(await dashboard.legacyPaneIdentity(info, record, async () => rows), null);
  assert.equal(await dashboard.legacyPaneIdentity(info, record, async () => [shell, { ...child, Birth: undefined }]), null);
});

test('task4 native stderr RPC errors retain their exact absence classification', async t => {
  const directory = join(tmpdir(), `todo-rpc-${process.pid}-${randomUUID()}`);
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [stream, code] of [['stdout', 'pane_not_found'], ['stderr', 'pane_not_found'],
    ['stderr', 'invalid_request'], ['stderr', null]]) {
    const preload = join(directory, stream + '-' + code + '.mjs');
    const raw = code === null ? 'pane_not_found\n' : JSON.stringify({
      error: { code, message: 'native fixture' },
    }) + '\n';
    await writeFile(preload, `await new Promise(done => process.${stream}.write(${JSON.stringify(raw)}, done)); process.exit(1);`);
    const herdr = dashboard.createDashboardHerdr({ ...process.env, HERDR_BIN_PATH: process.execPath,
      NODE_OPTIONS: '--import=' + pathToFileURL(preload).href });
    await assert.rejects(herdr('get', 'qa:absent'), error =>
      error.code === (code ?? 1) && dashboard.authoritativePaneNotFound(error) === (code === 'pane_not_found'));
  }
});

test('task4 authoritative Todo tombstone stops obsolete anchor verification', async t => {
  const f = await fixture(t);
  f.ready.resolve();
  f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider,
    { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const record = JSON.parse(await readFile(f.controller.recordFile, 'utf8'));
  f.panes.delete(record.paneId);
  const closure = { role: 'todo', paneId: record.paneId, sessionId: record.sessionId, reason: 'pane_not_found' };
  f.controller.actor = { snapshot: { closures: [{ ...closure, sessionId: 'foreign-session' }] } };
  try {
    const queries = f.calls.length;
    await assert.rejects(f.controller.coordinator().inspectTodo());
    assert.deepEqual(f.calls.slice(queries), [['list']]);
    f.controller.actor.snapshot.closures = [closure];
    assert.equal(await f.controller.coordinator().inspectTodo(), null);
    assert.equal(f.calls.length, queries + 1);
  } finally { f.controller.actor = undefined; }
});

test('task4 PREPARED empty shell is retained and receives one run without another split', async t => {
  const f = await fixture(t);
  f.ready.resolve();
  const original = f.controller.herdr;
  const shell = { ProcessId: 7100, Birth: '133800000000000000', ExecutablePath: 'powershell.exe',
    CommandLine: 'powershell.exe', CreationDate: '2026-10-03T00:00:00.000Z' };
  f.panes.set('qa:prepared', { pane_id: 'qa:prepared', tab_id: 'qa:tab' });
  f.controller.herdr = async (...args) => args[0] === 'process-info'
    ? { process_info: { pane_id: args[2], shell_pid: 7100,
      foreground_processes: [{ pid: 7100, argv: ['powershell.exe'] }] } } : original(...args);
  f.controller.inspectShell = async () => [shell, ...[...f.processes.values()].flat().map(row => ({
    ProcessId: row.pid, ParentProcessId: 7100, Birth: '133800000010000000',
    CreationDate: '2026-10-03T00:00:01.000Z', ExecutablePath: row.argv[0],
    CommandLine: row.argv.map(value => `"${value}"`).join(' ') }))];
  const record = { schema: 'omo-herdr-dashboard/pane/1', ...f.controller.binding, role: 'todo',
    paneId: 'qa:prepared', tabId: 'qa:tab', scopeEpoch: f.controller.scopeEpoch,
    launchToken: 'prepared-token', statePath: f.controller.stateFile, viewerPath: f.controller.viewer,
    nodePath: f.controller.node, creationProcessId: shell.ProcessId, creationDate: shell.CreationDate,
    creationBirth: shell.Birth, attempted: true, prepared: true, ready: false };
  await writeFile(f.controller.recordFile, JSON.stringify(record));
  await writeFile(f.controller.stateFile, JSON.stringify(f.controller.roleState(record)));
  assert.equal(await f.controller.ensureTodo(null, false), record.paneId);
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 0);
  assert.equal(f.calls.filter(call => call[0] === 'run').length, 1);
  assert.equal((await readRoleState(f.controller.stateFile)).paneId, record.paneId);
});

for (const role of ['todo', 'dag', 'workers']) for (const sameSession of [false, true])
  test(`task5 successor discovers the original empty ${role} shell after viewer death (${sameSession ? 'resume' : 'fresh'})`, async t => {
    const f = await fixture(t);
    const old = new TodoPane({ ctx: { sessionManager: { getSessionId: () =>
      sameSession ? f.controller.binding.sessionId : 'prior-session' } },
      environment: f.controller.environment, stateDir: f.directory, cwd: f.directory,
      node: f.controller.node, viewer: f.controller.viewer });
    const shell = { ProcessId: 7100, Birth: '133800000000000000', ExecutablePath: 'powershell.exe',
      CommandLine: 'powershell.exe', CreationDate: '2026-10-03T00:00:00.000Z' };
    const directory = join(f.directory, 'legacy');
    await mkdir(directory);
    const record = { schema: 'omo-herdr-dashboard/pane/1', ...old.binding, role,
      paneId: 'qa:retained', tabId: 'qa:tab', scopeEpoch: 1, launchToken: 'old-token',
      statePath: join(directory, `${role}.json`), viewerPath: f.controller.viewer,
      nodePath: f.controller.node, creationProcessId: shell.ProcessId, creationDate: shell.CreationDate,
      creationBirth: shell.Birth, processId: 5001, viewerBirth: '133800000010000000',
      prepared: true, ready: true, manualClose: false };
    const path = join(directory, `${role}.pane.json`);
    const state = { ...f.controller.roleState(record), ...old.binding, role,
      managedScope: { generation: 1, sessionId: old.binding.sessionId,
        participant: role === 'todo' ? 'todo' : 'dag', lifetimeId: 'prior-lifetime' },
      cachePath: role === 'todo' ? join(directory, `${role}.cache.json`) : record.statePath,
      prefsPath: join(directory, `${role}.prefs.json`) };
    const registered = { ...record, generation: 1, participant: state.managedScope.participant,
      lifetimeId: state.managedScope.lifetimeId, shell: { pid: shell.ProcessId, birth: shell.Birth },
      viewer: { pid: record.processId, birth: record.viewerBirth, executable: record.nodePath, argvDigest: 'a'.repeat(64) },
      sourcePath: 'prior.jsonl', cachePath: state.cachePath, prefsPath: state.prefsPath, controlToken: 'old-control' };
    await writeFile(path, JSON.stringify(record)); await writeFile(record.statePath, JSON.stringify(state));
    f.panes.set(record.paneId, { pane_id: record.paneId, tab_id: record.tabId });
    const herdr = f.controller.herdr;
    f.controller.herdr = async (...args) => {
      if (args[0] === 'process-info') return { process_info: { pane_id: record.paneId, shell_pid: shell.ProcessId,
        foreground_processes: f.processes.get(record.paneId) ?? [{ pid: shell.ProcessId, argv: [shell.ExecutablePath] }] } };
      if (args[0] === 'layout') return { layout: { tab_id: record.tabId,
        panes: [...f.panes.values()].map(pane => ({ ...pane, rect: { x: 0, y: 0, width: 80, height: 24 } })) } };
      return herdr(...args);
    };
    f.controller.inspectShell = async () => [shell];
    const parent = { paneId: f.controller.binding.parentPaneId, tabId: record.tabId,
      shell: { pid: 7000, birth: 'parent-birth' } };
    const producer = { pid: process.pid, birth: 'current-birth', executable: process.execPath, argvDigest: 'b'.repeat(64) };
    f.controller.actor = { leaseHeld: true, blocked: false, draining: false, snapshot: {
      ownerNonce: 'current-owner', sessionId: f.controller.binding.sessionId, generation: 2, parent, producer,
      participants: { todo: { lifetimeId: f.controller.lifetimeId, drained: false } },
      roles: { [role]: registered }, operations: [], closures: [] } };
    f.controller.publisherScope = { ...f.controller.actor.snapshot, lifetimeId: f.controller.lifetimeId };
    f.controller.claimRetired = true;
    try {
      assert.equal(f.controller.viewerDeaths.size, 0, 'Successor has no inherited in-memory death witness');
      assert.equal(await dashboard.legacyPaneIdentity(await f.controller.herdr('process-info', '--pane', record.paneId),
        record, f.controller.inspectShell), null, 'The ordinary live-viewer guard remains strict');
      const retained = await f.controller.reconcileLegacy(f.directory);
      assert.equal(retained.length, 1);
      assert.equal(retained[0].state, 'retained');
      assert.equal(retained[0].empty, true);
      assert.deepEqual(retained[0].identity, { shell: { pid: shell.ProcessId, birth: shell.Birth,
        executable: shell.ExecutablePath, argvDigest: createHash('sha256').update(shell.CommandLine).digest('hex') } });
      assert.equal(Object.hasOwn(retained[0].target, 'viewer'), false);
      assert.equal(f.calls.filter(call => ['split', 'run', 'close'].includes(call[0])).length, 0);
      for (const rows of [[{ ...shell, Birth: 'wrong-birth' }], [shell, {
        ProcessId: 5002, ParentProcessId: shell.ProcessId, Birth: '133800000020000000',
        ExecutablePath: 'foreign.exe', CommandLine: 'foreign.exe', CreationDate: '2026-10-03T00:00:02.000Z' }]]) {
        f.controller.inspectShell = async () => rows;
        await assert.rejects(f.controller.reconcileLegacy(f.directory), { inlineFallback: true });
      }
      f.controller.inspectShell = async () => [shell];
      f.controller.claimRetired = false;
      await assert.rejects(f.controller.reconcileLegacy(f.directory), { inlineFallback: true });
      f.controller.claimRetired = true;
      f.controller.actor.leaseHeld = false;
      await assert.rejects(f.controller.reconcileLegacy(f.directory), { inlineFallback: true });
      f.controller.actor.leaseHeld = true;
      const oldBytes = await readFile(record.statePath);
      await writeFile(record.statePath, JSON.stringify({ ...state, managedScope: { ...state.managedScope, generation: 9 } }));
      await assert.rejects(f.controller.reconcileLegacy(f.directory), { inlineFallback: true });
      await writeFile(record.statePath, oldBytes);
      if (role === 'todo') {
        const calls = f.calls.length;
        assert.equal(await f.controller.replaceRetainedTodo(retained[0]), record.paneId);
        const next = JSON.parse(await readFile(f.controller.recordFile, 'utf8'));
        assert.equal(next.paneId, record.paneId);
        assert.equal(next.creationBirth, record.creationBirth);
        assert.notEqual(next.launchToken, record.launchToken);
        assert.equal(next.sessionId, f.controller.binding.sessionId);
        assert.equal(f.calls.slice(calls).filter(call => call[0] === 'run').length, 1);
        assert.equal(f.calls.slice(calls).filter(call => ['split', 'close'].includes(call[0])).length, 0);
      }
    } finally { f.controller.actor = undefined; }
  });

for (const [state, explicit, replaced] of [['invalid', true, true], ['pending', true, false], ['invalid', false, false]]) {
  test(`task25 ${state} observation on ${explicit ? 'explicit' : 'ordinary'} retry`, async t => {
    const f = await fixture(t);
    const record = { schema: 'omo-herdr-dashboard/pane/1', ...f.controller.binding, role: 'todo',
      paneId: 'qa:legacy', tabId: 'qa:tab', scopeEpoch: 0, processId: 5001, launchToken: 'legacy-token',
      statePath: f.controller.stateFile, nodePath: f.controller.node, viewerPath: f.controller.viewer };
    const path = join(f.directory, 'legacy', 'todo.pane.json');
    await mkdir(join(f.directory, 'legacy'));
    await writeFile(path, JSON.stringify(record));
    await writeFile(f.controller.stateFile, JSON.stringify(f.controller.roleState(record)));
    f.panes.set(record.paneId, { pane_id: record.paneId, tab_id: record.tabId });
    const original = f.controller.herdr;
    f.controller.herdr = async (...args) => args[0] === 'process-info' ? { process_info: {} } : original(...args);
    let disposed = 0, captured = 0;
    const old = { dispose: async () => { disposed++; } };
    const fresh = { dispose: async () => {}, release: async () => { throw new Error('logical pending capture'); } };
    f.controller.legacyObservations.set(path, old);
    // Dependency mocks describe observer validity only. Neither object can
    // construct native retirement authority in the module-private WeakMap.
    f.controller.legacyObservationState = value => value === old ? state : 'pending';
    f.controller.captureLegacyProducer = async () => { captured++; return fresh; };
    f.controller.recoveryRetry = explicit;
    f.controller.actor = { snapshot: { parent: { paneId: 'qa:parent', tabId: 'qa:tab',
      shell: { pid: 7100, birth: '133800000000000000' } }, generation: 1, roles: {}, closures: [] },
      paths: { slotPath: join(f.directory, 'slot.json') } };
    try {
      await assert.rejects(f.controller.reconcileLegacy(f.directory,
        async () => ({ shell: { pid: 7200, birth: '133800000010000000' },
          viewer: { pid: 5001, birth: '133800000020000000', executable: 'node', argvDigest: 'a'.repeat(64) } })),
      { inlineFallback: true });
      assert.equal(disposed, replaced ? 1 : 0);
      assert.equal(captured, replaced ? 1 : 0);
      assert.equal(f.controller.legacyObservations.get(path), replaced ? fresh : old);
      assert.equal(f.calls.filter(call => ['split', 'run', 'close'].includes(call[0])).length, 0);
    } finally { f.controller.actor = undefined; }
  });
}

test('task4 changed native shell birth refuses before rewriting role state', async t => {
  const f = await fixture(t);
  f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const record = JSON.parse(await readFile(f.controller.recordFile, 'utf8'));
  Object.assign(record, { creationProcessId: 7100, creationDate: '2026-10-03T00:00:00.000Z',
    creationBirth: 'wrong-native-birth', viewerBirth: '133800000010000000' });
  await writeFile(f.controller.recordFile, JSON.stringify(record));
  const state = await readRoleState(f.controller.stateFile);
  await writeFile(f.controller.stateFile, JSON.stringify({ ...state, connected: false }));
  const before = await readFile(f.controller.stateFile);
  const original = f.controller.herdr;
  f.controller.herdr = async (...args) => args[0] === 'process-info'
    ? { process_info: { pane_id: args[2], shell_pid: 7100, foreground_processes: f.processes.get(args[2]) } }
    : original(...args);
  f.controller.inspectShell = async () => [
    { ProcessId: 7100, Birth: '133800000000000000', CreationDate: record.creationDate,
      ExecutablePath: 'powershell.exe', CommandLine: 'powershell.exe' },
    ...f.processes.get(record.paneId).map(row => ({ ProcessId: row.pid, ParentProcessId: 7100,
      Birth: record.viewerBirth, CreationDate: '2026-10-03T00:00:01.000Z',
      ExecutablePath: row.argv[0], CommandLine: row.argv.map(value => `"${value}"`).join(' ') })),
  ];
  f.controller.managed = true;
  f.controller.actor = { leaseHeld: true, blocked: false, draining: false,
    snapshot: { roles: {}, parent: { paneId: 'qa:parent', tabId: 'qa:tab' } } };
  const count = f.calls.filter(call => ['split', 'run', 'close'].includes(call[0])).length;
  try {
    await assert.rejects(f.controller.ensureTodo(null, false), { inlineFallback: true });
    assert.deepEqual(await readFile(f.controller.stateFile), before);
    assert.equal(f.calls.filter(call => ['split', 'run', 'close'].includes(call[0])).length, count);
  } finally { f.controller.actor = undefined; f.controller.managed = false; }
});

async function shutdownAuthorityFixture(t) {
  const directory = join(tmpdir(), `task33-shutdown-${process.pid}-${randomUUID()}`);
  console.log(JSON.stringify({ event: 'resource-planned', scope: 'logical-task33', pid: process.pid, directory }));
  await mkdir(directory);
  const sessionId = 'task33-session', socketPath = `\\\\.\\pipe\\task33-${randomUUID()}`;
  const parent = { paneId: 'qa:parent', tabId: 'qa:tab', shell: { pid: 7100, birth: 'logical-parent-birth' } };
  const producer = { pid: process.pid, birth: 'logical-producer-birth',
    executable: process.execPath, argvDigest: 'a'.repeat(64) };
  const controller = new TodoPane({
    ctx: { sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(directory, 'source.jsonl') } },
    environment: { HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: parent.paneId },
    stateDir: directory, cwd: directory, viewer: join(directory, 'viewer.mjs'), managed: true,
  });
  await mkdir(controller.directory);
  controller.scopeEpoch = 1;
  controller.storage = { path: join(controller.directory, 'scope-1', 'todo.cache.json') };
  // Real SQLite ownership and actor validation; the native observation boundary
  // is a logical fixture. These tests make no SDK/native retirement claim.
  const actor = await claimParentSlot({ stateDir: directory, socketPath, parent, producer, sessionId,
    observe: async ({ target }) => ({ parent, producer, target }) });
  await actor.join('todo', controller.lifetimeId);
  controller.actor = actor;
  controller.publisherScope = Object.freeze({ ownerNonce: actor.snapshot.ownerNonce,
    generation: actor.snapshot.generation, sessionId, lifetimeId: controller.lifetimeId, parent, producer });
  const record = { schema: 'omo-herdr-dashboard/pane/1', ...controller.binding, role: 'todo',
    tabId: parent.tabId, paneId: 'qa:todo', statePath: controller.stateFile, viewerPath: controller.viewer,
    nodePath: process.execPath, scopeEpoch: 1, launchToken: 'task33-launch', processId: 5001 };
  const target = { paneId: record.paneId, tabId: record.tabId,
    shell: { pid: 7101, birth: 'logical-role-shell' },
    viewer: { pid: record.processId, birth: 'logical-viewer-birth',
      executable: record.nodePath, argvDigest: 'b'.repeat(64) },
    statePath: controller.stateFile, sourcePath: join(directory, 'source.jsonl'),
    cachePath: controller.storage.path, prefsPath: `${controller.stateFile}.view.json`,
    launchToken: record.launchToken, controlToken: controller.controlToken };
  await actor.registerRole(actor.capability('todo', 'todo'), target);
  const state = { schema: 'omo-herdr-dashboard/role/1', ...controller.binding,
    role: 'todo', tabId: record.tabId, paneId: record.paneId, scopeEpoch: 1,
    launchToken: record.launchToken, connected: true, cachePath: target.cachePath, prefsPath: target.prefsPath,
    managedScope: { ownerNonce: actor.snapshot.ownerNonce, generation: actor.snapshot.generation,
      sessionId, participant: 'todo', lifetimeId: controller.lifetimeId },
    presenceOffer: { token: 'original-presence' }, controlOffer: { token: controller.controlToken } };
  await writeFile(controller.recordFile, JSON.stringify(record));
  await writeFile(controller.stateFile, JSON.stringify(state));
  controller.observeManaged = async ({ target } = {}) => ({ parent, producer, target });
  let restored = 0;
  controller.bridge = { remove() { restored++; } };
  t.after(async () => {
    if (actor.leaseHeld) {
      await actor.drain('todo', controller.lifetimeId);
      await actor.release();
    }
    await rm(directory, { recursive: true, force: true });
    console.log(JSON.stringify({ event: 'resource-cleaned', scope: 'logical-task33', directory }));
  });
  return { controller, actor, record, state, get restored() { return restored; } };
}

for (const authority of ['no-actor', 'lost-lease', 'stale-generation', 'foreign-owner'])
  test(`task33 ${authority} shutdown preserves incumbent role, record and actor bytes`, async t => {
    const f = await shutdownAuthorityFixture(t);
    const beforeState = await readFile(f.controller.stateFile), beforeRecord = await readFile(f.controller.recordFile);
    const beforeSlot = await readFile(f.actor.paths.slotPath);
    if (authority === 'no-actor') { f.controller.actor = undefined; f.controller.publisherScope = undefined; }
    else if (authority === 'lost-lease') {
      f.actor.db.exec('ROLLBACK'); f.actor.db.close();
    } else {
      const original = f.actor.snapshot;
      const other = authority === 'stale-generation'
        ? { ...original, generation: original.generation + 1 }
        : { ...original, ownerNonce: 'foreign-owner' };
      f.controller.actor = new Proxy(f.actor, { get(target, key) {
        return key === 'snapshot' ? other : Reflect.get(target, key);
      } });
    }
    await f.controller.stop();
    assert.deepEqual(await readFile(f.controller.stateFile), beforeState);
    assert.deepEqual(await readFile(f.controller.recordFile), beforeRecord);
    assert.deepEqual(await readFile(f.actor.paths.slotPath), beforeSlot);
    assert.equal(f.restored, 1);
  });

test('task33 legitimate current owner publishes disconnected state and drains its exact claim', async t => {
  const f = await shutdownAuthorityFixture(t);
  const beforeRecord = await readFile(f.controller.recordFile);
  await f.controller.stop();
  const state = await readRoleState(f.controller.stateFile);
  assert.equal(state.connected, false);
  assert.equal(state.controlOffer, null); assert.equal(state.presenceOffer, null);
  assert.equal(state.managedScope.ownerNonce, f.controller.publisherScope.ownerNonce);
  assert.equal(state.managedScope.generation, f.controller.publisherScope.generation);
  assert.equal(state.managedScope.lifetimeId, f.controller.lifetimeId);
  assert.deepEqual(await readFile(f.controller.recordFile), beforeRecord);
  assert.equal(f.actor.snapshot.phase, 'RELEASED');
  assert.equal(f.actor.leaseHeld, false);
  assert.equal(f.actor.snapshot.participants.todo.drained, true);
  assert.equal(f.restored, 1);
});

test('task5 DAG arriving during retained Todo recovery joins before fixed retirement', { timeout: 5000 }, async t => {
  const f = await shutdownAuthorityFixture(t), entered = deferred(), resume = deferred();
  const boundary = new Error('controlled fixed retirement boundary');
  const provider = {
    lifetimeId: 'current-dag-lifetime', binding: f.controller.binding, sourceReady: Promise.resolve(),
    preflightRecovery: async () => [{ state: 'retained', record: { role: 'dag' } }],
    replaceRetained: async entries => {
      const capability = f.actor.capability('dag', entries[0].record.role);
      assert.equal(capability.lifetimeId, provider.lifetimeId);
      throw boundary;
    },
  };
  f.controller.bridge.readinessChanged = () => {};
  f.controller.watchRecoveryMembership = async () => {};
  f.controller.reconcileLegacy = async () => { entered.resolve(); await resume.promise; return []; };
  const scheduled = f.controller.schedule();
  scheduled.catch(() => {});
  await entered.promise;
  f.controller.provider = provider;
  resume.resolve();
  try { await assert.rejects(scheduled, error => error === boundary); }
  finally {
    f.controller.provider = null;
    if (f.actor.snapshot.participants.dag?.lifetimeId === provider.lifetimeId)
      await f.actor.drain('dag', provider.lifetimeId);
  }
});

for (const observation of ['empty', 'foreign-child', 'wrong-birth', 'wrong-death-birth',
  'wrong-token', 'wrong-generation', 'no-death', 'manual-close', 'unsettled-effects'])
  test(`task5 observed Todo death during queued registration retains ${observation} protection`, { timeout: 5000 }, async t => {
    if (process.platform !== 'win32') return;
    const f = await shutdownAuthorityFixture(t), entered = deferred(), resume = deferred();
    const shell = { ProcessId: 7101, Birth: 'logical-role-shell', CreationDate: '2026-10-03T00:00:00.000Z',
      ExecutablePath: 'powershell.exe', CommandLine: 'powershell.exe' };
    const record = { ...f.record, creationProcessId: shell.ProcessId, creationDate: shell.CreationDate,
      creationBirth: shell.Birth, viewerBirth: 'logical-viewer-birth', ready: true, manualClose: false };
    const argv = [record.nodePath, record.viewerPath, '--state', record.statePath,
      '--close-pane', record.paneId, '--launch-token', record.launchToken];
    const child = { ProcessId: record.processId, ParentProcessId: shell.ProcessId, Birth: record.viewerBirth,
      CreationDate: '2026-10-03T00:00:01.000Z', ExecutablePath: record.nodePath,
      CommandLine: argv.map(value => `"${value}"`).join(' ') };
    const role = f.actor.snapshot.roles.todo;
    const target = Object.fromEntries(['paneId', 'tabId', 'shell', 'viewer', 'statePath', 'sourcePath',
      'cachePath', 'prefsPath', 'launchToken', 'controlToken'].map(key => [key, role[key]]));
    target.viewer = { ...target.viewer, argvDigest: createHash('sha256').update(child.CommandLine).digest('hex') };
    await f.actor.registerRole(f.actor.capability('todo', 'todo'), target);
    await writeFile(f.controller.recordFile, JSON.stringify(record));
    let beforeSlot = await readFile(f.actor.paths.slotPath);
    let inspections = 0;
    f.controller.inspectShell = async () => {
      if (++inspections === 1) return [shell, child];
      if (inspections === 2) { entered.resolve(); await resume.promise; }
      return [shell, ...(!['foreign-child', 'wrong-birth'].includes(observation) ? [] : [{ ...child,
        ...(observation === 'foreign-child' ? { ProcessId: 5002 } : { Birth: 'wrong-viewer-birth' }) }])];
    };
    f.controller.herdr = async (...args) => {
      if (args[0] === 'list') return { panes: [
        { pane_id: f.controller.binding.parentPaneId, tab_id: record.tabId },
        { pane_id: record.paneId, tab_id: record.tabId },
      ] };
      assert.equal(args[0], 'process-info');
      return { process_info: { pane_id: record.paneId, shell_pid: shell.ProcessId,
        foreground_processes: [{ pid: shell.ProcessId, argv: ['powershell.exe'] }] } };
    };
    f.controller.bridge = { readinessChanged() {}, invalidate() {} };
    f.controller.presence = { offer: () => f.state.presenceOffer, idle: async () => {} };
    f.controller.watchRecoveryMembership = async () => {};
    const launches = [];
    f.controller.launchTodo = async next => { launches.push(next); return next.paneId; };
    let pendingEffect;
    const effectReleased = deferred();
    const expectedRecord = { ...record, ...(observation === 'manual-close' ? { manualClose: true } : {}) };
    const adopting = f.controller.ensureTodo(null, false);
    adopting.catch(() => {});
    try {
      await entered.promise;
      // Logical native boundary: the existing retained observer reports death
      // before the already-started registration query returns. No native claim.
      if (observation !== 'no-death') f.controller.viewerDeaths.set('todo', {
        identity: { ...target.viewer, ...(observation === 'wrong-death-birth' ? { birth: 'wrong-original-birth' } : {}) },
        target, record: { ...record, ...(observation === 'wrong-token' ? { launchToken: 'wrong-original-token' } : {}) },
        exit: { exitCode: -1, disposed: false },
      });
      if (observation === 'wrong-generation') {
        const current = f.actor.snapshot;
        f.controller.actor = new Proxy(f.actor, { get(target, key) {
          return key === 'snapshot' ? { ...current, generation: current.generation + 1 } : Reflect.get(target, key);
        } });
      }
      if (observation === 'manual-close') await writeFile(f.controller.recordFile, JSON.stringify(expectedRecord));
      if (observation === 'unsettled-effects') {
        const dispatched = deferred();
        pendingEffect = f.actor.perform(f.actor.capability('todo', 'todo'), { type: 'run', target }, () => {
          dispatched.resolve();
          return { result: record.paneId, effects: effectReleased.promise };
        });
        pendingEffect.catch(() => {});
        await dispatched.promise;
        beforeSlot = await readFile(f.actor.paths.slotPath);
      }
      resume.resolve();
      if (observation === 'empty') {
        assert.equal(await adopting, record.paneId);
        assert.equal(launches.length, 1);
        assert.equal(launches[0].prepared, true); assert.equal(launches[0].ready, false);
        assert.equal(launches[0].processId, undefined); assert.equal(launches[0].viewerBirth, undefined);
        assert.notEqual(launches[0].launchToken, record.launchToken);
        assert.equal(f.controller.viewerDeaths.has('todo'), false);
      } else {
        await assert.rejects(adopting, error => error.inlineFallback === true);
        assert.equal(launches.length, 0);
        assert.deepEqual(await readFile(f.controller.recordFile), Buffer.from(JSON.stringify(expectedRecord)));
      }
      assert.deepEqual(await readFile(f.actor.paths.slotPath), beforeSlot);
    } finally {
      resume.resolve(); effectReleased.resolve();
      await adopting.catch(() => {}); await pendingEffect;
    }
  });

test('task41 custody disposal pipe loss requires original native producer death', () => {
  if (process.platform !== 'win32') return;
  // Execute the machine-consumed production disposal branch, not a copy of its
  // condition. The native process and pipe boundaries are real and only owned.
  const source = dashboard.captureLegacyProducer.toString();
  const start = source.indexOf('$custodyInvalid=$true;$disposing=$true');
  const end = source.indexOf("\n}else{throw 'invalid custody observer action'}", start);
  const disposal = source.slice(start, end);
  for (const dead of [false, true]) {
    const script = `$ErrorActionPreference='Stop'
$producer=[Diagnostics.Process]::new()
$producer.StartInfo.FileName='${process.execPath.replaceAll("'", "''")}'
$producer.StartInfo.Arguments='-e "process.stdin.resume()"'
$producer.StartInfo.UseShellExecute=$false
$producer.StartInfo.RedirectStandardInput=$true
$producer.StartInfo.CreateNoWindow=$true
$server=$null;$pipe=$null;$processWait=$null
try{
$null=$producer.Start();$handle=$producer.Handle
$peer=$producer.Id;$born=$producer.StartTime.ToUniversalTime().ToFileTimeUtc()
$processWait=[Threading.ManualResetEvent]::new($false)
$processWait.SafeWaitHandle=[Microsoft.Win32.SafeHandles.SafeWaitHandle]::new($handle,$false)
$name='task41-'+[guid]::NewGuid().ToString()
$server=[IO.Pipes.NamedPipeServerStream]::new($name,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous)
$connected=$server.WaitForConnectionAsync()
$pipe=[IO.Pipes.NamedPipeClientStream]::new('.',$name,[IO.Pipes.PipeDirection]::InOut)
$pipe.Connect(3000);if(!$connected.Wait(3000)){throw 'owned pipe connection deadline'}
$writer=[IO.StreamWriter]::new($pipe,[Text.UTF8Encoding]::new($false),4096,$true);$writer.AutoFlush=$true
$server.Dispose();$server=$null
${dead ? "$producer.StandardInput.Close();if(!$producer.WaitForExit(3000)){throw 'owned producer exit deadline'}" : ''}
$disposed=[pscustomobject]@{type='custody-disposed'};$pipeRead=$true
$rejected=$false
try{while($true){${disposal}
break}}catch [IO.IOException]{$rejected=$true}
[Console]::WriteLine((@{rejected=$rejected;originalProducerDead=$processWait.WaitOne(0)}|ConvertTo-Json -Compress))
}finally{
if(!$producer.HasExited){$producer.StandardInput.Close();if(!$producer.WaitForExit(3000)){$producer.Kill();$producer.WaitForExit()}}
if($processWait){$processWait.Dispose()};if($pipe){$pipe.Dispose()};if($server){$server.Dispose()};$producer.Dispose()
}`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 });
    const lines = output.trim().split(/\r?\n/);
    const observed = JSON.parse(lines.find(line => line.startsWith('DISPOSE_PIPE_ERROR ')).slice(19));
    assert.equal(observed.originalProducerDead, dead);
    assert.deepEqual(JSON.parse(lines.at(-1)), { rejected: !dead, originalProducerDead: dead });
  }
});

test('task44 complete custody helper lifecycle and task45 failed fixture cleanup', async t => {
  if (process.platform !== 'win32') return;
  for (const mode of ['setup-failure', 'abort', 'dead', 'live-eof', 'eof-then-dead', 'disposing-eof', 'live-acked', 'live-loss', 'live-effect']) await t.test(mode, { timeout: 15000 }, async t => {
  const pipePath = `\\\\.\\pipe\\task44-${randomUUID()}`, nonce = randomUUID();
  const peerScript = `$ErrorActionPreference='Stop'
$server=[IO.Pipes.NamedPipeServerStream]::new('${pipePath.slice(9)}',[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous)
$gate=${mode === 'live-loss' ? `[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,'Local\\omo-restart-qa-dispose-${nonce}')` : '$null'}
try{
[Console]::WriteLine('PEER_READY')
$server.WaitForConnection()
$reader=[IO.StreamReader]::new($server,[Text.UTF8Encoding]::new($false),$false,4096,$true)
$writer=[IO.StreamWriter]::new($server,[Text.UTF8Encoding]::new($false),4096,$true);$writer.AutoFlush=$true
$raw=$reader.ReadLine();if(!$raw){return}
$request=ConvertFrom-Json $raw;$request.type='observing'
$writer.WriteLine((ConvertTo-Json -InputObject $request -Compress))
${mode === 'live-loss' ? '$clientRead=$null' : '$clientRead=$reader.ReadLineAsync()'}
while($true){
$mode=[Console]::ReadLine()
if($null -eq $mode){break}
if($mode -eq 'effect'){
$effect=ConvertFrom-Json $raw;$effect.type='custody-effect'
$effect|Add-Member operation ([pscustomobject]@{id='owned-operation';ownerNonce='owned-owner';generation=2;revision=7})
$writer.WriteLine((ConvertTo-Json -InputObject $effect -Compress -Depth 8))
if(!$clientRead.Wait(3000) -or !$clientRead.Result){throw 'owned effect acknowledgement unavailable'}
$invalidated=ConvertFrom-Json $clientRead.Result
$effect.type='custody-invalidated'
if((ConvertTo-Json -InputObject $invalidated -Compress -Depth 8) -cne (ConvertTo-Json -InputObject $effect -Compress -Depth 8)){throw 'owned effect acknowledgement changed'}
[Console]::WriteLine('EFFECT_ACK '+(ConvertTo-Json -InputObject $invalidated -Compress -Depth 8))
$clientRead=$reader.ReadLineAsync();continue
}
if($mode -eq 'ack' -or $mode -eq 'lose-after-dispose'){
if(!$clientRead.Wait(3000) -or !$clientRead.Result){throw 'owned disposal request unavailable'}
$disposed=ConvertFrom-Json $clientRead.Result
if($disposed.type -cne 'custody-disposed' -or $disposed.nonce -cne $request.nonce -or $disposed.token -cne $request.token){throw 'owned disposal binding changed'}
[Console]::WriteLine('DISPOSAL_REQUEST '+(ConvertTo-Json -InputObject $disposed -Compress))
if($mode -eq 'ack'){
$writer.WriteLine((ConvertTo-Json -InputObject $disposed -Compress))
[Console]::WriteLine('DISPOSAL_ACK '+(ConvertTo-Json -InputObject $disposed -Compress))
$clientRead=$reader.ReadLineAsync();continue
}
}
if($mode -ne 'lose' -and $mode -ne 'lose-after-dispose'){throw 'invalid owned peer action'}
if($clientRead){[Console]::WriteLine('CLIENT_STATE '+(ConvertTo-Json -InputObject @{producerPid=$PID;completed=$clientRead.IsCompleted;message=$(if($clientRead.IsCompleted){ConvertFrom-Json $clientRead.Result}else{$null})} -Compress -Depth 8))}
$server.Disconnect()
[Console]::WriteLine('PIPE_DISCONNECTED '+(ConvertTo-Json -InputObject @{producerPid=$PID;connected=$server.IsConnected;handle=$server.SafePipeHandle.DangerousGetHandle().ToInt64().ToString()} -Compress))
if($gate){$null=$gate.Set()}
}
}finally{
if($gate){
$gateHandle=$gate.SafeWaitHandle;$null=$gate.Set();$gate.Dispose()
[Console]::WriteLine('GATE_CLOSED '+(ConvertTo-Json -InputObject @{producerPid=$PID;nonce='${nonce}';closed=$gateHandle.IsClosed} -Compress))
}
$server.Dispose()
}`;
  if (mode === 'live-loss') console.log(JSON.stringify({ event: 'task44-owned-gate-planned',
    name: `Local\\omo-restart-qa-dispose-${nonce}`, nonce, scope: 'disposal-write fault only' }));
  const peer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(peerScript, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let peerError, helper, helperClosed, cleanupResult, stdout = '', stderr = '';
  let peerStdout = '', peerStderr = '';
  const peerEvents = new EventEmitter();
  const helperEvents = new EventEmitter();
  const eventsAbort = new AbortController();
  const peerClosed = new Promise(resolve => {
    peer.once('error', error => { peerError = error; });
    peer.once('close', (code, signal) => resolve({ code, signal,
      stdoutEOF: peer.stdout.readableEnded, stderrEOF: peer.stderr.readableEnded }));
  });
  const bounded = async promise => {
    const deadline = AbortSignal.timeout(3000);
    const aborted = deferred();
    const reject = () => aborted.resolve({ timeout: true });
    deadline.addEventListener('abort', reject, { once: true });
    try {
      const result = await Promise.race([promise, aborted.promise]);
      assert.notEqual(result?.timeout, true, 'owned original event deadline');
      return result;
    } finally { deadline.removeEventListener('abort', reject); }
  };
  const cleanup = () => cleanupResult ??= (async () => {
    const errors = [];
    let producer, observer;
    try {
      if (!helper) {
        try {
          await bounded(ready);
          const release = net.createConnection(pipePath);
          const releaseClosed = new Promise(resolve => release.once('close', resolve));
          release.on('error', error => errors.push(error));
          try {
            release.resume();
            await bounded(once(release, 'connect'));
            release.end();
            await bounded(releaseClosed);
          } finally {
            release.destroy();
            await bounded(releaseClosed);
          }
        } catch (error) { errors.push(error); }
      }
      peer.stdin.end();
      try { producer = await bounded(peerClosed); }
      catch (error) {
        errors.push(error); peer.kill();
        try { producer = await bounded(peerClosed); } catch (error) { errors.push(error); }
      }
      try {
        if (helper && helper.exitCode === null && !helper.stdin.writableEnded) helper.stdin.end('dispose\n');
        if (helperClosed) observer = await bounded(helperClosed);
      } catch (error) {
        errors.push(error); helper.kill();
        try { observer = await bounded(helperClosed); } catch (error) { errors.push(error); }
      }
    } finally {
      eventsAbort.abort();
    }
    console.log(JSON.stringify({ event: 'task45-original-cleanup', mode, producerPid: peer.pid,
      helperPid: helper?.pid, producer, observer, stdout, stderr, peerStdout, peerStderr }));
    assert.deepEqual(producer, { code: 0, signal: null, stdoutEOF: true, stderrEOF: true });
    if (observer) assert.equal(observer.stdoutEOF && observer.stderrEOF, true);
    assert.equal(errors.length, 0, errors.map(error => error.stack).join('\n'));
    return { producer, observer };
  })();
  t.after(cleanup);
  t.signal.addEventListener('abort', () => { cleanup().catch(() => {}); }, { once: true });
  peer.stdout.on('data', data => {
    peerStdout += data;
    for (const line of peerStdout.split(/\r?\n/)) {
      if (line === 'PEER_READY') peerEvents.emit('ready');
      if (line.startsWith('CLIENT_STATE ')) peerEvents.emit('client-state', JSON.parse(line.slice(13)));
      if (line.startsWith('PIPE_DISCONNECTED ')) peerEvents.emit('disconnected', JSON.parse(line.slice(18)));
      if (line.startsWith('DISPOSAL_REQUEST ')) peerEvents.emit('disposal-request', JSON.parse(line.slice(17)));
      if (line.startsWith('DISPOSAL_ACK ')) peerEvents.emit('disposal-ack', JSON.parse(line.slice(13)));
      if (line.startsWith('EFFECT_ACK ')) peerEvents.emit('effect-ack', JSON.parse(line.slice(11)));
    }
  });
  peer.stderr.on('data', data => { peerStderr += data; });
  peer.stdin.on('error', error => { peerError ??= error; });
  const ready = once(peerEvents, 'ready', { signal: AbortSignal.any([t.signal, eventsAbort.signal]) });
  ready.catch(() => {});
  const offer = { pipePath, v: 1, token: 'owned-test-token' };
  const request = { ...offer, type: 'observe-retirement', nonce, custody: true };
  const compile = source => {
    const start = 'const script = `', begin = source.indexOf(start);
    const ending = /`;\r?\n  const child = spawn/g;
    ending.lastIndex = begin + start.length;
    const end = ending.exec(source);
    assert.ok(begin >= 0 && end && end.index > begin, 'real production script boundaries');
    assert.equal(source.indexOf(start, begin + start.length), -1);
    return new Function('offer', 'request', 'nonce', 'custody',
      'return `' + source.slice(begin + start.length, end.index) + '`;')(offer, request, nonce, true);
  };
  if (mode === 'setup-failure') {
    assert.throws(() => compile('invalid boundary'), /real production script boundaries/);
    await cleanup();
    return;
  }
  const script = compile(dashboard.captureLegacyProducer.toString());
  await bounded(ready);
  assert.equal(peerError, undefined);
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OMO_RESTART_QA_DISPOSE_GATE: mode === 'live-loss' ? '1' : '' } });
  t.after(cleanup);
  const armed = deferred();
  let helperBuffer = '';
  helperClosed = new Promise(resolve => {
    helper.once('error', error => { armed.resolve({ error }); });
    helper.stdin.on('error', error => { stderr += error.stack; });
    helper.stdout.on('data', data => {
      stdout += data; helperBuffer += data;
      let end;
      while ((end = helperBuffer.indexOf('\n')) >= 0) {
        const line = helperBuffer.slice(0, end).trim();
        helperBuffer = helperBuffer.slice(end + 1);
        if (line.startsWith('ARMED ')) armed.resolve(JSON.parse(line.slice(6)));
        if (line.startsWith('CHECK ')) helperEvents.emit('check', line.slice(6));
        if (line.startsWith('DEAD ')) helperEvents.emit('dead', Number(line.slice(5)));
        if (line.startsWith('CUSTODY_PIPE_EOF '))
          helperEvents.emit('pipe-eof', JSON.parse(line.slice(17)));
        if (line.startsWith('CUSTODY_PRODUCER_DEAD '))
          helperEvents.emit('producer-dead', JSON.parse(line.slice(22)));
        if (line.startsWith('CUSTODY_DISPOSE_WRITE_ENTER '))
          helperEvents.emit('dispose-write', JSON.parse(line.slice(28)));
      }
    });
    helper.stderr.on('data', data => { stderr += data; });
    helper.once('close', (code, signal) => {
      armed.resolve({ error: new Error(stderr) });
      resolve({ code, signal, stdoutEOF: helper.stdout.readableEnded, stderrEOF: helper.stderr.readableEnded });
    });
  });
  const original = await bounded(armed.promise);
  assert.equal(original.ProcessId, peer.pid);
  if (mode === 'abort') {
    const abort = new AbortController();
    const cancelled = once(peerEvents, 'disconnected', { signal: abort.signal });
    abort.signal.addEventListener('abort', () => { cleanup().catch(() => {}); }, { once: true });
    abort.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.deepEqual((await cleanup()).observer, { code: 0, signal: null, stdoutEOF: true, stderrEOF: true });
    return;
  }
  if (['live-eof', 'eof-then-dead', 'disposing-eof', 'live-acked', 'live-loss', 'live-effect'].includes(mode)) {
    const liveCheck = once(helperEvents, 'check', { signal: eventsAbort.signal });
    helper.stdin.write('custody-check\n');
    const [liveValid] = await bounded(liveCheck);
    console.log(JSON.stringify({ event: 'task44-original-live-check-before-loss', original,
      helperPid: helper.pid, producerTerminal: peer.exitCode, valid: liveValid }));
    assert.equal(liveValid, 'true');
  }
  if (mode === 'live-effect') {
    const acknowledged = once(peerEvents, 'effect-ack', { signal: eventsAbort.signal });
    peer.stdin.write('effect\n');
    const [effect] = await bounded(acknowledged);
    assert.equal(effect.type, 'custody-invalidated');
    assert.equal(effect.nonce, nonce); assert.equal(effect.token, offer.token);
    assert.deepEqual(effect.operation, { id: 'owned-operation', ownerNonce: 'owned-owner', generation: 2, revision: 7 });
    assert.equal(peer.exitCode, null);
    const checked = once(helperEvents, 'check', { signal: eventsAbort.signal });
    helper.stdin.write('custody-check\n');
    assert.equal((await bounded(checked))[0], 'false');
  }
  if (mode === 'live-loss') {
    const writing = once(helperEvents, 'dispose-write', { signal: eventsAbort.signal });
    const lost = once(peerEvents, 'disconnected', { signal: eventsAbort.signal });
    helper.stdin.end('dispose\n');
    const [entered] = await bounded(writing);
    assert.equal(entered.helperPid, helper.pid); assert.equal(entered.producerPid, original.ProcessId);
    assert.equal(entered.nonce, nonce); assert.equal(entered.pipeConnected, true);
    peer.stdin.write('lose\n');
    const [disconnected] = await bounded(lost);
    assert.equal(disconnected.producerPid, original.ProcessId); assert.equal(disconnected.connected, false);
    console.log(JSON.stringify({ event: 'task44-native-disposal-write-loss', original,
      entered, disconnected, helperPid: helper.pid, ownedGate: `Local\\omo-restart-qa-dispose-${nonce}` }));
  } else if (mode === 'disposing-eof' || mode === 'live-acked' || mode === 'live-effect') {
    const writing = once(helperEvents, 'dispose-write', { signal: eventsAbort.signal });
    const requested = once(peerEvents, 'disposal-request', { signal: eventsAbort.signal });
    const completion = mode !== 'disposing-eof'
      ? once(peerEvents, 'disposal-ack', { signal: eventsAbort.signal })
      : once(helperEvents, 'pipe-eof', { signal: eventsAbort.signal });
    writing.catch(() => {}); requested.catch(() => {}); completion.catch(() => {});
    helper.stdin.end('dispose\n');
    const [entered] = await bounded(writing);
    assert.equal(entered.helperPid, helper.pid); assert.equal(entered.producerPid, original.ProcessId);
    assert.equal(entered.nonce, nonce);
    peer.stdin.write(mode !== 'disposing-eof' ? 'ack\n' : 'lose-after-dispose\n');
    const [disposal] = await bounded(requested);
    assert.equal(disposal.type, 'custody-disposed'); assert.equal(disposal.nonce, nonce);
    assert.equal(disposal.token, offer.token);
    const [receipt] = await bounded(completion);
    if (mode !== 'disposing-eof') assert.deepEqual(receipt, disposal);
    else {
      assert.equal(receipt.helperPid, helper.pid); assert.equal(receipt.producerPid, original.ProcessId);
      assert.equal(receipt.nonce, nonce); assert.equal(receipt.disposing, true);
      assert.equal(receipt.producerDead, false);
    }
    assert.equal(peer.exitCode, null);
    console.log(JSON.stringify({ event: 'task41-original-live-disposal', mode, original,
      helperPid: helper.pid, disposal, receipt, producerTerminal: peer.exitCode }));
  } else if (mode === 'live-eof' || mode === 'eof-then-dead') {
    const clientState = once(peerEvents, 'client-state', { signal: t.signal });
    const lost = once(peerEvents, 'disconnected', { signal: t.signal });
    const pipeEOF = once(helperEvents, 'pipe-eof', { signal: eventsAbort.signal });
    peer.stdin.write('lose\n');
    const [beforeLoss] = await bounded(clientState);
    const [disconnected] = await bounded(lost);
    assert.equal(disconnected.producerPid, original.ProcessId);
    assert.equal(disconnected.connected, false);
    assert.match(disconnected.handle, /^[1-9][0-9]*$/);
    console.log(JSON.stringify({ event: 'task45-native-pipe-disconnected', original, disconnected }));
    console.log(JSON.stringify({ event: 'task45-original-client-before-loss', original, beforeLoss,
      helperPid: helper.pid, plannedDisposalRequested: helper.stdin.writableEnded }));
    assert.equal(peer.exitCode, null);
    assert.equal(beforeLoss.producerPid, original.ProcessId);
    assert.notEqual(beforeLoss.message?.type, 'custody-disposed');
    const [eof] = await bounded(pipeEOF);
    assert.equal(eof.helperPid, helper.pid); assert.equal(eof.producerPid, original.ProcessId);
    assert.equal(eof.nonce, nonce); assert.equal(eof.disposing, false);
    assert.equal(eof.producerDead, false);
    const checked = once(helperEvents, 'check', { signal: eventsAbort.signal });
    const controlInput = 'custody-check\n';
    console.log(JSON.stringify({ event: 'task44-original-control-input', helperPid: helper.pid,
      producerPid: original.ProcessId, input: controlInput }));
    helper.stdin.write(controlInput);
    const [valid] = await bounded(checked);
    console.log(JSON.stringify({ event: 'task45-live-custody-check', original, disconnected,
      helperPid: helper.pid, producerTerminal: peer.exitCode, valid }));
    assert.equal(valid, 'false');
    const selectedInput = JSON.parse(stdout.split(/\r?\n/)
      .filter(line => line.startsWith('CUSTODY_INPUT ')).at(-1).slice(14));
    assert.equal(selectedInput.mode, 'custody-check');
    assert.equal(selectedInput.custodyInvalid, true);
    assert.equal(selectedInput.disposing, false);
    if (mode === 'eof-then-dead') {
      const signaled = once(helperEvents, 'producer-dead', { signal: eventsAbort.signal });
      const death = once(helperEvents, 'dead', { signal: eventsAbort.signal });
      signaled.catch(() => {}); death.catch(() => {});
      peer.stdin.end();
      const producer = await bounded(peerClosed);
      assert.deepEqual(producer, { code: 0, signal: null, stdoutEOF: true, stderrEOF: true });
      const [nativeSignal] = await bounded(signaled);
      assert.equal(nativeSignal.helperPid, helper.pid); assert.equal(nativeSignal.producerPid, original.ProcessId);
      assert.equal(nativeSignal.producerBirth, original.Birth); assert.equal(nativeSignal.nonce, nonce);
      assert.equal(nativeSignal.exitCode, producer.code); assert.equal(nativeSignal.custodyInvalid, true);
      helper.stdin.write('death\n');
      const [exitCode] = await bounded(death);
      assert.equal(exitCode, producer.code);
      console.log(JSON.stringify({ event: 'task47-original-held-death-after-live-eof',
        original, helperPid: helper.pid, eof, producer, nativeSignal, exitCode }));
      const deadCheck = once(helperEvents, 'check', { signal: eventsAbort.signal });
      helper.stdin.write('custody-check\n');
      assert.equal((await bounded(deadCheck))[0], 'false');
      const afterDeathInput = JSON.parse(stdout.split(/\r?\n/)
        .filter(line => line.startsWith('CUSTODY_INPUT ')).at(-1).slice(14));
      assert.equal(afterDeathInput.producerDead, true); assert.equal(afterDeathInput.custodyInvalid, true);
    }
  } else {
    peer.stdin.end();
    assert.deepEqual(await bounded(peerClosed), { code: 0, signal: null, stdoutEOF: true, stderrEOF: true });
  }
  if (!helper.stdin.writableEnded) helper.stdin.end('dispose\n');
  const terminal = await bounded(helperClosed);
  console.log(JSON.stringify({ event: 'task44-original-helper-terminal', producerPid: peer.pid,
    helperPid: helper.pid, mode, original, terminal, stdout, stderr }));
  if (mode === 'live-loss') {
    const failure = JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith('DISPOSE_PIPE_ERROR ')).slice(19));
    assert.equal(failure.originalProducerDead, false);
    assert.equal(failure.producerPid, original.ProcessId); assert.equal(failure.helperPid, helper.pid);
    assert.equal(failure.nonce, nonce); assert.equal(peer.exitCode, null);
    const gate = JSON.parse(stdout.split(/\r?\n/).find(line => line.startsWith('CUSTODY_DISPOSE_GATE_CLOSED ')).slice(28));
    assert.equal(gate.closed, true); assert.equal(gate.nonce, nonce);
  }
  if (['live-eof', 'disposing-eof', 'live-acked', 'live-effect'].includes(mode)) assert.equal(peer.exitCode, null);
  assert.deepEqual(terminal, { code: ['live-loss', 'live-eof', 'disposing-eof'].includes(mode) ? 1 : 0,
    signal: null, stdoutEOF: true, stderrEOF: true });
  });
});

test('task5 custody disposal drains an in-flight operation before channel close', { timeout: 5000 }, async t => {
  const f = await shutdownAuthorityFixture(t);
  f.controller.bridge.readinessChanged = () => {};
  f.controller.watchRecoveryMembership = async () => {};
  const offer = { v: 1, token: f.controller.controlToken, ...f.controller.binding, scopeEpoch: 1,
    role: 'todo', launchToken: f.record.launchToken, paneId: f.record.paneId, statePath: f.record.statePath };
  const sent = [], socket = new EventEmitter();
  socket.write = raw => { const message = JSON.parse(raw); sent.push(message); socket.emit('write', message); };
  const subscriber = { custody: true, offer, nonce: 'original-custody-nonce', pending: new Map(), invalidated: false };
  f.controller.retirementSubscribers.set(socket, subscriber);
  const target = Object.fromEntries(['paneId', 'tabId', 'shell', 'viewer', 'statePath', 'sourcePath',
    'cachePath', 'prefsPath', 'launchToken', 'controlToken'].map(key => [key, f.actor.snapshot.roles.todo[key]]));
  const effectSent = once(socket, 'write', { signal: AbortSignal.timeout(3000) });
  let dispatched = false;
  const performing = f.controller.perform('todo', 'retire', target, () => {
    dispatched = true;
    return { result: 'settled', effects: Promise.resolve() };
  });
  performing.catch(() => {});
  try {
    const [effect] = await effectSent;
    assert.equal(effect.type, 'custody-effect');
    assert.equal(f.actor.snapshot.operations.at(-1).status, 'DISPATCHED');
    await f.controller.handleControl({ ...offer, type: 'custody-disposed', nonce: subscriber.nonce }, socket);
    assert.deepEqual(sent[1], { ...offer, type: 'custody-disposed', nonce: subscriber.nonce });
    assert.equal(subscriber.pending.has(effect.operation.id), true);
    assert.equal(dispatched, false);
    await f.controller.handleControl({ ...offer, type: 'custody-invalidated', nonce: subscriber.nonce,
      operation: effect.operation }, socket);
    assert.equal(await performing, 'settled');
    assert.equal(dispatched, true);
    assert.equal(subscriber.pending.size, 0);
  } finally {
    socket.emit('close');
    await performing.catch(() => {});
    f.controller.retirementSubscribers.delete(socket);
  }
});
