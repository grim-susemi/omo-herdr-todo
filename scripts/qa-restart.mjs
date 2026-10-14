// Native bootstrap qualification. This runner never constructs a host or UI.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import { deflateSync, inflateSync } from 'node:zlib';

const W = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const pathKey = value => resolve(value).replaceAll('\\', '/').toLowerCase();
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";

export function parseQaArgs(argv) {
  const names = { '--case': 'case', '--evidence-dir': 'evidenceDir', '--senpi-root': 'senpiRoot',
    '--omo-root': 'omoRoot', '--herdr-bin': 'herdrBin' };
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = names[argv[index]], value = argv[index + 1];
    if (!name || name in result || !value || value.startsWith('--')) throw new TypeError('Invalid QA option: ' + argv[index]);
    result[name] = value;
  }
  for (const name of Object.values(names)) if (!result[name]) throw new TypeError('Required QA option: ' + name);
  if (!['bootstrap', 'lease', 'pane-collapse', 'all'].includes(result.case)) throw new TypeError('Unsupported QA case: ' + result.case);
  for (const name of ['evidenceDir', 'senpiRoot', 'omoRoot', 'herdrBin']) {
    if (!isAbsolute(result[name])) throw new TypeError('Absolute QA path required: ' + name);
  }
  return result;
}

export async function listenFetchTarget(server) {
  const allocatedPorts = [];
  // Fetch blocks the WHATWG bad-port list, whose highest entry is 10080.
  // TCP port0 is not used: on this host it can land inside that list, so
  // explicit fetch-compatible loopback candidates are bound instead. The
  // scan is deterministic and bounded; only a real EADDRINUSE advances to
  // the next candidate and every other error rejects immediately.
  for (const port of Array.from({ length: 16 }, (_, index) => 13100 + index)) {
    allocatedPorts.push(port);
    try {
      await new Promise((done, fail) => {
        let timer;
        const clear = () => { clearTimeout(timer); server.off('listening', onListening); server.off('error', onError); };
        const onListening = () => { clear(); done(); };
        const onError = error => { clear(); fail(error); };
        timer = setTimeout(() => { clear(); fail(new Error('Loopback bind deadline exceeded: ' + port)); }, 5000);
        server.once('listening', onListening);
        server.once('error', onError);
        server.listen(port, '127.0.0.1');
      });
      return allocatedPorts;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') { error.attemptedPorts = [...allocatedPorts]; throw error; }
    }
  }
  const error = new Error('No fetch-compatible owned loopback port allocated');
  error.attemptedPorts = [...allocatedPorts];
  throw error;
}

export function sameProcess(a, b) {
  return Boolean(a && b && ['pid', 'parentPid', 'birth', 'kernelBirthTicks', 'exe', 'argv'].every(key =>
    a[key] !== undefined && a[key] === b[key]));
}

export function assertNativeReceipt(value, expected) {
  assert.equal(value.type, 'native-scope');
  for (const key of ['nonce', 'pid', 'sessionId']) assert.equal(value[key], expected[key], key);
  for (const key of ['agentDir', 'cwd', 'cli']) assert.equal(pathKey(value[key]), pathKey(expected[key]), key);
  assert.equal(value.mode, 'tui');
  for (const key of ['hasUI', 'stdinTTY', 'stdoutTTY']) assert.equal(value[key], true, key);
  assert.equal(value.sdkVersion, '2026.10.13');
  assert.equal(value.omoVersion, '5.1.33');
  assert.equal(value.providerRequestCount, 0);
  assert.equal(value.networkRequestCount, 0);
  assert.deepEqual(value.argv, expected.argv, 'Actual native argv');
  assert.deepEqual(value.loadedExtensionPaths.map(pathKey).sort(), expected.extensionPaths.map(pathKey).sort(),
    'Only exact explicitly selected extension files loaded');
  assert.deepEqual(value.discovery.activeTools, [], 'No active tools');
  assert.ok(Array.isArray(value.discovery.configuredTools), 'Public configured-tool observation');
  assert.deepEqual(value.discovery.skills, [], 'No discovered skills');
  assert.deepEqual(value.discovery.prompts, [], 'No discovered prompt templates');
  assert.ok(pathKey(value.sessionFile).startsWith(pathKey(expected.sessionDir) + '/'), 'Isolated session storage');
  assert.equal(value.onboarding?.disabled, true, 'Effective public onboarding flag');
  assert.equal(value.onboarding?.completed, 'ENOENT', 'No artificial completed-onboarding state');
  assert.notEqual(value.allComponentsDisabled, true, 'Actual OmO components retained');
  assert.ok(!value.branch?.some(entry => entry.type === 'custom' &&
    ['omo-onboarding:started', 'omo-onboarding:bootstrap'].includes(entry.customType)),
    'BLOCKED: current OmO queued onboarding provider work; refuse Todo input without a proven provider-denying launch');
  assert.ok(value.loadedExtensionPaths.some(path => pathKey(path) === pathKey(expected.plugin)), 'Actual OmO plugin loaded');
  assert.ok(value.loadedExtensionPaths.some(path => pathKey(path) === pathKey(expected.todo)), 'Actual native Todo loaded');
  for (const module of expected.modules) assert.ok(value.modules.some(actual =>
    pathKey(actual.path) === pathKey(module.path) && actual.sha256 === module.sha256), 'Current source: ' + module.path);
}

export function assertPreservedPane(before, after) {
  assert.ok(after, 'Original pane must still exist');
  assert.equal(after.paneId, before.paneId);
  assert.equal(after.tabId, before.tabId);
  assert.ok(sameProcess(before.shell, after.shell), 'Original shell identity must survive');
  assert.deepEqual(after.rect, before.rect, 'Original geometry must survive');
}

export function assertFrame(frame, expected) {
  for (const key of ['pid', 'nonce', 'paneId']) assert.equal(frame[key], expected[key], key);
  assert.equal(frame.source, 'visible');
  const text = stripVTControlCharacters(frame.ansi);
  assert.ok(text.split(/\r?\n/).some(line => line.includes(expected.marker) &&
    !/(?:wait-output|--match|--regex|\/todo append|PS[^>]*>)/.test(line)), 'Current visible marker outside command echo');
}

