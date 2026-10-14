import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDisplayBridge, displayOwnerKey, bindDisplayBridgeSignals } from '../src/display-bridge.mjs';
import { projectNativeTodo } from '../src/native-todo.mjs';
import { inlineRecoveryFactory, inlineRecoveryLines } from '../src/inline-recovery.mjs';

// Unit-only adapter. It does not claim IPC, authentication, paint or live Herdr.
function fixture(options = {}) {
  const environment = { HERDR_SOCKET_PATH: 'fixture-socket', HERDR_PANE_ID: 'fixture-parent' };
  const owner = { socketPath: environment.HERDR_SOCKET_PATH, parentPaneId: environment.HERDR_PANE_ID,
    sessionId: 'fixture-session', scopeEpoch: 1 };
  owner.ownerKey = displayOwnerKey(owner.socketPath, owner.parentPaneId, owner.sessionId);
  let branch = [{ type: 'custom', id: 'entry-1', customType: 'senpi.todo-state',
    data: { schema: 'v2', phases: [{ name: 'F', tasks: [
      { content: 'alpha', status: 'in_progress' }, { content: 'beta', status: 'pending' },
    ] }] } }];
  let failRead = false;
  let sequence = 0;
  let dagOwned = false;
  const ready = new Set();
  const widgets = new Map();
  const calls = [];
  const published = [];
  const instances = [];
  let failSetter = null;
  const original = function (key, content, settings) {
    calls.push({ key, content, settings, receiver: this });
    if (failSetter?.(key, content)) throw new Error('setter failed');
    const prior = widgets.get(key);
    const component = typeof content === 'function' ? content() : content;
    prior?.dispose?.();
    if (content === undefined) widgets.delete(key);
    else widgets.set(key, component);
    return 'native-result';
  };
  const ui = { setWidget: original, notify() {}, editor: async value => value };
  const sessionManager = {
    getSessionFile: () => 'fixture-parent/session.jsonl',
    getSessionId: () => owner.sessionId,
    getLeafId: () => branch.at(-1)?.id ?? null,
    getBranch() { if (failRead) throw new Error('branch unavailable'); return branch; },
  };
  const ctx = { hasUI: true, mode: 'tui', ui, sessionManager };
  const adapter = {
    getOwner: () => owner,
    publish(value) { published.push(value); return { ...owner, sequence: ++sequence }; },
    isReady: binding => ready.has(binding.role),
    hasDagOwnedTasks: () => dagOwned,
    ...options,
  };
  const bridge = installDisplayBridge(ctx, adapter, { environment });
  function factory(name) {
    return () => {
      const instance = { name, disposed: 0, render: () => [name], dispose() { this.disposed++; } };
      instances.push(instance);
      return instance;
    };
  }
  return { bridge, ctx, ui, original, adapter, owner, environment, ready, widgets, calls, published, instances, factory,
    setDagOwned(value) { dagOwned = value; },
    setFailRead(value) { failRead = value; },
    setFailSetter(value) { failSetter = value; },
    setBranch(value) { branch = value; },
    change(content = 'changed', status = 'pending') {
      const phases = structuredClone(branch.at(-1).data.phases);
      phases[0].tasks.push({ content, status });
      branch = [...branch, { type: 'custom', id: `entry-${branch.length + 1}`,
        customType: 'senpi.todo-state', data: { schema: 'v2', phases } }];
    },
  };
}

test('a readable branch without native Todo publishes waiting without authorizing a mask', () => {
  const f = fixture();
  f.setBranch([]);
  f.bridge.observe({ type: 'tool_execution_end' }, f.ctx);
  assert.equal(f.published.at(-1).availability, 'waiting');
  f.ready.add('todo');
  f.ui.setWidget('todo-sidebar', ['native pending content']);
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, []);
  assert.deepEqual(f.widgets.get('todo-sidebar'), ['native pending content']);
});

