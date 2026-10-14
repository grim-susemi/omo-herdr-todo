import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import fixture, { probeDeniedFetch } from './fixture-extension.mjs';
import { parseQaArgs, assertNativeReceipt, assertPreservedPane, assertFrame, sameProcess,
  assertLeaseResult, controlledCollapse, listenFetchTarget, requiredQaClasses,
  aggregateQaResults, runAll } from '../../scripts/qa-restart.mjs';

const options = ['--case', 'bootstrap', '--evidence-dir', resolve('.omo/evidence/contract'),
  '--senpi-root', resolve('sdk'), '--omo-root', resolve('omo'), '--herdr-bin', resolve('herdr.exe')];
const processIdentity = { pid: 901, parentPid: 800, birth: '2026-10-10T00:00:00.000Z',
  kernelBirthTicks: '639272208000000007',
  exe: 'C:/node.exe', argv: 'node current-cli.js' };
const native = () => ({ type: 'native-scope', nonce: 'current', pid: 901, mode: 'tui', hasUI: true,
  stdinTTY: true, stdoutTTY: true, sessionId: 'session-a', agentDir: resolve('profile'),
  cwd: resolve('cwd'), cli: resolve('sdk/dist/bundle/cli.js'), sdkVersion: '2026.10.13',
  omoVersion: '5.1.33', providerRequestCount: 0, networkRequestCount: 0,
  onboarding: { disabled: true, completed: 'ENOENT' }, allComponentsDisabled: false,
  loadedExtensionPaths: expected.extensionPaths, argv: expected.argv,
  discovery: { activeTools: [], configuredTools: [], skills: [], prompts: [] },
  sessionFile: resolve('profile/sessions/session-a.jsonl'),
  modules: [{ path: resolve('sdk/dist/bundle/cli.js'), sha256: 'a'.repeat(64) }] });
const expected = { nonce: 'current', pid: 901, sessionId: 'session-a', agentDir: resolve('profile'),
  cwd: resolve('cwd'), cli: resolve('sdk/dist/bundle/cli.js'), plugin: resolve('omo/plugin/extensions/omo.js'),
  todo: resolve('sdk/dist/core/extensions/builtin/todotools/index.js'), sessionDir: resolve('profile/sessions'),
  extensionPaths: [resolve('omo/plugin/extensions/omo.js'),
    resolve('sdk/dist/core/extensions/builtin/todotools/index.js'), resolve('test/restart/fixture-extension.mjs')],
  argv: [resolve('sdk/dist/bundle/cli.js'), '--no-tools', '--no-extensions'],
  modules: [{ path: resolve('sdk/dist/bundle/cli.js'), sha256: 'a'.repeat(64) }] };

test('bootstrap parser accepts only explicit absolute isolated launch inputs', () => {
  assert.equal(parseQaArgs(options).case, 'bootstrap');
  for (const argv of [[], [...options, '--case', 'bootstrap'], [...options, '--unknown', 'x'],
    options.slice(0, -1), options.map(x => x === 'bootstrap' ? 'fake-host' : x),
    options.map(x => x === resolve('sdk') ? 'relative-sdk' : x)]) assert.throws(() => parseQaArgs(argv));
});

test('selected prerequisites and all accept explicit absolute isolated launch inputs', () => {
  for (const name of ['lease', 'pane-collapse', 'all']) {
    assert.equal(parseQaArgs(options.map(value => value === 'bootstrap' ? name : value)).case, name);
  }
});

test('all aggregation passes only when every prescribed positive and rejection class passes', () => {
  const cases = ['bootstrap', 'lease', 'native-scope', 'same-session', 'fresh-session',
    'abnormal-exit', 'partial', 'legacy', 'race', 'late-effects', 'manual-close',
    'foreign-owner', 'package'];
  for (const name of cases) for (const branch of ['positive', 'rejection']) {
    assert.ok(requiredQaClasses.some(entry => entry.id === `${name}:${branch}`));
  }
  assert.equal(new Set(requiredQaClasses.map(entry => entry.id)).size, requiredQaClasses.length);
  const passed = Object.fromEntries(requiredQaClasses.map(entry => [entry.id, {
    status: 'PASS', pointer: 'injected/result.json', reason: 'Injected passing subcase result.',
  }]));
  assert.equal(aggregateQaResults(passed).exitCode, 0);
  assert.equal(aggregateQaResults(passed).ok, true);
  for (const entry of requiredQaClasses) {
    for (const status of ['FAIL', 'NOT_IMPLEMENTED']) {
      const result = aggregateQaResults({ ...passed, [entry.id]: { ...passed[entry.id], status } });
      assert.equal(result.exitCode, 1);
      assert.equal(result.ok, false);
      assert.equal(result.cases.find(row => row.id === entry.id).status, status);
    }
    const missing = { ...passed };
    delete missing[entry.id];
    const result = aggregateQaResults(missing);
    assert.equal(result.exitCode, 1);
    const row = result.cases.find(row => row.id === entry.id);
    assert.equal(row.status, 'NOT_IMPLEMENTED');
    assert.ok(row.reason);
    assert.ok(row.pointer);
  }
});