const POWERSHELL = join(process.env.SystemRoot ?? process.env.windir ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const EVIDENCE_PREFIX = ['', '.omo', 'evidence', ''].join('/');

async function powershell(script) {
  const { stdout } = await execute(POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { cwd: W, timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

export async function processIdentity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  return powershell(`$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p) {
    $h=[Diagnostics.Process]::GetProcessById(${pid}); try {
      @{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;birth=$p.CreationDate.ToUniversalTime().ToString('o');
        kernelBirthTicks=$h.StartTime.ToUniversalTime().Ticks.ToString();exe=$p.ExecutablePath;argv=$p.CommandLine} |
        ConvertTo-Json -Compress
    } finally { $h.Dispose() } }`);
}

// Retain a native handle and arm its exit wait before q/kill. The same handle
// checks birth and kernel image immediately before the exact-child action.
export async function processExit(identity, kill = false) {
  assert.match(identity.kernelBirthTicks, /^\d+$/, 'Original precise kernel birth required');
  const script = `$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetProcessById(${identity.pid});
    try {
      $p.EnableRaisingEvents=$true;
      $c=Get-CimInstance Win32_Process -Filter 'ProcessId=${identity.pid}';
      if(!$c -or $c.ParentProcessId -ne ${identity.parentPid} -or
        $c.CreationDate.ToUniversalTime().ToString('o') -ne ${quote(identity.birth)} -or
        $c.ExecutablePath -ne ${quote(identity.exe)} -or $c.CommandLine -cne ${quote(identity.argv)} -or
        $p.StartTime.ToUniversalTime().Ticks.ToString() -cne ${quote(identity.kernelBirthTicks)}) { throw 'identity refusal' }
      Add-Type 'using System; using System.Text; using System.Runtime.InteropServices;
        public class QAImage { [DllImport("kernel32.dll", SetLastError=true)]
        public static extern bool QueryFullProcessImageName(IntPtr h, int f, StringBuilder b, ref int s); }';
      $b=New-Object Text.StringBuilder 32768; $n=$b.Capacity;
      if(![QAImage]::QueryFullProcessImageName($p.Handle,0,$b,[ref]$n) -or $b.ToString() -ne ${quote(identity.exe)}) { throw 'kernel image refusal' }
      [Console]::WriteLine('ARMED');
      ${kill ? "if([Console]::ReadLine() -ne 'GO') { throw 'kill trigger refused' }; $p.Kill();" : ''}
      if(!$p.WaitForExit(20000)) { throw 'exact process exit deadline' }
      [Console]::WriteLine((@{pid=${identity.pid};birth=${quote(identity.birth)};exitCode=$p.ExitCode;
        killed=$${kill ? 'true' : 'false'};handleDisposed=$true}|ConvertTo-Json -Compress));
    } finally { $p.Dispose() }`;
  const child = spawn(POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { cwd: W, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', arm;
  const armed = new Promise((done, fail) => { arm = { done, fail }; });
  const completed = new Promise((done, fail) => {
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('ARMED\n') || output.includes('ARMED\r\n')) arm.done(); });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', error => { arm.fail(error); fail(error); });
    child.once('exit', code => {
      if (code !== 0) { const error = new Error(`Native exit observer ${code}: ${errors}`); arm.fail(error); fail(error); }
      else done(JSON.parse(output.trim().split(/\r?\n/).at(-1)));
    });
  });
  completed.catch(() => {});
  await armed;
  return { completed, identity: await processIdentity(child.pid),
    trigger: () => child.stdin.end('GO\n') };
}

export async function runBootstrap(options) {
  const E = resolve(options.evidenceDir);
  assert.ok(pathKey(E).startsWith(pathKey(W) + EVIDENCE_PREFIX), 'Evidence must be inside this worktree');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node >=24 required');
  assert.equal(process.platform, 'win32', 'Native proof requires Windows');
  await mkdir(E, { recursive: true });
  // Keep each failed native admission, including its ANSI and source binding.
  try {
    const previous = JSON.parse(await readFile(join(E, 'result.json'), 'utf8'));
    const archive = join(E, 'attempts', previous.nonce);
    await mkdir(archive, { recursive: true });
    for (const name of await readdir(E)) {
      if (/\.(?:json|ansi|md)$/.test(name)) await copyFile(join(E, name), join(archive, name));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const nonce = randomUUID(), runtime = join(E, 'isolated-' + nonce);
  const fixture = join(W, 'test/restart/fixture-extension.mjs');
  const pipe = '\\\\.\\pipe\\omo-restart-native-' + nonce;
  const resources = { executor: process.env.OMO_QA_EXECUTOR ?? 'local', nonce, status: 'before-allocation', owned: [],
    pipe, runtime, ownerPaneActions: 0, focusActions: 0, globalInventoryAssertions: false };
  const events = new EventEmitter(), messages = [], sockets = new Set(), processes = [], captures = [], cases = [];
  const inventories = [];
  let tabId, parentPane, viewerPane, server, targetServer, result;
  let targetConnections = 0;
  const protectedPanes = [];
  const save = async (name, value) => writeFile(join(E, name), JSON.stringify(value, null, 2));
  const ledger = async () => save('resources.json', resources);
  const status = async text => writeFile(join(E, 'STATUS.md'), '# Native bootstrap\n\n' + text + '\n');
  const wait = (type, predicate = () => true) => {
    let listener, timer;
    const promise = new Promise((done, fail) => {
      listener = message => {
        if (message.type !== type || message.nonce !== nonce || !predicate(message)) return;
        clearTimeout(timer); events.off('message', listener); done(message);
      };
      timer = setTimeout(() => { events.off('message', listener); fail(new Error('Missing native event: ' + type)); }, 30000);
      events.on('message', listener);
    });
    promise.catch(() => {});
    return promise;
  };
  async function cli(args, raw = false) {
    const { stdout } = await execute(options.herdrBin, args, {
      cwd: W, env: { ...process.env, MSYS_NO_PATHCONV: '1', HERDR_BIN_PATH: options.herdrBin },
      timeout: 35000, maxBuffer: 16 * 1024 * 1024, encoding: raw ? 'buffer' : 'utf8', windowsHide: true,
    });
    if (raw) return stdout;
    // Herdr pane run acknowledges success with empty stdout.
    if (!stdout.trim()) return {};
    const reply = JSON.parse(stdout);
    if (reply.error) throw new Error(JSON.stringify(reply.error));
    return reply.result;
  }
  async function paneBinding(paneId, owningTabId = tabId) {
    const info = await cli(['pane', 'process-info', '--pane', paneId]);
    const layout = await cli(['pane', 'layout', '--pane', paneId]);
    const pane = layout.layout.panes.find(value => value.pane_id === paneId);
    assert.ok(pane, 'Authoritative pane membership');
    const shell = await processIdentity(info.process_info.shell_pid);
    assert.ok(shell?.exe && shell?.argv && shell?.birth, 'Public shell identity');
    return { paneId, tabId: pane.tab_id ?? owningTabId, rect: pane.rect, shell };
  }
  async function capture(paneId, identity, marker, label) {
    assert.ok(sameProcess(identity, await processIdentity(identity.pid)), 'Current frame process identity');
    const ansi = await cli(['pane', 'read', paneId, '--source', 'visible', '--format', 'ansi'], true);
    const name = label + '.ansi';
    await writeFile(join(E, name), ansi);
    const binding = await paneBinding(paneId);
    const frame = { pid: identity.pid, birth: identity.birth, nonce, paneId, source: 'visible',
      ansi: ansi.toString('utf8'), marker, binding, artifact: name, sha256: sha(ansi) };
    assertFrame(frame, { pid: identity.pid, nonce, paneId, marker });
    captures.push(frame); await save('frames.json', captures);
    return frame;
  }
  function frameWait(paneId, marker) {
    const waiting = cli(['pane', 'wait-output', paneId, '--match', marker, '--source', 'visible', '--timeout', '30000']);
    waiting.catch(() => {});
    return waiting;
  }
  async function registerProcess(message, shell, script) {
    const identity = await processIdentity(message.pid);
    assert.ok(identity?.birth && identity?.exe && identity?.argv, 'Native PID/birth identity');
    assert.equal(identity.parentPid, shell.pid, 'Exact pane shell child');
    assert.equal(pathKey(identity.exe), pathKey(process.execPath));
    assert.ok(identity.argv.includes(script), 'Exact candidate argv');
    processes.push(identity); resources.owned.push({ kind: 'process', ...identity });
    await ledger(); return identity;
  }
  let beforeSources;
  try {
    await status('Registering isolated native CLI and owned no-focus resources.');
    resources.owned.push({ kind: 'profile', path: runtime }, { kind: 'pipe', path: pipe });
    await ledger();
    const { resolveSenpi } = await import(pathToFileURL(join(options.omoRoot, 'bin/lib/package-paths.js')));
    const resolved = resolveSenpi();
    assert.equal(pathKey(resolved.packageRoot), pathKey(options.senpiRoot), 'Official resolver root');
    const sdk = JSON.parse(await readFile(join(options.senpiRoot, 'package.json'), 'utf8'));
    const omo = JSON.parse(await readFile(join(options.omoRoot, 'package.json'), 'utf8'));
    assert.equal(sdk.version, '2026.10.13'); assert.equal(omo.version, '5.1.33');
    const plugin = join(options.omoRoot, 'plugin/extensions/omo.js');
    const todoExtension = join(options.senpiRoot, 'dist/core/extensions/builtin/todotools/index.js');
    const sourcePaths = [resolved.cliPath, plugin, todoExtension, fixture, join(W, 'scripts/qa-restart.mjs'),
      join(W, 'test/restart/qa-contract.test.mjs'),
      join(options.senpiRoot, 'dist/core/agent-session-services.js'),
      join(options.senpiRoot, 'dist/core/agent-session.js'),
      join(options.senpiRoot, 'dist/core/extensions/loader.js'),
      join(options.senpiRoot, 'dist/cli/args.js'),
      join(options.senpiRoot, 'dist/main.js'),
      join(options.senpiRoot, 'dist/core/sdk.js'),
      join(options.senpiRoot, 'dist/core/resource-loader.js'),
      join(options.senpiRoot, 'dist/core/settings-manager.js'),
      join(options.senpiRoot, 'dist/core/http-dispatcher.js'),
      join(options.senpiRoot, 'dist/core/extensions/types.d.ts'),
      join(W, 'src/viewer.mjs'), join(options.omoRoot, 'bin/lib/package-paths.js'), options.herdrBin];
    beforeSources = await Promise.all(sourcePaths.map(async path => ({ path, sha256: sha(await readFile(path)) })));
    await save('source-before.json', beforeSources);
    const cliModules = beforeSources.filter(value => [resolved.cliPath, plugin, todoExtension, fixture].includes(value.path));
    const home = join(runtime, 'home'), cwd = join(runtime, 'cwd'), agentDir = join(runtime, 'profile');
    for (const path of [home, cwd, agentDir, join(runtime, 'tmp')]) await mkdir(path, { recursive: true });
    // Current SDK no-extensions suppresses file discovery, but builtin factories
    // use this supported profile allowlist independently. Explicit files remain.
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ enabledBuiltinExtensions: [] }));
    // OmO's resources_discover contributes explicit skills after session_start,
    // outside SDK no-skills discovery. Omit those exact resources, not components.
    const disabledSkills = (await readdir(join(options.omoRoot, 'plugin/skills'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).concat('computer-use').sort();
    await mkdir(join(home, '.omo'), { recursive: true });
    await writeFile(join(home, '.omo/omo.json'), JSON.stringify({ disabled_skills: disabledSkills }));
    // Public user-profile overrides win over extension-declared MCP defaults.
    // No auth/model settings or installed plugin files are touched.
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: { context7: { enabled: false }, grep_app: { enabled: false } },
    }));
    const sessionId = randomUUID();
    const env = { HOME: home, USERPROFILE: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2),
      APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
      XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
      TEMP: join(runtime, 'tmp'), TMP: join(runtime, 'tmp'), npm_config_cache: join(runtime, 'npm-cache'),
      OMO_CODING_AGENT_DIR: agentDir, SENPI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
      OMO_PACKAGE_DIR: options.senpiRoot, SENPI_PACKAGE_DIR: options.senpiRoot, SENPI_RUNTIME: 'node',
      OMO_NATIVE: '1', OMO_OFFLINE: '1', SENPI_OFFLINE: '1', PI_OFFLINE: '1',
      DO_NOT_TRACK: '1', OMO_TELEMETRY: '0', SENPI_TELEMETRY: '0',
      OMO_RESTART_QA_PIPE: pipe, OMO_RESTART_QA_NONCE: nonce,
      OMO_RESTART_QA_SDK: options.senpiRoot, OMO_RESTART_QA_OMO: options.omoRoot,
      HERDR_BIN_PATH: options.herdrBin };
    const launch = argv => {
      const clear = "$env:NODE_OPTIONS=''; " + ['OMO_BIN', 'SENPI_BIN', 'PI_PACKAGE_DIR', 'SENPI_BRAND',
        'OMO_HERDR_TODO_STATE_DIR', 'OMO_HERDR_DAG_STATE_DIR'].map(name => `Remove-Item Env:${name} -ErrorAction SilentlyContinue; `).join('');
      return clear + Object.entries(env).map(([name, value]) => `$env:${name}=${quote(value)}; `).join('') +
        '& ' + [process.execPath, '--import', pathToFileURL(fixture).href, ...argv].map(quote).join(' ');
    };
    server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const value = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
          messages.push(value); events.emit('message', value);
        }
      });
    });
    await new Promise((done, fail) => { server.once('error', fail); server.listen(pipe, done); });
    resources.owned.push({ kind: 'loopback-listen-intent', host: '127.0.0.1', port: 0,
      controller: await processIdentity(process.pid) }); await ledger();
    targetServer = net.createServer(socket => { targetConnections++; socket.destroy(); });
    const allocatedPorts = await listenFetchTarget(targetServer);
    const targetUrl = `http://127.0.0.1:${targetServer.address().port}/restart-negative/${nonce}`;
    resources.owned.push({ kind: 'loopback-target', url: targetUrl, allocatedPorts,
      rejectedAllocationsClosed: true }); await ledger();
    for (const pane of (await cli(['pane', 'list'])).panes) {
      protectedPanes.push(await paneBinding(pane.pane_id, pane.tab_id));
    }
    await save('protected-before.json', protectedPanes);
    resources.owned.push({ kind: 'tab-create-intent', cwd, label: 'restart-native-' + nonce, noFocus: true }); await ledger();
    const tab = await cli(['tab', 'create', '--cwd', cwd, '--label', 'restart-native-' + nonce, '--no-focus']);
    tabId = tab.tab?.tab_id ?? tab.tab_id; parentPane = tab.pane?.pane_id ?? tab.pane_id;
    assert.ok(tabId, 'Official tab identity');
    resources.owned.push({ kind: 'tab', tabId }); await ledger();
    if (!parentPane) {
      const panes = (await cli(['pane', 'list'])).panes.filter(value => value.tab_id === tabId);
      assert.equal(panes.length, 1); parentPane = panes[0].pane_id;
    }
    const parent = await paneBinding(parentPane);
    resources.owned.push({ kind: 'pane', ...parent }); await ledger();
    const split = await cli(['pane', 'split', '--pane', parentPane, '--direction', 'right', '--ratio', '0.5', '--cwd', cwd, '--no-focus']);
    viewerPane = split.pane.pane_id;
    const viewerBinding = await paneBinding(viewerPane);
    resources.owned.push({ kind: 'pane', ...viewerBinding }); await ledger();
    const startup = wait('native-scope', value => value.label === 'startup');
    const sessionStart = wait('session-start');
    const start = wait('process-start', value => !value.isolatedChild);
    const childStart = wait('process-start', value => value.isolatedChild);
    const trustPrompt = frameWait(parentPane, 'Trust project folder?');
    const visible = frameWait(parentPane, 'QA_NATIVE_' + nonce);
    const extensionPaths = [plugin, todoExtension, fixture], sessionDir = join(agentDir, 'sessions');
    const argv = [resolved.cliPath, '--no-tools', '--no-extensions',
      ...extensionPaths.flatMap(path => ['--extension', path]),
      '--session-id', sessionId, '--session-dir', sessionDir,
      '--no-skills', '--no-prompt-templates', '--no-context-files', '--omo-senpi-builtin-mcps-disabled',
      '--omo-senpi-onboarding-disabled'];
    await save('launch.json', { officialResolver: resolved, argv, env, cwd, sessionId, parent, viewerBinding,
      noProductionPreparation: true, noCmd: true, noFakeHost: true });
    await cli(['pane', 'run', parentPane, launch(argv)]);
    const began = await start;
    const launcher = await registerProcess(began, parent.shell, resolved.cliPath);
    const producer = await registerProcess(await childStart, launcher, resolved.cliPath);
    await trustPrompt;
    await capture(parentPane, producer, 'Trust project folder?', 'native-trust');
    // Session-only trust for this owned empty cwd; no persisted/parent trust.
    await cli(['pane', 'send-keys', parentPane, 'down', 'down', 'enter']);
    const expected = { nonce, pid: producer.pid, sessionId, sessionDir, cwd, agentDir,
      cli: resolved.cliPath, plugin, todo: todoExtension, modules: cliModules, argv, extensionPaths };
    const scope = await startup;
    await save('native-startup.json', scope);
    const started = await sessionStart;
    const effective = { nonce, pid: producer.pid, birth: producer.birth, sessionId,
      actualArgv: scope.argv, expectedArgv: argv, extensionPaths: scope.loadedExtensionPaths,
      discovery: scope.discovery, sessionDir, sessionFile: scope.sessionFile,
      builtinPolicy: scope.builtinPolicy,
      skillPolicy: scope.skillPolicy,
      publicApis: ['ExtensionContext.loadedExtensionPaths', 'ExtensionAPI.getActiveTools',
        'ExtensionAPI.getAllTools', 'ExtensionAPI.getCommands', 'ReadonlySessionManager.getSessionFile'],
      sessionStart: started, onboarding: scope.onboarding,
      allComponentsDisabled: scope.allComponentsDisabled, mcp: scope.mcp,
      offline: { OMO_OFFLINE: env.OMO_OFFLINE, SENPI_OFFLINE: env.SENPI_OFFLINE,
        PI_OFFLINE: env.PI_OFFLINE, DO_NOT_TRACK: env.DO_NOT_TRACK },
      source: beforeSources.filter(value => value.path === plugin ||
        /(?:agent-session(?:-services)?|loader)\.js$/.test(value.path)),
      observation: 'Matching extension-local public boolean registration reads shared CLI-applied runtime value',
      pretrigger: true };
    await save('effective-config.json', effective);
    assert.equal(started.reason, 'startup');
    assert.equal(started.onboardingDisabled, true, 'Flag applied before real session_start');
    for (const name of ['context7', 'grep_app']) assert.equal(scope.mcp.mcpServers[name].enabled, false);
    assertNativeReceipt(scope, expected); await visible;
    await capture(parentPane, producer, 'QA_NATIVE_' + nonce, 'native-startup');
    cases.push({ name: 'bootstrap', ok: true, producer });
    const pretrigger = wait('native-scope', value => value.label === 'pretrigger' && value.pid === producer.pid);
    const pretriggerVisible = frameWait(parentPane, 'QA_RECEIPT_pretrigger_' + nonce);
    await cli(['pane', 'run', parentPane, '/qa-native-receipt pretrigger']);
    const admitted = await pretrigger;
    await save('native-pretrigger.json', admitted);
    assertNativeReceipt(admitted, expected);
    assert.equal(messages.filter(value => ['network-request', 'provider-request-observed'].includes(value.type)).length, 0);
    await pretriggerVisible;
    const invoked = wait('network-probe-invoked', value => value.pid === producer.pid);
    const denied = wait('network-probe-result', value => value.pid === producer.pid);
    const deniedVisible = frameWait(parentPane, 'QA_NETWORK_DENIED_' + nonce);
    const probeCommand = '/qa-native-network ' + targetUrl;
    await cli(['pane', 'run', parentPane, probeCommand]);
    const invocation = await invoked, negative = await denied;
    const networkNegative = { status: 'OBSERVED_NOT_VALIDATED', nonce, producer, sessionId,
      actualCommand: probeCommand, invocation, rejection: negative, targetUrl, targetConnections,
      rawDiagnosticEvents: messages.filter(value => value.type === 'network-request'),
      rawDiagnosticCounters: {
        invocations: messages.filter(value => value.type === 'network-probe-invoked').length,
        dispatches: negative.dispatches.length,
        providerObservedEvents: messages.filter(value => value.type === 'provider-request-observed').length,
        networkDiagnosticEvents: messages.filter(value => value.type === 'network-request').length,
        targetConnections,
      },
      denialScope: 'Only the diagnostic fetch invocation using its supplied Dispatcher; no universal process or provider blockade',
      qaGlobalDispatcherChanged: false, qaGlobalFetchChanged: false, osNetworkRulesChanged: false,
      stockSdkGlobalFetchReplacementObserved: invocation.fetchChangedSincePreload };
    // Preserve actual observations even when any admission assertion rejects.
    await save('network-negative.observed.json', networkNegative);
    await save('network-negative.json', networkNegative);
    assert.equal(invocation.url, targetUrl);
    assert.equal(invocation.sessionId, sessionId);
    assert.equal(negative.sessionId, sessionId);
    assert.equal(negative.rejected, true);
    assert.equal(negative.dispatches.length, 1);
    assert.equal(negative.dispatches[0].code, 'OMO_RESTART_QA_DENIED');
    assert.equal(negative.dispatches[0].origin, new URL(targetUrl).origin);
    assert.equal(negative.dispatches[0].path, new URL(targetUrl).pathname);
    assert.equal(negative.error.causeCode, 'OMO_RESTART_QA_DENIED');
    assert.equal(negative.providerRequestCount, 0);
    assert.equal(negative.networkRequestCount, 0);
    assert.equal(targetConnections, 0);
    await deniedVisible;
    await capture(parentPane, producer, 'QA_NETWORK_DENIED_' + nonce, 'native-network-denied');
    await save('network-negative.json', { ...networkNegative, status: 'PASS',
      rejectedBeforeConnection: true });
    cases.push({ name: 'native-fetch-denied-before-connection', ok: true, targetConnections });
    // Receipt rejection controls do not start an enabled-onboarding session:
    // startup would itself queue inference before a transport boundary exists.
    const controls = [
      { name: 'enabled-onboarding-receipt', value: { ...admitted,
        onboarding: { ...admitted.onboarding, disabled: false } } },
      ...['omo-onboarding:started', 'omo-onboarding:bootstrap'].map(customType => ({
        name: customType, value: { ...admitted,
          branch: [...admitted.branch, { type: 'custom', customType }] },
      })),
    ];
    for (const control of controls) assert.throws(() => assertNativeReceipt(control.value, expected));
    await save('rejection-controls.json', { nonce, kind: 'owned-receipt-validation-not-native-relaunch',
      controls: controls.map(control => ({ name: control.name, rejected: true })), providerTriggers: 0 });
    const marker = 'NATIVE_TODO_' + nonce.replaceAll('-', '').slice(0, 12);
    const todoVisible = frameWait(parentPane, marker);
    await cli(['pane', 'run', parentPane, '/todo append "Native QA" "' + marker + '"']);
    await todoVisible;
    const seeded = wait('native-scope', value => value.label === 'seeded' && value.pid === producer.pid);
    const seededVisible = frameWait(parentPane, 'QA_RECEIPT_seeded_' + nonce);
    await cli(['pane', 'run', parentPane, '/qa-native-receipt seeded']);
    const seededScope = await seeded; assertNativeReceipt(seededScope, expected); await seededVisible;
    const todo = seededScope.branch.filter(value => value.type === 'custom' && value.customType === 'senpi.todo-state').at(-1);
    assert.equal(todo?.data.source, 'user');
    assert.ok(todo.data.phases.some(phase => phase.tasks.some(task => task.content === marker)));
    await save('native-seeded.json', seededScope);
    await capture(parentPane, producer, marker, 'native-todo');
    cases.push({ name: 'real-todo-append', ok: true, leaf: seededScope.leaf, marker });

    // No presence/control server is fabricated. The real viewer renders a
    // readonly cache from the /todo-created state, with both offers absent.
    const { projectNativeTodo } = await import('../src/native-todo.mjs');
    const { displayOwnerKey } = await import('../src/display-bridge.mjs');
    const binding = { socketPath: process.env.HERDR_SOCKET_PATH, parentPaneId: parentPane, sessionId, scopeEpoch: 1 };
    binding.ownerKey = displayOwnerKey(binding.socketPath, parentPane, sessionId);
    const statePath = join(runtime, 'todo.json'), cachePath = join(runtime, 'cache.json');
    const state = { schema: 'omo-herdr-dashboard/role/1', ...binding, role: 'todo', language: 'en', tabId,
      paneId: viewerPane, launchToken: randomUUID(), prefsPath: statePath + '.view.json', cachePath,
      presenceOffer: null, controlOffer: null, connected: false };
    await writeFile(cachePath, JSON.stringify({ schema: 'omo-herdr-todo/cache/1',
      snapshot: { ...projectNativeTodo(seededScope.branch), ...binding, sequence: 1 } }));
    await writeFile(statePath, JSON.stringify(state));
    const viewerScript = join(W, 'src/viewer.mjs');
    const viewerArgs = [viewerScript, '--state', statePath, '--close-pane', viewerPane, '--launch-token', state.launchToken];
    async function runViewer(label) {
      const began = wait('process-start', value => value.argv[1] === viewerScript);
      const painted = frameWait(viewerPane, marker);
      await cli(['pane', 'run', viewerPane, launch(viewerArgs)]);
      const identity = await registerProcess(await began, viewerBinding.shell, viewerScript);
      await painted; await capture(viewerPane, identity, marker, label);
      return identity;
    }
    const orphan = await runViewer('orphan-before-q');
    const qExit = await processExit(orphan);
    resources.owned.push({ kind: 'exit-observer', ...qExit.identity, target: orphan }); await ledger();
    await cli(['pane', 'send-keys', viewerPane, 'q']);
    const qReceipt = await qExit.completed;
    assert.equal(qReceipt.exitCode, 0);
    assert.equal(await processIdentity(orphan.pid), null);
    const afterQ = await paneBinding(viewerPane);
    assertPreservedPane(viewerBinding, afterQ);
    inventories.push({ label: 'after-q', before: viewerBinding, after: afterQ, exit: qReceipt });
    await save('pane-inventories.json', inventories);
    const qShellMarker = 'SHELL_Q_RESTORED_' + nonce;
    const qRestored = frameWait(viewerPane, qShellMarker);
    await cli(['pane', 'run', viewerPane, "[Console]::WriteLine(('SHELL_Q_'+'RESTORED_" + nonce + "'))"]);
    await qRestored;
    await capture(viewerPane, viewerBinding.shell, qShellMarker, 'shell-after-q');
    cases.push({ name: 'orphan-graceful-q', ok: true, ...qReceipt });
    const second = await runViewer('viewer-before-kill');
    const killExit = await processExit(second, true);
    resources.owned.push({ kind: 'exit-observer', ...killExit.identity, target: second }); await ledger();
    killExit.trigger();
    const killReceipt = await killExit.completed;
    assert.equal(killReceipt.killed, true);
    assert.equal(await processIdentity(second.pid), null);
    const afterKill = await paneBinding(viewerPane);
    assertPreservedPane(viewerBinding, afterKill);
    inventories.push({ label: 'after-child-kill', before: viewerBinding, after: afterKill, exit: killReceipt });
    await save('pane-inventories.json', inventories);
    cases.push({ name: 'identity-bound-child-kill', ok: true, ...killReceipt });
    // The shell must accept a complete input line after forced child death.
    // Its output marker is split in the command to prevent self-match.
    const shellMarker = 'SHELL_RESTORED_' + nonce;
    const restored = frameWait(viewerPane, shellMarker);
    await cli(['pane', 'run', viewerPane, "[Console]::WriteLine(('SHELL_'+'RESTORED_" + nonce + "'))"]);
    await restored;
    await capture(viewerPane, viewerBinding.shell, shellMarker, 'shell-after-kill');
    assertPreservedPane(viewerBinding, await paneBinding(viewerPane));
    const third = await runViewer('viewer-rerun-same-pane');
    assertPreservedPane(viewerBinding, await paneBinding(viewerPane));
    const thirdExit = await processExit(third);
    resources.owned.push({ kind: 'exit-observer', ...thirdExit.identity, target: third }); await ledger();
    await cli(['pane', 'send-keys', viewerPane, 'q']);
    const thirdReceipt = await thirdExit.completed;
    assert.equal(thirdReceipt.exitCode, 0);
    assert.equal(await processIdentity(third.pid), null);
    const afterRerun = await paneBinding(viewerPane);
    assertPreservedPane(viewerBinding, afterRerun);
    inventories.push({ label: 'after-same-pane-rerun', before: viewerBinding, after: afterRerun, exit: thirdReceipt });
    await save('pane-inventories.json', inventories);
    cases.push({ name: 'rerun-original-pane', ok: true, oldPid: second.pid, newPid: third.pid, paneId: viewerPane });
    const finalScope = wait('native-scope', value => value.label === 'shutdown' && value.pid === producer.pid);
    const parentExit = await processExit(producer);
    resources.owned.push({ kind: 'exit-observer', ...parentExit.identity, target: producer }); await ledger();
    await cli(['pane', 'run', parentPane, '/qa-native-exit']);
    assertNativeReceipt(await finalScope, expected);
    const parentReceipt = await parentExit.completed;
    assert.equal(parentReceipt.exitCode, 0);
    assert.equal(await processIdentity(producer.pid), null);
    const afterSources = await Promise.all(beforeSources.map(async value => ({ path: value.path, sha256: sha(await readFile(value.path)) })));
    assert.deepEqual(afterSources, beforeSources);
    await save('source-before-after.json', { before: beforeSources, after: afterSources, unchanged: true });
    result = { ok: true, status: 'PASS', nonce, cases,
      providerRequestCount: messages.filter(value => value.type === 'provider-request-observed').length,
      networkRequestCount: messages.filter(value => value.type === 'network-request').length };
    assert.equal(result.providerRequestCount, 0);
    assert.equal(result.networkRequestCount, 0);
  } catch (error) {
    if (parentPane) {
      try { await writeFile(join(E, 'failed-parent.ansi'),
        await cli(['pane', 'read', parentPane, '--source', 'visible', '--format', 'ansi'], true)); }
      catch (captureError) { await save('failed-capture.json', { error: captureError.message }); }
    }
    result = { ok: false, status: 'BLOCKED', nonce, error: error.stack, cases,
      normalShutdownClaimed: false, nativeProof: false };
    if (error.attemptedPorts) {
      result.portAllocation = { attemptedPorts: error.attemptedPorts, selectedPort: null };
      await save('port-allocation.json', result.portAllocation);
    }
    await save('result.json', result);
  } finally {
    await save('messages.json', messages);
    await save('process-bindings.json', processes);
    if (beforeSources) {
      const after = await Promise.all(beforeSources.map(async value =>
        ({ path: value.path, sha256: sha(await readFile(value.path)) })));
      const unchanged = JSON.stringify(beforeSources) === JSON.stringify(after);
      await save('source-before-after.json', { before: beforeSources, after, unchanged });
      if (!unchanged) result = { ...result, ok: false, status: 'BLOCKED', sourceChanged: true };
    }
    const cleanup = { remainingOwnedResources: [], killed: [], tabClosed: false, runtimeRemoved: false,
      ownerPaneActions: 0, focusActions: 0, broaderHistoricalClosureClaim: false };
    for (const identity of [...processes].reverse()) {
      const current = await processIdentity(identity.pid).catch(error => ({ error: error.message }));
      if (!current) continue;
      if (!sameProcess(identity, current)) { cleanup.remainingOwnedResources.push({ identity, current, reason: 'identity refusal' }); continue; }
      try {
        const exit = await processExit(identity, true);
        resources.owned.push({ kind: 'cleanup-exit-observer', ...exit.identity, target: identity }); await ledger();
        exit.trigger(); cleanup.killed.push(await exit.completed);
      } catch (error) { cleanup.remainingOwnedResources.push({ identity, error: error.message }); }
    }
    if (tabId && cleanup.remainingOwnedResources.length === 0) {
      try {
        const owned = (await cli(['pane', 'list'])).panes.filter(pane => pane.tab_id === tabId);
        assert.ok(owned.every(pane => [parentPane, viewerPane].includes(pane.pane_id)), 'Foreign pane in owned tab; closure withheld');
        await cli(['tab', 'close', tabId]); cleanup.tabClosed = true;
        cleanup.panesAfter = (await cli(['pane', 'list'])).panes.filter(pane => pane.tab_id === tabId);
        assert.equal(cleanup.panesAfter.length, 0);
      } catch (error) { cleanup.remainingOwnedResources.push({ tabId, error: error.message }); }
    }
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(done => server.close(done));
    if (targetServer?.listening) await new Promise(done => targetServer.close(done));
    cleanup.loopbackTargetClosed = !targetServer?.listening;
    cleanup.targetConnections = targetConnections;
    const protectedAfter = [];
    for (const pane of protectedPanes) protectedAfter.push(await paneBinding(pane.paneId, pane.tabId));
    await save('protected-before-after.json', { before: protectedPanes, after: protectedAfter });
    assert.deepEqual(protectedAfter, protectedPanes, 'Protected pane identities and geometry unchanged');
    if (cleanup.remainingOwnedResources.length === 0) {
      await rm(runtime, { recursive: true, force: true }); cleanup.runtimeRemoved = true;
    }
    resources.status = cleanup.remainingOwnedResources.length ? 'cleanup-blocked' : 'closed';
    await ledger(); await save('cleanup.json', cleanup);
    if (cleanup.remainingOwnedResources.length) result = { ...result, ok: false, status: 'BLOCKED', cleanupBlocked: true };
    await save('result.json', result);
    await status(`${result.status}: ${result.error ?? 'Native CLI and original pane primitives passed.'}`);
  }
  return result;
}