test('initial recovery is prepared, labelled and same-key; own calls never capture', () => {
  const f = fixture();
  assert.equal(f.bridge.captured('todo-sidebar'), undefined);
  assert.equal(f.bridge.snapshot.counts.total, 2);
  assert.equal(f.widgets.size, 0);
  f.ready.add('todo');
  assert.equal(f.bridge.readinessChanged(), true);
  assert.deepEqual(f.bridge.status.masked, ['todo-sidebar']);
  f.ready.clear();
  f.bridge.readinessChanged();
  const recovery = f.widgets.get('todo-sidebar');
  const text = recovery.render(200).join('\n');
  assert.ok(text.includes('[owned Todo recovery: current; not native renderer]'));
  assert.ok(text.includes('in_progress: alpha'));
  assert.ok(text.includes('pending: beta'));
  assert.ok(text.includes('0/2 closed'));
  assert.equal(f.bridge.captured('todo-sidebar'), undefined);
  assert.deepEqual([...f.widgets.keys()], ['todo-sidebar']);
  f.bridge.remove();
  assert.equal(f.ui.setWidget, f.original);
});

test('real publications capture exact factories/arrays/options and restore fresh instances', () => {
  const f = fixture();
  const factory = f.factory('native');
  const options = { placement: 'belowEditor' };
  assert.equal(f.ui.setWidget('todo-sidebar', factory, options), 'native-result');
  const initial = f.widgets.get('todo-sidebar');
  f.ready.add('todo');
  f.bridge.readinessChanged();
  assert.equal(initial.disposed, 1);
  assert.equal(f.widgets.has('todo-sidebar'), false);
  f.ready.clear();
  f.bridge.readinessChanged();
  const restored = f.widgets.get('todo-sidebar');
  assert.notEqual(restored, initial);
  assert.equal(restored.disposed, 0);
  assert.equal(f.bridge.captured('todo-sidebar').content, factory);
  assert.equal(f.bridge.captured('todo-sidebar').options, options);
  assert.equal(f.calls.at(-1).content, factory);
  assert.equal(f.calls.at(-1).settings, options);
  const array = ['actual worker lines'];
  f.ui.setWidget('omo-task', array, options);
  f.ready.add('workers');
  f.bridge.readinessChanged();
  f.ready.clear();
  f.bridge.readinessChanged();
  assert.equal(f.widgets.get('omo-task'), array);
  assert.equal(f.bridge.captured('omo-task').content, array);
  f.bridge.remove();
});

test('workers need real capture and both worker/DAG coverage for DAG-owned tasks', () => {
  const f = fixture();
  f.ready.add('workers');
  f.ready.add('dag');
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, [], 'uncaptured workers/DAG cannot hide');
  f.ui.setWidget('omo-task', ['workers']);
  f.ui.setWidget('omo-dag', ['dag']);
  assert.deepEqual(f.bridge.status.masked, ['omo-task', 'omo-dag']);
  f.setDagOwned(true);
  f.ready.delete('dag');
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, []);
  assert.deepEqual(f.widgets.get('omo-task'), ['workers']);
  assert.deepEqual(f.widgets.get('omo-dag'), ['dag']);
  f.adapter.hasDagOwnedTasks = () => undefined;
  f.ready.add('dag');
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, ['omo-dag']);
  f.bridge.remove();
});

test('unrelated setter calls preserve receiver, array, options, methods and return', () => {
  const f = fixture();
  const methods = { notify: f.ui.notify, editor: f.ui.editor };
  const lines = ['unrelated'];
  const options = { placement: 'belowEditor' };
  const receiver = { marker: 'native-this' };
  assert.equal(f.ui.setWidget.call(receiver, 'unrelated', lines, options), 'native-result');
  assert.equal(f.calls.at(-1).receiver, receiver);
  assert.equal(f.calls.at(-1).content, lines);
  assert.equal(f.calls.at(-1).settings, options);
  assert.equal(f.ui.notify, methods.notify);
  assert.equal(f.ui.editor, methods.editor);
  assert.equal(f.bridge.captured('unrelated'), undefined);
  f.bridge.remove();
});