test('all runs supported cases sequentially and persists an honest matrix without native launch', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const evidenceDir = await mkdtemp(join(root, '.omo/evidence/qa-contract-all-'));
  const bootstrapCases = ['bootstrap', 'real-todo-append', 'orphan-graceful-q',
    'identity-bound-child-kill', 'rerun-original-pane', 'native-fetch-denied-before-connection'];
  const leaseCases = ['exclusive-contention', 'graceful-handoff', 'fatal-release-handoff',
    'os-identity-mismatch', 'no-blind-pid-kill', 'crash-before-claim',
    'corrupt-fixture', 'no-delete-takeover', 'handle-acquisition-substitution'];
  const calls = [];
  const runners = {
    bootstrap: async options => {
      assert.deepEqual(calls, []);
      assert.equal(options.evidenceDir, join(evidenceDir, 'bootstrap'));
      calls.push('bootstrap');
      return { ok: true, cases: bootstrapCases.map(name => ({ name, ok: true })) };
    },
    lease: async () => {
      assert.deepEqual(calls, ['bootstrap']);
      calls.push('lease');
      return { ok: true, result: { cases: Object.fromEntries(leaseCases.map(name => [name, true])) },
        rawRun: { exitCode: 0 } };
    },
    'pane-collapse': async () => {
      assert.deepEqual(calls, ['bootstrap', 'lease']);
      calls.push('pane-collapse');
      return { ok: true, negative: { preservationRejected: true, recreatedPanesCountedAsPreservation: false } };
    },
  };
  try {
    const result = await runAll({ ...parseQaArgs(options), case: 'all', evidenceDir }, runners);
    assert.deepEqual(calls, ['bootstrap', 'lease', 'pane-collapse']);
    assert.equal(result.exitCode, 1);
    assert.equal(result.ok, false);
    const matrix = JSON.parse(await readFile(join(evidenceDir, 'case-matrix.json'), 'utf8'));
    assert.deepEqual(matrix.cases, result.cases);
    assert.equal(matrix.cases.length, requiredQaClasses.length);
    assert.equal(matrix.cases.filter(row => row.status === 'PASS').length, 5);
    assert.ok(matrix.cases.some(row => row.status === 'NOT_IMPLEMENTED'));
    calls.length = 0;
    const failed = await runAll({ evidenceDir }, { ...runners,
      bootstrap: async () => { calls.push('bootstrap'); throw new Error('injected runner failure'); } });
    assert.deepEqual(calls, ['bootstrap', 'lease', 'pane-collapse']);
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.cases.find(row => row.id === 'bootstrap:positive').status, 'FAIL');
    assert.match(failed.cases.find(row => row.id === 'bootstrap:positive').reason, /injected runner failure/);
    assert.equal(failed.cases.find(row => row.id === 'lease:positive').status, 'PASS');
  } finally { await rm(evidenceDir, { recursive: true, force: true }); }
});

test('selected lease rejects missing cases, false receipts, nonnative SQLite and inferred exits', () => {
  const cases = Object.fromEntries(['exclusive-contention', 'graceful-handoff', 'fatal-release-handoff',
    'os-identity-mismatch', 'no-blind-pid-kill', 'crash-before-claim', 'corrupt-fixture',
    'no-delete-takeover', 'handle-acquisition-substitution'].map(name => [name, true]));
  const result = { ok: true, platform: 'win32', sqlite: 'node:sqlite DatabaseSync', cases };
  assert.doesNotThrow(() => assertLeaseResult(result, 0));
  for (const exit of [null, undefined, '0', 1]) assert.throws(() => assertLeaseResult(result, exit));
  for (const patch of [{ ok: false }, { platform: 'linux' }, { sqlite: 'mock' },
    { cases: {} }, { cases: { ...cases, 'exclusive-contention': false } },
    { cases: { ...cases, extra: true } }]) assert.throws(() => assertLeaseResult({ ...result, ...patch }, 0));
});

