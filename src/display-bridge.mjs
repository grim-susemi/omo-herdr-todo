import { createHash } from 'node:crypto';
import { isChildSession } from './child-guard.mjs';
import { projectNativeTodo } from './native-todo.mjs';
import { inlineRecoveryFactory } from './inline-recovery.mjs';

const roles = new Map([['todo-sidebar', 'todo'], ['omo-task', 'workers'], ['omo-dag', 'dag']]);
const signature = snapshot => JSON.stringify([snapshot.phases, snapshot.ask]);
const sameScope = (a, b) => a && b && a.ownerKey === b.ownerKey &&
  a.sessionId === b.sessionId && a.scopeEpoch === b.scopeEpoch;

export function displayOwnerKey(socketPath, parentPaneId, sessionId) {
  return createHash('sha256').update(JSON.stringify([socketPath, parentPaneId, sessionId])).digest('hex').slice(0, 24);
}

/**
 * Task5 supplies publication receipts and authenticated painted role coverage.
 * This module never issues/accepts ACKs or assumes a viewer is ready.
 */
export function installDisplayBridge(ctx, adapter, { environment = process.env } = {}) {
  function ownerFor(context) {
    // Children inherit UI/pane environment. This check MUST precede UI/owner/read.
    if (isChildSession(context?.sessionManager?.getSessionFile?.())) return null;
    if (context?.hasUI !== true || context.mode !== 'tui') return null;
    const next = adapter?.getOwner?.();
    if (!next || typeof next.socketPath !== 'string' || !next.socketPath ||
      typeof next.parentPaneId !== 'string' || !next.parentPaneId ||
      next.socketPath !== environment.HERDR_SOCKET_PATH || next.parentPaneId !== environment.HERDR_PANE_ID ||
      next.sessionId !== context.sessionManager.getSessionId() ||
      !Number.isSafeInteger(next.scopeEpoch) || next.scopeEpoch < 1 ||
      next.ownerKey !== displayOwnerKey(next.socketPath, next.parentPaneId, next.sessionId)) return null;
    return { ...next };
  }
  let owner;
  try { owner = ownerFor(ctx); } catch { return undefined; }
  if (!owner) return undefined;
  const ui = ctx.ui;
  const original = ui.setWidget;
  if (typeof original !== 'function') return undefined;
  let disposed = false;
  let suspended = false;
  let blockedEpoch = null;
  let snapshot = null;
  let recovery = null;
  let receipt = null;
  let published = null;
  let pending = null;
  let revision = 0;
  let readFailed = false;
  const captures = new Map();
  const masks = new Set();
  const failures = [];
  const fail = (boundary, error) => failures.push({ boundary, message: String(error?.message ?? error) });
  const own = (key, content, options) => original.call(ui, key, content, options);

  function ownsSetter() {
    if (disposed) return false;
    try {
      if (isChildSession(ctx.sessionManager.getSessionFile?.())) return false;
      return ctx.hasUI === true && ctx.mode === 'tui' && ctx.ui === ui && ui.setWidget === wrapper;
    } catch (error) { fail('context', error); return false; }
  }

  function current() {
    if (!ownsSetter()) return false;
    try {
      return sameScope(ownerFor(ctx), owner);
    } catch (error) { fail('context', error); return false; }
  }

  function restore(key) {
    if (!masks.has(key) || !ownsSetter()) return false;
    const capture = captures.get(key);
    try {
      if (capture && (key !== 'todo-sidebar' || capture.content === undefined ||
        snapshot && capture.signature === signature(snapshot))) {
        own(key, capture.content, capture.options);
      } else if (key === 'todo-sidebar') {
        const content = snapshot?.availability === 'empty' && snapshot.phases.length === 0
          ? undefined : recovery ?? inlineRecoveryFactory(null, 'unavailable');
        own(key, content);
      } else return false;
      masks.delete(key);
      return true;
    } catch (error) { fail('restore', error); return false; }
  }

  function covered(key) {
    const role = roles.get(key);
    if (!receipt || readFailed || suspended || blockedEpoch !== null || !current()) return false;
    const setting = adapter.settings?.[role] ?? 'auto';
    if (setting !== 'auto') return false;
    try {
      if (adapter.isReady?.({ ...receipt, role }) !== true) return false;
      if (role === 'workers') {
        const dagOwned = adapter.hasDagOwnedTasks?.();
        if (typeof dagOwned !== 'boolean') return false;
        if (dagOwned && adapter.isReady({ ...receipt, role: 'dag' }) !== true) return false;
      }
      return true;
    } catch (error) { fail('readiness', error); return false; }
  }

  function reconcile() {
    if (!current()) return;
    for (const key of roles.keys()) {
      const capture = captures.get(key);
      const safe = capture ? capture.content !== undefined :
        key === 'todo-sidebar' && recovery !== null && snapshot?.availability !== 'waiting' &&
          snapshot?.counts.total > 0;
      if (!safe || !covered(key)) { restore(key); continue; }
      if (masks.has(key)) continue;
      try {
        own(key, undefined, capture?.options);
        masks.add(key);
      } catch (error) {
        fail('mask', error);
        receipt = null;
        published = null;
        pending = null;
        revision++;
        // A failing mask setter may have removed content before throwing.
        masks.add(key);
        restore(key);
      }
    }
  }

  function read() {
    try {
      const value = {
        ...projectNativeTodo(ctx.sessionManager.getBranch()),
        ownerKey: owner.ownerKey, sessionId: owner.sessionId, scopeEpoch: owner.scopeEpoch,
        leafRevision: ctx.sessionManager.getLeafId(),
      };
      snapshot = value;
      readFailed = value.availability === 'waiting';
      recovery = readFailed ? null : inlineRecoveryFactory(value);
      // A fresh readable branch has no native Todo yet. Publish that waiting
      // state so its viewer can start; readFailed still prevents native masks.
      return true;
    } catch (error) {
      fail('read', error);
      readFailed = true;
      recovery = snapshot ? inlineRecoveryFactory(snapshot, 'last-known; source read failed') : null;
      return false;
    }
  }

  function completePublication(value, candidate, id) {
    if (disposed || id !== revision || !current()) return false;
    // An async completion cannot authorize hiding a newer unread branch.
    if (!read() || candidate !== JSON.stringify(snapshot)) {
      receipt = null;
      published = null;
      pending = null;
      refresh();
      return false;
    }
    if (!sameScope(value, owner) || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
      fail('publication', 'Rejected or mismatched publication receipt');
      receipt = null;
      published = null;
      pending = null;
      reconcile();
      return false;
    }
    receipt = { ownerKey: owner.ownerKey, sessionId: owner.sessionId, scopeEpoch: owner.scopeEpoch, sequence: value.sequence };
    published = candidate;
    pending = null;
    reconcile();
    return receipt !== null;
  }

  function refresh() {
    if (!current() || suspended || blockedEpoch !== null) return false;
    if (!read()) {
      revision++;
      receipt = null;
      published = null;
      pending = null;
      reconcile();
      return false;
    }
    const candidate = JSON.stringify(snapshot);
    if (candidate === published || candidate === pending) {
      reconcile();
      return receipt !== null;
    }
    const id = ++revision;
    receipt = null;
    pending = candidate;
    try {
      const result = adapter.publish?.(structuredClone(snapshot));
      if (result && typeof result.then === 'function') {
        // Do not change the native synchronous setter/tool contract.
        Promise.resolve(result).then(value => completePublication(value, candidate, id), error => {
          if (disposed || id !== revision || !current()) return;
          fail('publication', error);
          receipt = null;
          published = null;
          pending = null;
          reconcile();
        });
        reconcile();
        return false;
      }
      return completePublication(result, candidate, id);
    } catch (error) {
      fail('publication', error);
      receipt = null;
      published = null;
      pending = null;
      reconcile();
      return false;
    }
  }

  function wrapper(key, content, options) {
    if (!roles.has(key)) return original.call(this, key, content, options);
    if (!current()) {
      const result = original.call(this, key, content, options);
      // A new-scope native publication must not later be overwritten by an old
      // capture when the controller reports the scope transition.
      masks.delete(key);
      captures.delete(key);
      return result;
    }
    // Successful native setter publication is required before factory capture.
    // The host, not this bridge, owns instance construction/disposal.
    let result;
    try {
      result = original.call(this, key, content, options);
    } catch (error) {
      fail('native-setter', error);
      receipt = null;
      published = null;
      read();
      restore(key);
      return undefined;
    }
    masks.delete(key);
    if (suspended || blockedEpoch !== null) {
      captures.delete(key);
      return result;
    }
    if (content !== undefined && !Array.isArray(content) && typeof content !== 'function') {
      captures.delete(key);
      receipt = null;
      return result;
    }
    read();
    captures.set(key, { content, options, signature: snapshot && signature(snapshot) });
    refresh();
    return result;
  }

  const bridge = {
    get snapshot() { return snapshot && structuredClone(snapshot); },
    get status() {
      return { disposed, suspended, owner: { ...owner }, masked: [...masks], capturedKeys: [...captures.keys()],
        publication: receipt && { ...receipt }, readFailed };
    },
    failures,
    captured(key) { return captures.get(key); },
    invalidate() {
      revision++;
      receipt = null;
      published = null;
      pending = null;
      reconcile();
      return refresh();
    },
    readinessChanged() {
      if (suspended || blockedEpoch !== null) return false;
      return this.observe(null, ctx);
    },
    suspend() {
      if (!current()) return;
      // Before navigation, restore the old branch while it is still current.
      read();
      for (const key of [...masks]) restore(key);
      suspended = true;
      revision++;
      receipt = null;
      pending = null;
      published = null;
    },
    observe(event, context = ctx) {
      if (disposed) return false;
      if (event?.type === 'session_tree' || event?.type === 'session_start') {
        blockedEpoch = owner.scopeEpoch;
        captures.clear();
        masks.clear(); // Builtin-first lifecycle already published the new branch.
        snapshot = null;
        recovery = null;
        revision++;
        receipt = null;
        pending = null;
        published = null;
      }
      try {
        const next = ownerFor(context);
        if (!next || context.ui !== ui || ui.setWidget !== wrapper) return false;
        if (!sameScope(next, owner)) {
          owner = next;
          // Restore genuine last-native worker/DAG surfaces, then discard their
          // authorization for the new scope. Todo uses newly read recovery.
          for (const key of [...masks]) if (key !== 'todo-sidebar') restore(key);
          captures.clear();
          snapshot = null;
          recovery = null;
          receipt = null;
          pending = null;
          published = null;
          revision++;
        }
        ctx = context;
        if (blockedEpoch !== null && owner.scopeEpoch === blockedEpoch) return false;
        blockedEpoch = null;
        suspended = false;
        return refresh();
      } catch (error) { fail('context', error); return false; }
    },
    remove() {
      if (disposed) return;
      // Do not replace another addon wrapper, or touch a replaced/invalid UI.
      if (ownsSetter()) {
        let next;
        try { next = ownerFor(ctx); } catch (error) { fail('context', error); }
        if (next) {
          if (!sameScope(next, owner)) {
            snapshot = null;
            recovery = null;
            captures.delete('todo-sidebar');
          }
          owner = next;
          read();
        } else {
          // Without a current binding, never restore Todo from an old branch.
          snapshot = null;
          recovery = null;
          captures.delete('todo-sidebar');
        }
        for (const key of [...masks]) restore(key);
        ui.setWidget = original;
      }
      disposed = true;
      revision++;
      receipt = null;
      pending = null;
    },
  };
  // Prepare recovery before interception or any authorization to hide.
  read();
  ui.setWidget = wrapper;
  refresh();
  return bridge;
}

/** Public post-commit signals only; callback payloads never become Todo state. */
export function bindDisplayBridgeSignals(pi, getBridge) {
  const off = [];
  for (const type of ['tool_result', 'tool_execution_end', 'message_end', 'agent_end', 'session_compact', 'session_tree']) {
    off.push(pi.on(type, (event, ctx) => {
      if ((type === 'tool_result' || type === 'tool_execution_end') &&
        event.toolName !== 'todo' && event.toolName !== 'todowrite') return;
      getBridge()?.observe(event, ctx);
    }));
  }
  for (const type of ['session_before_tree', 'session_before_switch', 'session_before_fork', 'session_before_reload']) {
    off.push(pi.on(type, () => { getBridge()?.suspend(); }));
  }
  off.push(pi.on('session_shutdown', () => { getBridge()?.remove(); }));
  return () => { for (const unsubscribe of off) unsubscribe(); };
}