test('new native publication updates projection while masked and clear never resurrects recovery', () => {
  const f = fixture();
  f.ready.add('todo');
  f.bridge.readinessChanged();
  f.change('committed manual');
  const factory = f.factory('updated-native');
  f.ui.setWidget('todo-sidebar', factory);
  assert.equal(f.bridge.snapshot.counts.total, 3);
  assert.ok(f.published.at(-1).phases[0].tasks.some(task => task.content === 'committed manual'));
  assert.equal(f.widgets.has('todo-sidebar'), false);
  assert.equal(f.instances.at(-1).disposed, 1);
  f.setBranch([{ type: 'custom', id: 'empty', customType: 'senpi.todo-state', data: { schema: 'v2', phases: [] } }]);
  f.ui.setWidget('todo-sidebar', undefined);
  assert.equal(f.bridge.snapshot.availability, 'empty');
  assert.deepEqual(f.bridge.status.masked, []);
  f.bridge.remove();
  assert.equal(f.widgets.has('todo-sidebar'), false);
});

test('always-show and unknown settings restore only their corresponding masks', () => {
  const f = fixture({ settings: {} });
  f.ready.add('todo');
  f.ready.add('workers');
  f.ui.setWidget('omo-task', ['workers']);
  f.bridge.readinessChanged();
  f.adapter.settings.todo = 'always-show';
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, ['omo-task']);
  f.adapter.settings.workers = 'invalid';
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, []);
  f.bridge.remove();
});

test('scope mismatch restores native worker/DAG coverage and new Todo; stale factories cannot remask', () => {
  const f = fixture();
  f.ready.add('todo');
  f.ready.add('workers');
  f.ready.add('dag');
  f.ui.setWidget('omo-task', ['worker-native']);
  f.ui.setWidget('omo-dag', ['dag-native']);
  f.bridge.readinessChanged();
  f.ready.clear();
  f.owner.scopeEpoch++;
  f.change('new-scope-todo');
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, []);
  assert.deepEqual(f.widgets.get('omo-task'), ['worker-native']);
  assert.deepEqual(f.widgets.get('omo-dag'), ['dag-native']);
  assert.ok(f.widgets.get('todo-sidebar').render(200).join('\n').includes('new-scope-todo'));
  assert.equal(f.bridge.captured('omo-task'), undefined);
  f.ready.add('workers');
  f.ready.add('dag');
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, []);
  f.bridge.remove();
});

test('new-scope native publication is delegated and cannot be overwritten by old masked capture', () => {
  const f = fixture();
  f.ready.add('workers');
  f.ui.setWidget('omo-task', ['old-worker']);
  assert.ok(f.bridge.status.masked.includes('omo-task'));
  f.owner.scopeEpoch++;
  f.ui.setWidget('omo-task', ['new-worker']);
  f.ready.clear();
  f.bridge.readinessChanged();
  assert.deepEqual(f.widgets.get('omo-task'), ['new-worker']);
  assert.equal(f.bridge.captured('omo-task'), undefined);
  f.bridge.remove();
});

test('native updates during a cancelled lifecycle suspension invalidate old worker captures', () => {
  const f = fixture();
  f.ready.add('workers');
  f.ui.setWidget('omo-task', ['before-suspension']);
  f.bridge.suspend();
  f.ui.setWidget('omo-task', ['during-suspension']);
  f.bridge.observe({ type: 'agent_end' });
  f.ready.clear();
  f.bridge.readinessChanged();
  assert.deepEqual(f.widgets.get('omo-task'), ['during-suspension']);
  assert.equal(f.bridge.captured('omo-task'), undefined);
  f.bridge.remove();
});

test('transient mask setter failure can recover on the next explicit readiness signal', () => {
  const f = fixture();
  f.ui.setWidget('todo-sidebar', f.factory('native'));
  f.ready.add('todo');
  f.setFailSetter((_key, content) => content === undefined);
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, []);
  f.setFailSetter(null);
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, ['todo-sidebar']);
  f.bridge.remove();
});

test('unload after scope advances detaches its own wrapper and restores current branch information', () => {
  const f = fixture();
  f.ready.add('todo');
  f.bridge.readinessChanged();
  f.owner.scopeEpoch++;
  f.change('current-at-scope-unload');
  f.bridge.remove();
  assert.equal(f.ui.setWidget, f.original);
  assert.deepEqual(f.bridge.status.masked, []);
  const text = f.widgets.get('todo-sidebar').render(200).join('\n');
  assert.ok(text.includes('current-at-scope-unload'));
  assert.ok(text.includes('owned Todo recovery'));
});