test('controlled collapse arms original shell exit before action and explicitly rejects lost pane', async () => {
  const before = { paneId: 'owned:p', tabId: 'owned:t', shell: processIdentity, rect: { width: 80, height: 24 } };
  const calls = [];
  let resolveExit;
  const completed = new Promise(done => { resolveExit = done; });
  const result = await controlledCollapse(before, {
    subscribe: async identity => {
      assert.deepEqual(identity, before.shell);
      calls.push('subscribed');
      return { completed, identity: { pid: 902 } };
    },
    collapse: async original => {
      assert.deepEqual(original, before);
      assert.deepEqual(calls, ['subscribed']);
      calls.push('collapsed');
      resolveExit({ pid: before.shell.pid, birth: before.shell.birth, exitCode: 0, handleDisposed: true });
    },
    originalPane: async original => {
      assert.equal(original.paneId, before.paneId);
      calls.push('membership');
      return null;
    },
    shellIdentity: async pid => {
      assert.equal(pid, before.shell.pid);
      calls.push('shell-absence');
      return null;
    },
  });
  assert.deepEqual(calls, ['subscribed', 'collapsed', 'membership', 'shell-absence']);
  assert.equal(result.preservationRejected, true);
  assert.equal(result.recreatedPanesCountedAsPreservation, false);
  assert.equal(result.after, null);
});

test('collapse cannot pass surviving shell, recreated pane, wrong exit identity or query failure', async () => {
  const before = { paneId: 'owned:p', tabId: 'owned:t', shell: processIdentity, rect: {} };
  const exit = { pid: before.shell.pid, birth: before.shell.birth, exitCode: 0, handleDisposed: true };
  const operations = {
    subscribe: async () => ({ completed: Promise.resolve(exit) }),
    collapse: async () => {},
    originalPane: async () => null,
    shellIdentity: async () => null,
  };
  for (const patch of [
    { originalPane: async () => ({ ...before, paneId: 'owned:replacement' }) },
    { originalPane: async () => before },
    { originalPane: async () => { throw new Error('transport failure'); } },
    { shellIdentity: async () => before.shell },
    ...[{ pid: 900 }, { birth: 'wrong' }, { exitCode: null }, { handleDisposed: false }]
      .map(value => ({ subscribe: async () => ({ completed: Promise.resolve({ ...exit, ...value }) }) })),
  ]) await assert.rejects(controlledCollapse(before, { ...operations, ...patch }));
});

test('native receipt rejects wrong mode, SDK, provider calls and stale source', () => {
  assert.doesNotThrow(() => assertNativeReceipt(native(), expected));
  for (const patch of [{ mode: 'print' }, { hasUI: false }, { stdinTTY: false },
    { sdkVersion: '2026.10.7' }, { omoVersion: 'old' }, { providerRequestCount: 1 },
    { networkRequestCount: 1 }, { nonce: 'stale' }, { pid: 900 }, { sessionId: 'old-session' },
    { cli: resolve('other-cli') }, { loadedExtensionPaths: ['<builtin:todotools>'] },
    { modules: [{ path: expected.cli, sha256: 'b'.repeat(64) }] }]) {
    assert.throws(() => assertNativeReceipt({ ...native(), ...patch }, expected), JSON.stringify(patch));
  }
});

test('native startup refuses queued onboarding before Todo can trigger provider work', () => {
  for (const customType of ['omo-onboarding:started', 'omo-onboarding:bootstrap']) {
    const scope = { ...native(), branch: [{ type: 'custom', customType,
      data: { reason: 'startup', forced: false } }] };
    assert.throws(() => assertNativeReceipt(scope, expected));
  }
});

test('native admission requires effective startup omission and absent completed state', () => {
  for (const onboarding of [undefined, { disabled: false, completed: 'ENOENT' },
    { disabled: true, completed: 'present' }, { disabled: true, completed: 'EACCES' }]) {
    assert.throws(() => assertNativeReceipt({ ...native(), onboarding }, expected));
  }
});

test('native admission rejects unsuppressed discovery and non-explicit resources', () => {
  assert.doesNotThrow(() => assertNativeReceipt(native(), expected));
  for (const patch of [
    { argv: undefined }, { argv: [expected.cli] },
    { loadedExtensionPaths: [...native().loadedExtensionPaths, resolve('discovered/extension.js')] },
    { discovery: undefined },
    { discovery: { activeTools: ['read'], configuredTools: [], skills: [], prompts: [] } },
    { discovery: { activeTools: [], configuredTools: [], skills: [{ name: 'skill:foreign' }], prompts: [] } },
    { discovery: { activeTools: [], configuredTools: [], skills: [], prompts: [{ name: 'foreign' }] } },
  ]) assert.throws(() => assertNativeReceipt({ ...native(), ...patch }, expected));
});

