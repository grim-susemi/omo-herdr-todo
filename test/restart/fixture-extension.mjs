// Loaded by Node --import before the real SDK, and as a normal SDK extension.
// Only public extension callbacks and diagnostic subscriptions are used.
import net from 'node:net';
import { subscribe } from 'node:diagnostics_channel';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';

const key = Symbol.for('omo.restart.native.qa.observer');

// Per-request supported transport boundary: never replace fetch or its globals.
export async function probeDeniedFetch(url, fetchRequest = fetch) {
  const dispatches = [];
  const inspection = { depth: null, showHidden: true, customInspect: false,
    maxArrayLength: null, maxStringLength: null };
  try {
    await fetchRequest(url, {
      signal: AbortSignal.timeout(5000),
      dispatcher: {
        dispatch(options, handler) {
          const code = 'OMO_RESTART_QA_DENIED';
          dispatches.push({ origin: String(options.origin), path: options.path, method: options.method,
            code, handler: 'onError', connectorInvoked: false,
            requestRaw: inspect(options, inspection), handlerRaw: inspect(handler, inspection),
            handlerOwnPropertyNames: Object.getOwnPropertyNames(handler) });
          handler.onError(Object.assign(new Error('Owned diagnostic denied before connection'), { code }));
          return false;
        },
      },
    });
    return { rejected: false, dispatches };
  } catch (error) {
    return { rejected: true, dispatches,
      error: { name: error.name, message: error.message, stack: error.stack,
        ownPropertyNames: Object.getOwnPropertyNames(error), raw: inspect(error, inspection),
        causePresent: Object.hasOwn(error, 'cause'), causeType: typeof error.cause,
        causeRaw: inspect(error.cause, inspection), causeCode: error.cause?.code } };
  }
}

if (process.env.OMO_RESTART_QA_PIPE && !globalThis[key]) {
  const socket = net.createConnection(process.env.OMO_RESTART_QA_PIPE);
  const state = { socket, providerRequestCount: 0, networkRequestCount: 0,
    nativeFetch: fetch };
  const send = value => socket.write(JSON.stringify({ ...value, nonce: process.env.OMO_RESTART_QA_NONCE,
    pid: process.pid }) + '\n');
  state.send = send;
  globalThis[key] = state;
  socket.on('error', error => { console.error(error); process.exitCode = 1; });
  socket.unref();
  for (const channel of ['undici:request:create', 'http.client.request.start']) {
    subscribe(channel, message => {
      state.networkRequestCount++;
      send({ type: 'network-request', channel, origin: message.request?.origin ?? message.request?.host,
        method: message.request?.method, networkRequestCount: state.networkRequestCount });
    });
  }
  send({ type: 'process-start', argv: process.argv, exe: process.execPath,
    isolatedChild: process.env.SENPI_CLI_ISOLATED_CHILD === '1',
    nodeVersion: process.version, stdinTTY: Boolean(process.stdin.isTTY), stdoutTTY: Boolean(process.stdout.isTTY) });
  process.once('exit', code => send({ type: 'process-exit', code }));
}