test('child guard precedes hasUI, mode, UI, owner, branch and wrap access', () => {
  for (const path of ['fixture/senpi-task/children/child/session.jsonl', 'fixture\\senpi-task\\children\\child\\session.jsonl']) {
    const fail = () => { throw new Error('forbidden child access'); };
    const ctx = { sessionManager: { getSessionFile: () => path, getBranch: fail },
      get hasUI() { return fail(); }, get mode() { return fail(); }, get ui() { return fail(); } };
    assert.equal(installDisplayBridge(ctx, { getOwner: fail }), undefined);
  }
});

test('missing UI, non-TUI and mismatched Herdr/session/owner refuse installation', () => {
  const f = fixture();
  f.bridge.remove();
  for (const ctx of [{ ...f.ctx, hasUI: false }, { ...f.ctx, mode: 'print' }]) {
    assert.equal(installDisplayBridge(ctx, f.adapter, { environment: f.environment }), undefined);
  }
  for (const field of ['socketPath', 'parentPaneId', 'ownerKey', 'sessionId', 'scopeEpoch']) {
    const owner = { ...f.owner, [field]: field === 'scopeEpoch' ? 0 : 'foreign' };
    const adapter = { ...f.adapter, getOwner: () => owner };
    assert.equal(installDisplayBridge(f.ctx, adapter, { environment: f.environment }), undefined, field);
  }
  assert.equal(f.ui.setWidget, f.original);
});

test('publication failures/mismatched receipts and readiness errors never authorize a hide', () => {
  for (const publish of [
    () => false,
    () => { throw new Error('publication failed'); },
    value => ({ ...value, ownerKey: 'foreign', sequence: 1 }),
    value => ({ ...value, sessionId: 'foreign', sequence: 1 }),
    value => ({ ...value, scopeEpoch: value.scopeEpoch + 1, sequence: 1 }),
    value => ({ ...value, sequence: 0 }),
  ]) {
    const f = fixture({ publish });
    f.ready.add('todo');
    f.ui.setWidget('todo-sidebar', f.factory('visible'));
    f.bridge.readinessChanged();
    assert.equal(f.widgets.get('todo-sidebar').name, 'visible');
    assert.deepEqual(f.bridge.status.masked, []);
    assert.ok(f.bridge.failures.length > 0);
    f.bridge.remove();
  }
  const f = fixture({ isReady() { throw new Error('readiness failed'); } });
  f.ui.setWidget('todo-sidebar', f.factory('visible'));
  f.bridge.readinessChanged();
  assert.equal(f.widgets.get('todo-sidebar').name, 'visible');
  f.bridge.remove();
});

test('read failure restores labelled same-scope last-known; new scope has no old recovery', () => {
  const f = fixture();
  f.ready.add('todo');
  f.bridge.readinessChanged();
  f.setFailRead(true);
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, []);
  assert.ok(f.widgets.get('todo-sidebar').render(200).join('\n').includes('last-known; source read failed'));
  f.setFailRead(false);
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, ['todo-sidebar']);
  f.owner.scopeEpoch++;
  f.setFailRead(true);
  f.bridge.observe({ type: 'agent_end' });
  assert.equal(f.bridge.snapshot, null);
  const current = f.widgets.get('todo-sidebar').render(200).join('\n');
  assert.ok(current.includes('unavailable'));
  assert.ok(!current.includes('alpha'));
  f.bridge.remove();
});

test('mask and native setter failures do not poison exact-key tool execution or captures', () => {
  const f = fixture();
  const factory = f.factory('visible');
  f.ui.setWidget('todo-sidebar', factory);
  f.setFailSetter((_key, content) => content === undefined);
  f.ready.add('todo');
  assert.doesNotThrow(() => f.bridge.readinessChanged());
  assert.equal(f.widgets.get('todo-sidebar').name, 'visible');
  assert.deepEqual(f.bridge.status.masked, []);
  assert.equal(f.bridge.status.publication, null);
  f.setFailSetter(null);
  const broken = () => { throw new Error('rejected factory'); };
  assert.doesNotThrow(() => f.ui.setWidget('todo-sidebar', broken));
  assert.equal(f.bridge.captured('todo-sidebar').content, factory);
  assert.equal(f.widgets.get('todo-sidebar').name, 'visible');
  assert.ok(f.bridge.failures.some(failure => failure.boundary === 'native-setter'));
  f.bridge.remove();
});