export function assertLeaseResult(result, exitCode) {
  assert.equal(exitCode, 0, 'Actual numeric lease runner exit');
  assert.equal(result.ok, true);
  assert.equal(result.platform, 'win32', 'Native lease platform');
  assert.equal(result.sqlite, 'node:sqlite DatabaseSync');
  const names = ['exclusive-contention', 'graceful-handoff', 'fatal-release-handoff',
    'os-identity-mismatch', 'no-blind-pid-kill', 'crash-before-claim',
    'corrupt-fixture', 'no-delete-takeover', 'handle-acquisition-substitution'];
  assert.deepEqual(Object.keys(result.cases).sort(), names.sort(), 'All nine existing lease cases');
  for (const name of names) assert.equal(result.cases[name], true, name);
}

async function sourceBindings(paths) {
  return Promise.all(paths.map(async path => ({ path, sha256: sha(await readFile(path)) })));
}

// Capture both streams from launch and settle on close, not exit: the latter
// can precede stream EOF. The child owns its native resources and cleanup.
export async function runLease(options) {
  const paths = [join(W, 'scripts/qa-restart.mjs'), join(W, 'scripts/qa-primitives.mjs'),
    join(W, 'test/restart/primitive-fixtures.mjs'), join(W, 'test/restart/qa-contract.test.mjs')];
  const before = await sourceBindings(paths);
  const args = [paths[1], '--evidence-dir', options.evidenceDir, '--emit-only', 'true'];
  const child = spawn(process.execPath, args, { cwd: W, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const closed = new Promise((done, fail) => {
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', fail);
    child.once('close', (exitCode, signal) => done({ exitCode, signal }));
  });
  const terminal = await closed;
  const encoded = stdout.split(/\r?\n/).filter(line => line.startsWith('QA_DATA ')).map(line => line.slice(8)).join('');
  const packet = JSON.parse(inflateSync(Buffer.from(encoded, 'base64')));
  const result = packet.artifacts['result.json'];
  const after = await sourceBindings(paths);
  assert.deepEqual(after, before, 'Lease source stable through actual run');
  assertLeaseResult(result, terminal.exitCode);
  assert.equal(packet.artifacts['cleanup.json'].remainingOwnedResources, 0);
  return { ok: true, selectedCase: 'lease', result, artifacts: packet.artifacts,
    statusLines: packet.statusLines, sourceBinding: { before, after, unchanged: true },
    rawRun: { executable: process.execPath, args, pid: child.pid, stdout, stderr, ...terminal } };
}

// The observer must be armed before deliberate pane loss. An absent pane is
// accepted only from an authoritative membership query, never a failed query.
export async function controlledCollapse(before, operations) {
  const observer = await operations.subscribe(before.shell);
  await operations.collapse(before);
  const exit = await observer.completed;
  assert.equal(exit.pid, before.shell.pid);
  assert.equal(exit.birth, before.shell.birth);
  assert.equal(exit.handleDisposed, true);
  assert.equal(typeof exit.exitCode, 'number');
  const after = await operations.originalPane(before);
  assert.equal(after, null, 'Authoritative original pane loss required');
  assert.equal(await operations.shellIdentity(before.shell.pid), null, 'Original shell must be absent');
  let rejection;
  assert.throws(() => {
    try { assertPreservedPane(before, after); }
    catch (error) { rejection = error.message; throw error; }
  }, /Original pane must still exist/);
  return { ok: true, original: before, after, exit, preservationRejected: true,
    rejection, recreatedPanesCountedAsPreservation: false, observerIdentity: observer.identity };
}

export async function runPaneCollapse(options) {
  assert.equal(process.platform, 'win32');
  const nonce = randomUUID(), owned = [];
  const cli = async (args, raw = false) => {
    const { stdout } = await execute(options.herdrBin, args, {
      cwd: W, env: { ...process.env, MSYS_NO_PATHCONV: '1', HERDR_BIN_PATH: options.herdrBin },
      timeout: 35000, maxBuffer: 16 * 1024 * 1024, encoding: raw ? 'buffer' : 'utf8', windowsHide: true,
    });
    if (raw) return stdout;
    const reply = JSON.parse(stdout);
    assert.ok(!reply.error, JSON.stringify(reply.error));
    return reply.result;
  };
  const sources = [join(W, 'scripts/qa-restart.mjs'), join(W, 'test/restart/qa-contract.test.mjs'), options.herdrBin];
  const beforeSources = await sourceBindings(sources);
  const inventory = async (only = null) => {
    const panes = (await cli(['pane', 'list'])).panes.filter(pane => !only || only.includes(pane.pane_id));
    return Promise.all(panes.map(async pane => {
      const layout = (await cli(['pane', 'layout', '--pane', pane.pane_id])).layout;
      const member = layout.panes.find(value => value.pane_id === pane.pane_id);
      const info = await cli(['pane', 'process-info', '--pane', pane.pane_id]);
      return { paneId: pane.pane_id, tabId: pane.tab_id, terminalId: pane.terminal_id,
        focused: pane.focused, rect: member.rect, shell: await processIdentity(info.process_info.shell_pid) };
    }));
  };
  const protectedBefore = await inventory();
  let tabId, paneId, original, result;
  const cleanup = { remainingOwnedResources: [], ownerPaneActions: 0, focusActions: 0,
    broaderHistoricalClosureClaim: false, tabClosed: false };
  try {
    owned.push({ kind: 'tab-create-intent', cwd: W, label: 'restart-collapse-' + nonce, noFocus: true });
    console.log('OWNED_RESOURCE ' + JSON.stringify(owned.at(-1)));
    const tab = await cli(['tab', 'create', '--cwd', W, '--label', 'restart-collapse-' + nonce, '--no-focus']);
    tabId = tab.tab?.tab_id ?? tab.tab_id;
    paneId = tab.pane?.pane_id ?? tab.pane_id;
    assert.ok(tabId);
    owned.push({ kind: 'tab', tabId });
    if (!paneId) {
      const panes = (await cli(['pane', 'list'])).panes.filter(pane => pane.tab_id === tabId);
      assert.equal(panes.length, 1);
      paneId = panes[0].pane_id;
    }
    [original] = await inventory([paneId]);
    assert.equal(original.tabId, tabId);
    assert.ok(original.shell?.kernelBirthTicks);
    owned.push({ kind: 'pane', ...original });
    console.log('OWNED_RESOURCE ' + JSON.stringify(owned.at(-1)));
    const ansi = await cli(['pane', 'read', paneId, '--source', 'visible', '--format', 'ansi'], true);
    const frame = { paneId, nonce, pid: original.shell.pid, birth: original.shell.birth,
      source: 'visible', ansi: ansi.toString('utf8'), sha256: sha(ansi), binding: original };
    assert.ok(sameProcess(original.shell, await processIdentity(original.shell.pid)));
    const negative = await controlledCollapse(original, {
      subscribe: async identity => {
        const observer = await processExit(identity);
        owned.push({ kind: 'exit-observer', ...observer.identity, target: identity });
        console.log('COLLAPSE_ARMED ' + JSON.stringify(owned.at(-1)));
        return observer;
      },
      collapse: async () => {
        assert.deepEqual((await inventory([paneId]))[0], original, 'Owned identity immediately before collapse');
        await cli(['pane', 'close', paneId]);
      },
      originalPane: async () => (await inventory([paneId]))[0] ?? null,
      shellIdentity: processIdentity,
    });
    result = { ok: true, selectedCase: 'pane-collapse', nonce, frame, negative };
  } catch (error) {
    result = { ok: false, selectedCase: 'pane-collapse', nonce, error: error.stack, original };
  } finally {
    if (tabId) {
      try {
        const remaining = (await cli(['pane', 'list'])).panes.filter(pane => pane.tab_id === tabId);
        assert.ok(remaining.every(pane => pane.pane_id === paneId), 'No foreign pane cleanup');
        if (remaining.length) {
          const current = (await inventory([paneId]))[0];
          assertPreservedPane(original, current);
          const observer = await processExit(current.shell);
          await cli(['tab', 'close', tabId]);
          cleanup.shellExit = await observer.completed;
        }
        cleanup.panesAfter = (await cli(['pane', 'list'])).panes.filter(pane => pane.tab_id === tabId);
        assert.equal(cleanup.panesAfter.length, 0);
        cleanup.tabClosed = true;
      } catch (error) { cleanup.remainingOwnedResources.push({ tabId, paneId, error: error.message }); }
    }
    const protectedAfter = await inventory(protectedBefore.map(pane => pane.paneId));
    const afterSources = await sourceBindings(sources);
    result = { ...result, owned, cleanup, protectedBefore, protectedAfter,
      sourceBinding: { before: beforeSources, after: afterSources } };
    assert.deepEqual(protectedAfter, protectedBefore, 'Protected original identities, geometry and focus unchanged');
    assert.deepEqual(afterSources, beforeSources, 'Collapse sources unchanged');
    if (cleanup.remainingOwnedResources.length) result.ok = false;
  }
  return result;
}

// Plan's public CASE contract and task 8 rejection classes. Primitive success
// must never stand in for unimplemented independent-CLI dashboard recovery.
export const requiredQaClasses = [
  ...['bootstrap', 'lease', 'native-scope', 'same-session', 'fresh-session',
    'abnormal-exit', 'partial', 'legacy', 'race', 'late-effects', 'manual-close',
    'foreign-owner', 'package'].flatMap(name => ['positive', 'rejection'].map(branch => ({
    id: `${name}:${branch}`, case: name, branch,
    pointer: '.omo/plans/omo-herdr-dashboard-restart-recovery.md:235-244,437-438; scripts/qa-restart.mjs exports',
    reason: name === 'bootstrap'
      ? branch === 'positive' ? 'runBootstrap required native subcases did not return a result.'
        : 'runBootstrap has no wrong SDK/mode/manifest or source-drift injection branch.'
      : name === 'lease'
        ? 'runLease required native lease subcases did not return a result.'
        : `No public ${name} runner exists; bootstrap/lease/pane-collapse do not exercise its dashboard recovery or protection contract.`,
  }))),
  ...['normal-cli-restart', 'fatal-cli-restart', 'resume-reload', 'partial-repair',
    'package-handoff', 'busy-producer', 'unknown-producer', 'corrupt-slot', 'source-drift',
    'old-effects', 'old-ack', 'wrong-birth', 'foreign-child', 'unauthoritative-absence',
    'missing-frame', 'wrong-frame'].map(name => ({
    id: `final:${name}`, case: 'all',
    branch: ['normal-cli-restart', 'fatal-cli-restart', 'resume-reload', 'partial-repair',
      'package-handoff'].includes(name) ? 'positive' : 'rejection',
    pointer: '.omo/plans/omo-herdr-dashboard-restart-recovery.md:438; scripts/qa-restart.mjs exports',
    reason: `No public final-matrix ${name} injection/independent-CLI assertion exists; primitive receipts are not final dashboard evidence.`,
  })),
  { id: 'bootstrap:network-denial', case: 'bootstrap', branch: 'rejection',
    pointer: '.omo/plans/omo-herdr-dashboard-restart-recovery.md:294; scripts/qa-restart.mjs:runBootstrap',
    reason: 'runBootstrap network-denial subcase did not return a result.' },
  { id: 'pane-collapse:rejection', case: 'pane-collapse', branch: 'rejection',
    pointer: '.omo/plans/omo-herdr-dashboard-restart-recovery.md:296-299; scripts/qa-restart.mjs:runPaneCollapse',
    reason: 'runPaneCollapse controlled rejection did not return a result.' },
];

export function aggregateQaResults(subcases) {
  const cases = requiredQaClasses.map(required => {
    const observed = subcases[required.id];
    if (!observed) return { ...required, status: 'NOT_IMPLEMENTED' };
    assert.ok(['PASS', 'FAIL', 'NOT_IMPLEMENTED'].includes(observed.status), required.id);
    assert.ok(observed.pointer && observed.reason, 'Evidence pointer and reason required: ' + required.id);
    return { ...required, ...observed, id: required.id };
  });
  const ok = cases.every(entry => entry.status === 'PASS');
  return { ok, case: 'all', status: ok ? 'PASS' : 'FAIL', exitCode: ok ? 0 : 1, cases };
}

export async function runAll(options, runners = {
  bootstrap: runBootstrap, lease: runLease, 'pane-collapse': runPaneCollapse,
}) {
  const E = resolve(options.evidenceDir);
  assert.ok(pathKey(E).startsWith(pathKey(W) + EVIDENCE_PREFIX), 'Evidence must be inside this worktree');
  await mkdir(E, { recursive: true });
  const runs = {}, subcases = {};
  for (const name of ['bootstrap', 'lease', 'pane-collapse']) {
    const evidenceDir = join(E, name);
    await mkdir(evidenceDir, { recursive: true });
    try { runs[name] = await runners[name]({ ...options, case: name, evidenceDir }); }
    catch (error) { runs[name] = { ok: false, error: error.stack }; }
    await writeFile(join(evidenceDir, 'result.json'), JSON.stringify(runs[name], null, 2));
  }
  const record = (id, name, passed, pointer) => {
    subcases[id] = { status: runs[name].ok === true && passed ? 'PASS' : 'FAIL',
      pointer: `${name}/result.json${pointer}`,
      reason: runs[name].error ?? (runs[name].ok === true && passed
        ? 'Required actual subcase assertions passed, including runner cleanup/source checks.'
        : 'Runner failed or did not provide all required subcase assertions.') };
  };
  const bootstrap = runs.bootstrap.cases ?? [];
  record('bootstrap:positive', 'bootstrap',
    ['bootstrap', 'real-todo-append', 'orphan-graceful-q', 'identity-bound-child-kill', 'rerun-original-pane']
      .every(name => bootstrap.some(entry => entry.name === name && entry.ok === true)), '#/cases');
  record('bootstrap:network-denial', 'bootstrap',
    bootstrap.some(entry => entry.name === 'native-fetch-denied-before-connection' && entry.ok === true), '#/cases');
  const lease = runs.lease.result?.cases ?? {};
  for (const [branch, names] of [
    ['positive', ['exclusive-contention', 'graceful-handoff', 'fatal-release-handoff']],
    ['rejection', ['os-identity-mismatch', 'no-blind-pid-kill', 'crash-before-claim',
      'corrupt-fixture', 'no-delete-takeover', 'handle-acquisition-substitution']],
  ]) record(`lease:${branch}`, 'lease', runs.lease.rawRun?.exitCode === 0 &&
    names.every(name => lease[name] === true), '#/result/cases');
  record('pane-collapse:rejection', 'pane-collapse',
    runs['pane-collapse'].negative?.preservationRejected === true &&
    runs['pane-collapse'].negative?.recreatedPanesCountedAsPreservation === false, '#/negative');
  const result = { ...aggregateQaResults(subcases), runs };
  await writeFile(join(E, 'case-matrix.json'), JSON.stringify({
    case: result.case, ok: result.ok, status: result.status, exitCode: result.exitCode, cases: result.cases,
  }, null, 2));
  await writeFile(join(E, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && pathKey(process.argv[1]) === pathKey(fileURLToPath(import.meta.url))) {
  try {
    const options = parseQaArgs(process.argv.slice(2));
    const result = await (options.case === 'all' ? runAll(options) : options.case === 'lease' ? runLease(options) :
      options.case === 'pane-collapse' ? runPaneCollapse(options) : runBootstrap(options));
    if (options.case === 'bootstrap') console.log('RESTART_RESULT ' + JSON.stringify(result));
    else {
      // Evidence is materialized by the caller with apply_patch, not shell writes.
      const packet = deflateSync(Buffer.from(JSON.stringify(result))).toString('base64');
      for (let index = 0; index < packet.length; index += 80) console.log('RESTART_DATA ' + packet.slice(index, index + 80));
      console.log('RESTART_PACKET_END');
    }
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(error); process.exitCode = 1; }
}