test('built-in fetch reaches the denial dispatcher and rejects before any owned connection', async () => {
  let connections = 0;
  const target = net.createServer(socket => { connections++; socket.destroy(); });
  try {
    const allocatedPorts = await listenFetchTarget(target);
    assert.ok(allocatedPorts.at(-1) > 10080);
    assert.equal(target.address().port, allocatedPorts.at(-1));
    const url = `http://127.0.0.1:${target.address().port}/contract`;
    const result = await probeDeniedFetch(url);
    assert.equal(result.rejected, true);
    assert.equal(result.error.causeCode, 'OMO_RESTART_QA_DENIED', JSON.stringify({ url, result }));
    assert.equal(result.dispatches.length, 1);
    const { requestRaw, handlerRaw, handlerOwnPropertyNames, ...dispatch } = result.dispatches[0];
    assert.deepEqual(dispatch, { origin: new URL(url).origin, path: '/contract', method: 'GET',
      code: 'OMO_RESTART_QA_DENIED', handler: 'onError', connectorInvoked: false });
    assert.equal(typeof requestRaw, 'string');
    assert.equal(typeof handlerRaw, 'string');
    assert.ok(handlerOwnPropertyNames.includes('onError'));
    assert.equal(typeof result.error.raw, 'string');
    assert.equal(typeof result.error.causeRaw, 'string');
    assert.equal(result.error.causePresent, true);
    assert.equal(result.error.causeType, 'object');
    assert.ok(result.error.ownPropertyNames.includes('cause'));
    assert.equal(connections, 0);
  } finally {
    if (target.listening) await new Promise(done => target.close(done));
  }
});

// Deterministic loopback-allocation regression. The fake is an
// EventEmitter-compatible server whose port0 answer is a low fetch-blocked
// port, as observed on this Windows host. Every listen() call records whether
// the listening/error subscriptions already existed, so subscription-before-
// trigger is asserted without real sockets, sleeps or timing luck.
function fakeLoopbackServer({ refused = [], failCode = null } = {}) {
  return new class extends EventEmitter {
    constructor() { super(); this.calls = []; this.boundPort = null; }
    listen(port, host) {
      this.calls.push({ port, host, subscribed: { listening: this.listenerCount('listening') > 0,
        error: this.listenerCount('error') > 0 } });
      const code = failCode && failCode.port === port ? failCode.code :
        refused.includes(port) ? 'EADDRINUSE' : null;
      if (code) return setImmediate(() => this.emit('error', Object.assign(new Error('listen ' + code), { code })));
      this.boundPort = port === 0 ? 9999 : port;
      setImmediate(() => { this.listening = true; this.emit('listening'); });
    }
    address() { return { port: this.boundPort }; }
    close(done) { this.listening = false; this.boundPort = null; setImmediate(done); }
  }();
}

test('explicit loopback candidates replace port0 low-ephemeral luck without port0 calls', async () => {
  const fake = fakeLoopbackServer();
  const allocatedPorts = await listenFetchTarget(fake);
  assert.ok(allocatedPorts.at(-1) > 10080);
  assert.equal(fake.address().port, allocatedPorts.at(-1));
  assert.deepEqual(fake.calls, [{ port: 13100, host: '127.0.0.1',
    subscribed: { listening: true, error: true } }]);
  assert.equal(fake.calls.some(call => call.port === 0), false, 'port0 must not be attempted');
});

test('bind refusals advance only on real EADDRINUSE within the bounded candidate window', async () => {
  const fake = fakeLoopbackServer({ refused: [13100, 13101] });
  const allocatedPorts = await listenFetchTarget(fake);
  assert.ok(allocatedPorts.at(-1) > 10080);
  assert.equal(fake.address().port, allocatedPorts.at(-1));
  assert.deepEqual(fake.calls.map(call => call.port), [13100, 13101, 13102]);
  assert.deepEqual(allocatedPorts, [13100, 13101, 13102]);
  assert.ok(fake.calls.every(call => call.subscribed.listening && call.subscribed.error));
});