test('current branch changes without native factory refresh restore current owned Todo, not stale native', () => {
  const f = fixture();
  f.ui.setWidget('todo-sidebar', f.factory('old-native'));
  f.ready.add('todo');
  f.bridge.readinessChanged();
  f.change('later-current');
  f.ready.clear();
  f.bridge.readinessChanged();
  const text = f.widgets.get('todo-sidebar').render(200).join('\n');
  assert.ok(text.includes('later-current'));
  assert.ok(text.includes('owned Todo recovery'));
  f.bridge.remove();
});

test('unload restores latest same-key recovery, then later native publication replaces it', () => {
  const f = fixture();
  f.ready.add('todo');
  f.bridge.readinessChanged();
  f.change('latest-before-unload');
  f.bridge.remove();
  assert.equal(f.ui.setWidget, f.original);
  assert.ok(f.widgets.get('todo-sidebar').render(200).join('\n').includes('latest-before-unload'));
  const recovery = f.widgets.get('todo-sidebar');
  f.ui.setWidget('todo-sidebar', f.factory('after-unload'));
  assert.deepEqual(recovery.render(200), [], 'native replacement disposes recovery through host setter');
  assert.equal(f.widgets.size, 1);
  f.bridge.remove();
  assert.equal(f.bridge.readinessChanged(), false);
});

test('unload never overwrites another wrapper or a replaced context facade', () => {
  const f = fixture();
  f.ready.add('todo');
  f.bridge.readinessChanged();
  const calls = f.calls.length;
  const other = () => 'other';
  f.ui.setWidget = other;
  f.bridge.remove();
  assert.equal(f.ui.setWidget, other);
  assert.equal(f.calls.length, calls);
  const g = fixture();
  const replacement = { setWidget: () => 'replacement' };
  g.ctx.ui = replacement;
  g.bridge.remove();
  assert.equal(g.ctx.ui.setWidget, replacement.setWidget);
});

test('pending publication cannot mask; rejection and stale completion are handled without timers', async () => {
  let resolvePublication;
  let rejectPublication;
  const publication = new Promise((resolve, reject) => { resolvePublication = resolve; rejectPublication = reject; });
  const f = fixture({ publish: () => publication });
  f.ready.add('todo');
  f.ui.setWidget('todo-sidebar', f.factory('pending-visible'));
  assert.equal(f.widgets.get('todo-sidebar').name, 'pending-visible');
  resolvePublication({ ...f.owner, sequence: 1 });
  await publication;
  assert.deepEqual(f.bridge.status.masked, ['todo-sidebar']);
  f.bridge.remove();

  const rejected = new Promise((_resolve, reject) => { rejectPublication = reject; });
  const g = fixture({ publish: () => rejected });
  g.ready.add('todo');
  g.ui.setWidget('todo-sidebar', g.factory('reject-visible'));
  const rejection = assert.rejects(rejected, /rejected/);
  rejectPublication(new Error('rejected publication'));
  await rejection;
  assert.equal(g.widgets.get('todo-sidebar').name, 'reject-visible');
  assert.deepEqual(g.bridge.status.masked, []);
  g.bridge.remove();

  let finish;
  const stale = new Promise(resolve => { finish = resolve; });
  const h = fixture({ publish: () => stale });
  h.ready.add('todo');
  h.ui.setWidget('todo-sidebar', h.factory('stale-visible'));
  h.bridge.remove();
  finish({ ...h.owner, sequence: 1 });
  await stale;
  assert.equal(h.widgets.get('todo-sidebar').name, 'stale-visible');
  assert.deepEqual(h.bridge.status.masked, []);
});