export default function fixture(pi) {
  const state = globalThis[key];
  if (!state) throw new Error('Native QA preload observer is required');
  // Public getFlag is extension-local, but values are shared across extensions.
  // Matching OmO's boolean/default registers observation, never a forced value.
  pi.registerFlag('omo-senpi-onboarding-disabled', { type: 'boolean', default: false });
  pi.registerFlag('omo-senpi-disabled', { type: 'boolean', default: false });
  async function capture(ctx, label) {
    const commands = pi.getCommands();
    const paths = [...new Set([process.argv[1], ...(ctx.loadedExtensionPaths ?? []).filter(path =>
      !path.startsWith('<') && !path.startsWith('builtin:'))])];
    const modules = await Promise.all(paths.map(async path => ({
      path, sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
    })));
    const sdk = JSON.parse(await readFile(process.env.OMO_RESTART_QA_SDK + '/package.json', 'utf8'));
    const omo = JSON.parse(await readFile(process.env.OMO_RESTART_QA_OMO + '/package.json', 'utf8'));
    const completedPath = join(ctx.agentDir, 'omo-senpi/omo-native/onboarding-completed');
    let completed = 'present';
    try { await readFile(completedPath); }
    catch (error) { completed = error.code; }
    state.send({ type: 'native-scope', label, mode: ctx.mode, hasUI: ctx.hasUI,
      stdinTTY: Boolean(process.stdin.isTTY), stdoutTTY: Boolean(process.stdout.isTTY),
      sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd, agentDir: ctx.agentDir, cli: process.argv[1],
      sdkVersion: sdk.version, omoVersion: omo.version,
      argv: process.argv.slice(1), loadedExtensionPaths: ctx.loadedExtensionPaths, modules,
      builtinPolicy: { enabledBuiltinExtensions: pi.getSettings().enabledBuiltinExtensions },
      skillPolicy: { path: join(process.env.HOME, '.omo/omo.json'),
        config: JSON.parse(await readFile(join(process.env.HOME, '.omo/omo.json'), 'utf8')) },
      discovery: { activeTools: pi.getActiveTools(),
        configuredTools: pi.getAllTools().map(({ name, exposure, sourceInfo }) => ({ name, exposure, sourceInfo })),
        skills: commands.filter(command => command.source === 'skill'),
        prompts: commands.filter(command => command.source === 'prompt') },
      providerRequestCount: state.providerRequestCount, networkRequestCount: state.networkRequestCount,
      onboarding: { disabled: pi.getFlag('omo-senpi-onboarding-disabled'), completed, completedPath },
      allComponentsDisabled: pi.getFlag('omo-senpi-disabled'),
      mcp: JSON.parse(await readFile(join(ctx.agentDir, 'mcp.json'), 'utf8')),
      branch: ctx.sessionManager.getBranch(), leaf: ctx.sessionManager.getLeafId(),
      commands });
  }
  pi.on('before_provider_request', (_event, ctx) => {
    state.providerRequestCount++;
    state.send({ type: 'provider-request-observed', providerRequestCount: state.providerRequestCount });
    // A throwing payload hook was observed to fail open on this SDK. This is
    // best-effort native abort, not a claimed transport/network denial.
    ctx.abort();
    throw new Error('Native QA detected forbidden provider work');
  });
  pi.on('input', event => {
    state.send({ type: 'input-rejected', inputId: event.inputId });
    return { action: 'handled' };
  });
  pi.on('session_start', async (event, ctx) => {
    state.send({ type: 'session-start', reason: event.reason,
      onboardingDisabled: pi.getFlag('omo-senpi-onboarding-disabled') });
    await capture(ctx, 'startup');
    ctx.ui.setStatus('restart-qa', `QA_NATIVE_${process.env.OMO_RESTART_QA_NONCE}`);
  });
  pi.registerCommand('qa-native-receipt', {
    description: 'Capture current native QA scope without a model turn',
    handler: async (args, ctx) => {
      await capture(ctx, args);
      ctx.ui.notify(`QA_RECEIPT_${args}_${process.env.OMO_RESTART_QA_NONCE}`, 'info');
    },
  });
  pi.registerCommand('qa-native-network', {
    description: 'Deny one owned diagnostic fetch through its per-request dispatcher',
    handler: async (url, ctx) => {
      const target = new URL(url);
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' ||
        target.pathname !== '/restart-negative/' + process.env.OMO_RESTART_QA_NONCE) {
        throw new Error('Only the owned loopback diagnostic target is allowed');
      }
      const sessionId = ctx.sessionManager.getSessionId();
      state.send({ type: 'network-probe-invoked', url, method: 'GET', sessionId,
        transport: 'Node built-in fetch', dispatcherScope: 'this invocation only',
        nativeFetchCapturedBeforeSdk: true, fetchChangedSincePreload: fetch !== state.nativeFetch,
        nodeVersion: process.version, undiciVersion: process.versions.undici });
      // Stock configureHttpDispatcher installs bundled Undici globals on Node.
      // Retain Node's actual built-in fetch for this invocation only; no global patch.
      const result = await probeDeniedFetch(url, state.nativeFetch);
      state.send({ type: 'network-probe-result', sessionId, ...result,
        providerRequestCount: state.providerRequestCount, networkRequestCount: state.networkRequestCount });
      ctx.ui.notify(`QA_NETWORK_DENIED_${process.env.OMO_RESTART_QA_NONCE}`, 'info');
    },
  });
  pi.registerCommand('qa-native-exit', {
    description: 'Graceful exit of this isolated QA parent',
    handler: async (_args, ctx) => { await capture(ctx, 'shutdown'); ctx.shutdown(); },
  });
}