test('non-EADDRINUSE bind errors reject immediately with recorded attempted ports', async () => {
  const fake = fakeLoopbackServer({ failCode: { port: 13100, code: 'EACCES' } });
  await assert.rejects(listenFetchTarget(fake), error => {
    assert.equal(error.code, 'EACCES');
    assert.deepEqual(error.attemptedPorts, [13100]);
    assert.deepEqual(fake.calls.map(call => call.port), [13100], 'No advance past immediate bind failure');
    return true;
  });
});

test('exhausting the bounded candidate window records every attempted port', async () => {
  const window = Array.from({ length: 16 }, (_, index) => 13100 + index);
  const fake = fakeLoopbackServer({ refused: window });
  await assert.rejects(listenFetchTarget(fake), error => {
    assert.match(error.message, /No fetch-compatible owned loopback port allocated/);
    assert.deepEqual(error.attemptedPorts, window);
    assert.deepEqual(fake.calls.map(call => call.port), window);
    assert.equal(fake.calls.some(call => call.port === 0), false);
    return true;
  });
});

test('owned fixture duplicate flags observe the real SDK shared runtime without overriding values', async () => {
  const sdkRoot = process.env.OMO_RESTART_QA_SDK;
  assert.ok(sdkRoot, 'Explicit current SDK root required for the real-loader observer test');
  const { createExtensionRuntime, loadExtensionFromFactory } =
    await import(pathToFileURL(resolve(sdkRoot, 'dist/core/extensions/loader.js')));
  const runtime = createExtensionRuntime();
  const key = Symbol.for('omo.restart.native.qa.observer');
  const previous = globalThis[key];
  // Registration-only control: no native context, session, UI or provider action.
  globalThis[key] = {};
  try {
    let first, second;
    const extension = await loadExtensionFromFactory(pi => { first = pi; fixture(pi); },
      process.cwd(), undefined, runtime);
    assert.equal(extension.flags.get('omo-senpi-onboarding-disabled')?.type, 'boolean');
    assert.equal(first.getFlag('omo-senpi-onboarding-disabled'), false);
    runtime.flagValues.set('omo-senpi-onboarding-disabled', true);
    await loadExtensionFromFactory(pi => { second = pi; fixture(pi); }, process.cwd(), undefined, runtime);
    assert.equal(first.getFlag('omo-senpi-onboarding-disabled'), true);
    assert.equal(second.getFlag('omo-senpi-onboarding-disabled'), true);
    runtime.flagValues.set('omo-senpi-onboarding-disabled', false);
    assert.equal(first.getFlag('omo-senpi-onboarding-disabled'), false);
    assert.equal(second.getFlag('omo-senpi-onboarding-disabled'), false);
    assert.equal(second.getFlag('omo-senpi-disabled'), false);
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
});

test('pane preservation requires original shell birth, pane ID, tab and geometry', () => {
  const before = { paneId: 'qa:p', tabId: 'qa:t', shell: processIdentity, rect: { x: 0, y: 0, width: 80, height: 24 } };
  assert.doesNotThrow(() => assertPreservedPane(before, structuredClone(before)));
  for (const patch of [{ paneId: 'qa:new' }, { tabId: 'qa:foreign' },
    { shell: { ...processIdentity, birth: 'reused-pid' } }, { rect: { ...before.rect, width: 79 } }]) {
    assert.throws(() => assertPreservedPane(before, { ...before, ...patch }));
  }
  assert.throws(() => assertPreservedPane(before, null));
});

test('process binding rejects PID reuse, foreign executable, parent and argv', () => {
  assert.equal(sameProcess(processIdentity, { ...processIdentity }), true);
  for (const field of ['pid', 'parentPid', 'birth', 'kernelBirthTicks', 'exe', 'argv']) {
    assert.equal(sameProcess(processIdentity, { ...processIdentity, [field]: 'foreign' }), false);
  }
  assert.equal(sameProcess(processIdentity, null), false);
});

test('frame must be visible and current; command echo and stale notifications do not pass', () => {
  const frame = { pid: 901, nonce: 'current', paneId: 'qa:p', source: 'visible',
    ansi: '\x1b[32mQA_NATIVE_current\x1b[0m' };
  const binding = { pid: 901, nonce: 'current', paneId: 'qa:p', marker: 'QA_NATIVE_current' };
  assert.doesNotThrow(() => assertFrame(frame, binding));
  for (const patch of [{ pid: 900 }, { nonce: 'stale' }, { source: 'recent' },
    { paneId: 'qa:foreign' }, { ansi: 'PS> herdr pane wait-output --match QA_NATIVE_current' },
    { ansi: 'PS> /todo append QA_NATIVE_current' }]) {
    assert.throws(() => assertFrame({ ...frame, ...patch }, binding));
  }
});