test('public signals reread current branch, preserve results and ignore compaction/restore payloads', () => {
  const f = fixture();
  const handlers = new Map();
  const pi = { on(type, handler) { handlers.set(type, handler); return () => handlers.delete(type); } };
  const off = bindDisplayBridgeSignals(pi, () => f.bridge);
  const snapshot = f.bridge.snapshot;
  const event = { type: 'session_compact', compactionEntry: { phases: [] } };
  assert.equal(handlers.get('session_compact')(event, f.ctx), undefined);
  assert.deepEqual(f.bridge.snapshot, snapshot);
  f.change('tool-commit');
  const result = { type: 'tool_result', toolName: 'todo', details: { restore: { phases: [] } } };
  assert.equal(handlers.get('tool_result')(result, f.ctx), undefined);
  assert.equal(f.bridge.snapshot.counts.total, 3);
  assert.deepEqual(result.details, { restore: { phases: [] } });
  f.ready.add('todo');
  f.bridge.readinessChanged();
  handlers.get('session_before_tree')({}, f.ctx);
  assert.deepEqual(f.bridge.status.masked, []);
  handlers.get('session_tree')({ type: 'session_tree' }, f.ctx);
  assert.deepEqual(f.bridge.status.masked, [], 'missing scope epoch advancement denies hiding');
  f.owner.scopeEpoch++;
  handlers.get('session_tree')({ type: 'session_tree' }, f.ctx);
  assert.deepEqual(f.bridge.status.masked, ['todo-sidebar']);
  handlers.get('session_shutdown')({}, f.ctx);
  assert.equal(f.bridge.status.disposed, true);
  off();
  assert.equal(handlers.size, 0);
});

test('recovery factory retains phase shells, ask, statuses, counts and bounded Korean text', () => {
  const snapshot = projectNativeTodo([{ type: 'custom', customType: 'senpi.todo-state', data: {
    schema: 'v2', ask: { entryId: 'ask', capturedAt: 1, text: 'Current ask' },
    phases: [{ name: 'Empty', tasks: [] }, { name: '검증', tasks: [
      { content: '긴한국어내용', status: 'in_progress' }, { content: 'done', status: 'completed' },
      { content: 'dropped', status: 'abandoned' }, { content: 'later', status: 'pending' },
    ] }],
  } }]);
  const lines = inlineRecoveryLines(snapshot).join('\n');
  assert.ok(lines.includes('Ask: Current ask'));
  assert.ok(lines.includes('Empty: 0/0 closed'));
  assert.ok(lines.includes('검증: 2/4 closed; completed=1; dropped=1'));
  const factory = inlineRecoveryFactory(snapshot);
  const a = factory();
  const b = factory();
  assert.notEqual(a, b);
  for (const width of [80, 40, 24, 12, 1]) {
    const rows = a.render(width);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      const cells = [...row].reduce((total, character) => total + (character.codePointAt(0) >= 0xac00 ? 2 : 1), 0);
      assert.ok(cells <= width, `width ${width}: ${row}`);
    }
  }
  a.dispose();
  assert.deepEqual(a.render(80), []);
  assert.ok(b.render(80).length > 0);
});

test('task3 source invalidation restores inline until the exact new publication sequence is painted', () => {
  const f = fixture();
  let paintedSequence = f.bridge.status.publication.sequence;
  let held = true;
  f.adapter.isReady = receipt => held && receipt.sequence === paintedSequence;
  f.ui.setWidget('todo-sidebar', f.factory('native-current'));
  assert.deepEqual(f.bridge.status.masked, ['todo-sidebar']);
  f.bridge.invalidate();
  const current = f.bridge.status.publication;
  assert.ok(current.sequence > paintedSequence);
  assert.deepEqual(f.bridge.status.masked, []);
  assert.equal(f.widgets.get('todo-sidebar').name, 'native-current');
  paintedSequence = current.sequence;
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, ['todo-sidebar']);
  held = false;
  f.bridge.readinessChanged();
  assert.deepEqual(f.bridge.status.masked, []);
  assert.equal(f.widgets.get('todo-sidebar').name, 'native-current');
  f.bridge.remove();
});
