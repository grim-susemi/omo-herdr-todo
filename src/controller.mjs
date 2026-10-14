import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { displayOwnerKey, installDisplayBridge } from './display-bridge.mjs';
import { createPresence } from './presence.mjs';
import { createSnapshotStorage, sameSnapshotScope } from './storage.mjs';
import { claimParentSlot, parentSlotPaths, validParentSlot } from './parent-slot.mjs';

const execute = promisify(execFile);
export const dashboardChannels = Object.freeze({
  query: 'omo.herdr.dashboard.query', reply: 'omo.herdr.dashboard.reply',
  provider: 'omo.herdr.dashboard.provider', retired: 'omo.herdr.dashboard.retired',
});
export const sameDashboardOwner = (a, b) => a && b &&
  ['socketPath', 'parentPaneId', 'sessionId', 'ownerKey'].every(key => a[key] === b[key]);
const lifecycles = globalThis[Symbol.for('omo.herdr.dashboard.lifecycle/2')] ??= new Map();
export function registerManagedDashboard(pi, { stateDir, environment = process.env, createController }) {
  const root = resolve(stateDir);
  const key = JSON.stringify([process.platform === 'win32' ? root.replaceAll('\\', '/').toLowerCase() : root,
    environment.HERDR_SOCKET_PATH, environment.HERDR_PANE_ID]);
  const retained = lifecycles.get(key);
  if (retained) {
    retained.configure(pi, createController);
    retained.announce();
    return retained;
  }
  let controller, revision = 0, tail = Promise.resolve();
  const starts = new WeakMap();
  const binding = { socketPath: environment.HERDR_SOCKET_PATH, parentPaneId: environment.HERDR_PANE_ID };
  const service = {
    stateDir, binding,
    configure(nextPi, nextFactory) {
      this.offAvailability?.();
      pi = nextPi; createController = nextFactory;
      this.offAvailability = pi.events?.on(dashboardChannels.query, event => {
        if (event?.v === 2 && event.kind === 'managed-availability' &&
          event.socketPath === binding.socketPath && event.parentPaneId === binding.parentPaneId) announce(event.requestId);
      });
    },
    announce: requestId => announce(requestId),
    get controller() { return controller; },
    start(event, ctx) {
      const previous = starts.get(event);
      if (previous) return previous;
      const current = ++revision, old = controller;
      controller = undefined;
      // stop() invalidates synchronously, even while the old start is pending.
      const drained = old?.stop();
      const result = tail.then(async () => {
        await drained;
        if (current !== revision) return;
        const next = createController(ctx);
        controller = next;
        try {
          await next.start();
          if (current !== revision || controller !== next) { await next.stop(); return; }
          next.bind(pi);
          void next.schedule().catch(() => {});
          return next;
        } catch (error) {
          if (controller === next) controller = undefined;
          await next.stop();
          ctx.ui.notify(error.message, 'warning');
        }
      });
      starts.set(event, result);
      tail = result.catch(() => {});
      return result;
    },
    stop() {
      revision++;
      const old = controller;
      controller = undefined;
      const drained = old?.stop();
      const result = tail.then(() => drained);
      tail = result.catch(() => {});
      return result;
    },
  };
  const announce = requestId => pi.events?.emit(dashboardChannels.provider, {
    v: 2, kind: 'managed-availability', ...binding, stateDir, service, requestId,
  });
  service.configure(pi, createController);
  lifecycles.set(key, service);
  announce();
  return service;
}
const roles = new Set(['todo', 'dag', 'workers']);
const send = (socket, message) => socket.write(`${JSON.stringify(message)}\n`);
const pathKey = path => process.platform === 'win32' ? String(path).replaceAll('\\', '/').toLowerCase() : String(path);
export const authoritativePaneNotFound = error => error?.code === 'pane_not_found';
export async function discoverLegacyRecords(root, binding) {
  const directory = await realpath(resolve(root)), paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.pane.json')) paths.push(join(directory, entry.name));
    if (entry.isDirectory()) for (const file of await readdir(join(directory, entry.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.pane.json')) paths.push(join(directory, entry.name, file.name));
    }
  }
  const records = [];
  for (const path of paths.sort()) {
    const actual = await realpath(path);
    if (!pathKey(actual).startsWith(pathKey(directory) + '/')) throw blocked('legacy locator leaves configured root');
    const record = await readJson(actual);
    if (record?.parentPaneId === binding.parentPaneId && pathKey(record.socketPath) === pathKey(binding.socketPath))
      records.push({ path, record });
  }
  return records;
}
const controlKeys = ['token', 'ownerKey', 'sessionId', 'scopeEpoch', 'role', 'launchToken', 'paneId', 'statePath'];
const sameControl = (a, b) => a?.v === 1 && b?.v === 1 && controlKeys.every(key => a[key] === b[key]);

function receive(socket, callback) {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 65536) return socket.destroy();
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
      try { callback(JSON.parse(line)); } catch { socket.destroy(); }
    }
  });
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
export async function readRoleState(path) {
  const state = await readJson(path);
  if (state === null) return null;
  if (state.schema !== 'omo-herdr-dashboard/role/1' || !roles.has(state.role) ||
    !['socketPath', 'parentPaneId', 'tabId', 'sessionId', 'ownerKey'].every(key =>
      typeof state[key] === 'string' && state[key]) ||
    state.ownerKey !== displayOwnerKey(state.socketPath, state.parentPaneId, state.sessionId) ||
    !Number.isSafeInteger(state.scopeEpoch) || state.scopeEpoch < 1 ||
    typeof state.launchToken !== 'string' || !state.launchToken ||
    typeof state.paneId !== 'string' || !state.paneId) throw new TypeError('Invalid managed role state');
  return state;
}
function requestControl(type, { state, paneId, launchToken, pid = process.pid }) {
  const offer = state?.controlOffer;
  if (!offer?.pipePath?.startsWith('\\\\.\\pipe\\') || state.paneId !== paneId ||
    state.launchToken !== launchToken || offer.paneId !== paneId ||
    offer.launchToken !== launchToken || !sameSnapshotScope(offer, state) ||
    offer.role !== state.role) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(offer.pipePath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Role control response timed out')); }, 10000);
    socket.once('connect', () => send(socket, { ...offer, type, pid }));
    receive(socket, message => {
      const accepted = sameControl(message, offer) && message.type === (type === 'register' ? 'registered' : 'closed');
      clearTimeout(timer); socket.end(); resolve(accepted);
    });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('close', () => { clearTimeout(timer); resolve(false); });
  });
}
export const registerRoleViewer = options => requestControl('register', options);
export const requestRoleClose = options => requestControl('close', options);

export const viewerRetirementPipe = launchToken =>
  `\\\\.\\pipe\\omo-herdr-viewer-retirement-${createHash('sha256').update(launchToken).digest('hex')}`;

export async function retireVerifiedViewer(record, identity) {
  if (process.platform !== 'win32' || !identity?.viewer ||
    identity.viewer.pid !== record.processId || identity.viewer.birth !== record.viewerBirth)
    throw blocked('viewer retirement requires exact original native identity');
  const expected = identity.viewer, nonce = randomUUID();
  const request = { type: 'retire', nonce, role: record.role, sessionId: record.sessionId,
    ownerKey: record.ownerKey, scopeEpoch: record.scopeEpoch, paneId: record.paneId,
    statePath: record.statePath, launchToken: record.launchToken };
  const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
  const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class RetirePeer {
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr h,out uint id);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h,out long born,out long exited,out long kernel,out long user);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder b,ref uint n);}'
$pipe=[IO.Pipes.NamedPipeClientStream]::new('.',${literal(viewerRetirementPipe(record.launchToken).slice(9))},[IO.Pipes.PipeDirection]::InOut)
$p=$null
try {
$pipe.Connect(5000);[uint32]$peer=0
if(![RetirePeer]::GetNamedPipeServerProcessId($pipe.SafePipeHandle.DangerousGetHandle(),[ref]$peer) -or $peer -ne ${expected.pid}){throw 'retirement peer changed'}
$p=[Diagnostics.Process]::GetProcessById($peer);$handle=$p.Handle
[long]$born=0;[long]$exited=0;[long]$kernel=0;[long]$user=0
if(![RetirePeer]::GetProcessTimes($handle,[ref]$born,[ref]$exited,[ref]$kernel,[ref]$user) -or $born.ToString() -cne ${literal(expected.birth)}){throw 'retirement birth changed'}
$image=[Text.StringBuilder]::new(32768);[uint32]$size=32768
if(![RetirePeer]::QueryFullProcessImageName($handle,0,$image,[ref]$size) -or $image.ToString() -ine ${literal(expected.executable)}){throw 'retirement image changed'}
$row=Get-CimInstance Win32_Process -Filter "ProcessId=$peer"
$hash=[Security.Cryptography.SHA256]::Create()
try{$digest=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($row.CommandLine)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
if($row.ParentProcessId -ne ${identity.shell.pid} -or $digest -cne ${literal(expected.argvDigest)}){throw 'retirement argv or parent changed'}
$writer=[IO.StreamWriter]::new($pipe,[Text.UTF8Encoding]::new($false),4096,$true);$writer.AutoFlush=$true
$reader=[IO.StreamReader]::new($pipe,[Text.UTF8Encoding]::new($false),$false,4096,$true)
$writer.WriteLine(${literal(JSON.stringify(request))})
$line=$reader.ReadLineAsync();if(!$line.Wait(10000) -or !$line.Result){throw 'retirement acknowledgement unavailable'}
$reply=ConvertFrom-Json $line.Result
if($reply.type -cne 'retiring' -or $reply.nonce -cne ${literal(nonce)} -or $reply.launchToken -cne ${literal(record.launchToken)}){throw 'retirement acknowledgement changed'}
if(!$p.WaitForExit(15000)){throw 'original viewer exit unavailable'}
[Console]::WriteLine((ConvertTo-Json -InputObject @{pid=[int]$peer;birth=$born.ToString();exitCode=$p.ExitCode;manual=[bool]$reply.manual;nonce=$reply.nonce;custodyClosure=$reply.custodyClosure} -Compress -Depth 8))
}finally{if($p){$p.Dispose()};$pipe.Dispose()}`;
  const { stdout, stderr } = await execute('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 35000, maxBuffer: 65536 });
  const receipt = JSON.parse(stdout);
  if (receipt.pid !== expected.pid || receipt.birth !== expected.birth ||
    receipt.nonce !== nonce || !Number.isInteger(receipt.exitCode))
    throw blocked('original viewer retirement receipt changed');
  return { ...receipt, stdout, stderr };
}

export async function createViewerRetirementServer(options, getState, retire, beforeRetire) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    receive(socket, message => {
      const state = getState();
      if (message?.type !== 'retire' || typeof message.nonce !== 'string' || !message.nonce ||
        message.statePath !== options.statePath || message.launchToken !== options.launchToken ||
        message.paneId !== options.paneId || !state ||
        !['role', 'sessionId', 'ownerKey', 'scopeEpoch', 'paneId', 'launchToken']
          .every(key => message[key] === state[key])) return socket.destroy();
      void (async () => {
        const custodyClosure = await beforeRetire?.();
        if (getState() !== state) return socket.destroy();
        socket.end(`${JSON.stringify({ type: 'retiring', nonce: message.nonce,
          launchToken: options.launchToken, manual: false, custodyClosure })}\n`, () => { void retire(); });
      })().catch(() => socket.destroy());
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.once('listening', resolve);
    server.listen(viewerRetirementPipe(options.launchToken));
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  };
}

export function createDashboardHerdr(environment = process.env) {
  return async (...args) => {
    let stdout;
    try {
      ({ stdout } = await execute(environment.HERDR_BIN_PATH || (process.platform === 'win32' ? 'herdr.exe' : 'herdr'),
        ['pane', ...args], { env: environment, timeout: 10000, maxBuffer: 2 * 1024 * 1024 }));
    } catch (error) {
      // Only the structured native RPC code is absence authority.
      let reply;
      try { reply = JSON.parse(error.stdout || error.stderr); } catch { throw error; }
      if (!reply.error) throw error;
      throw Object.assign(new Error(reply.error.message, { cause: error }), { code: reply.error.code });
    }
    if (!stdout.trim()) return {};
    const reply = JSON.parse(stdout);
    if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  };
}
export async function resolveDashboardNode(environment = process.env) {
  const candidates = environment.OMO_HERDR_TODO_NODE ? [environment.OMO_HERDR_TODO_NODE] :
    [...(/^node(?:js)?(?:\.exe)?$/i.test(basename(process.execPath)) ? [process.execPath] : []), 'node'];
  for (const candidate of new Set(candidates)) {
    try {
      const { stdout } = await execute(candidate, ['--eval',
        'console.log(JSON.stringify({version:process.versions.node,bun:!!process.versions.bun,path:process.execPath}))'],
      { env: environment, timeout: 5000, maxBuffer: 16384 });
      const result = JSON.parse(stdout.trim());
      if (!result.bun && Number(result.version?.split('.')[0]) >= 24 && isAbsolute(result.path)) return result.path;
    } catch { /* Probe the next declared interpreter. */ }
  }
  throw new Error('Todo pane requires a Node >= 24 interpreter');
}
function shellCommand(args) {
  return process.platform === 'win32'
    ? `& ${args.map(value => `'${String(value).replaceAll("'", "''")}'`).join(' ')}`
    : args.map(value => `'${String(value).replaceAll("'", "'\\''")}'`).join(' ');
}
export function viewerProcess(info, record, expectedPid) {
  const matches = (info?.process_info?.foreground_processes ?? []).filter(process => {
    const argv = process.argv ?? [];
    return argv.length === 8 && pathKey(argv[0]) === pathKey(record.nodePath) && pathKey(argv[1]) === pathKey(record.viewerPath) &&
      argv[2] === '--state' && pathKey(argv[3]) === pathKey(record.statePath) &&
      argv[4] === '--close-pane' && argv[5] === record.paneId &&
      argv[6] === '--launch-token' && argv[7] === record.launchToken &&
      (expectedPid === undefined || process.pid === expectedPid) &&
      (record.processId === undefined || process.pid === record.processId);
  });
  return matches.length === 1 ? matches[0] : null;
}
export function parseLaunchCommand(command) {
  if (typeof command !== 'string') return null;
  const argv = [];
  let at = 0;
  while (at < command.length) {
    while (/[ \t]/.test(command[at] ?? '') && at < command.length) at++;
    if (at === command.length) break;
    let value;
    if (command[at] === '"') {
      const end = command.indexOf('"', at + 1);
      if (end < 0 || command[end - 1] === '\\') return null;
      value = command.slice(at + 1, end); at = end + 1;
      if (at < command.length && !/[ \t]/.test(command[at])) return null;
    } else {
      const start = at;
      while (at < command.length && !/[ \t]/.test(command[at])) at++;
      value = command.slice(start, at);
      if (/["\r\n]/.test(value)) return null;
    }
    if (!value || /[\r\n]/.test(value)) return null;
    argv.push(value);
  }
  return argv;
}
async function nativeShellProcesses(pid) {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop'; $rows = @(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid} OR ParentProcessId = ${pid}" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},@{Name='Birth';Expression={$h=[Diagnostics.Process]::GetProcessById($_.ProcessId);try{$null=$h.Handle;$h.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}finally{$h.Dispose()}}}); ConvertTo-Json -InputObject $rows -Compress`],
  { timeout: 5000, maxBuffer: 65536 });
  return JSON.parse(stdout);
}
const blocked = cause => Object.assign(new Error(`BLOCKED: ${cause?.message ?? cause}`), { inlineFallback: true, cause });
const nativeIdentity = row => {
  if (!Number.isSafeInteger(row?.ProcessId) || !row.Birth || !row.ExecutablePath || !row.CommandLine) throw blocked('native identity unavailable');
  return { pid: row.ProcessId, birth: row.Birth, executable: row.ExecutablePath,
    argvDigest: createHash('sha256').update(row.CommandLine).digest('hex') };
};
const retirementCaptures = new WeakMap();
export async function captureLegacyProducer({ stateDir, recordPath, parent, herdr, slotPath, slotStateDir = stateDir,
  custody = false }) {
  const root = pathKey(await realpath(resolve(stateDir))), path = await realpath(recordPath);
  if (!pathKey(path).startsWith(root + '/')) throw blocked('legacy record outside configured root');
  const recordBytes = await readFile(path), record = JSON.parse(recordBytes);
  const statePath = await realpath(record.statePath);
  if (!pathKey(statePath).startsWith(root + '/')) throw blocked('legacy state outside configured root');
  const stateBytes = await readFile(statePath), state = JSON.parse(stateBytes), offer = state.controlOffer;
  if (record.parentPaneId !== parent.paneId || record.tabId !== parent.tabId ||
    !sameDashboardOwner(record, state) || record.role !== state.role || record.paneId !== state.paneId ||
    record.launchToken !== state.launchToken || !sameControl(offer, { ...offer, ...state, statePath: record.statePath }) ||
    !offer?.pipePath?.startsWith('\\\\.\\pipe\\')) throw blocked('legacy control binding unavailable');
  const members = (await herdr('list')).panes, parents = members?.filter(pane => pane.pane_id === parent.paneId);
  if (parents?.length !== 1 || parents[0].tab_id !== parent.tabId) throw blocked('legacy parent membership changed');
  const info = await herdr('process-info', '--pane', parent.paneId);
  if (info.process_info?.shell_pid !== parent.shell.pid) throw blocked('legacy parent shell changed');
  const parentRow = (await nativeShellProcesses(parent.shell.pid)).find(row => row.ProcessId === parent.shell.pid);
  if (nativeIdentity(parentRow).birth !== parent.shell.birth) throw blocked('legacy parent birth changed');
  const roleIdentity = await legacyPaneIdentity(await herdr('process-info', '--pane', record.paneId), record);
  if (!roleIdentity?.viewer) throw blocked('legacy native viewer unavailable');
  const nonce = randomUUID(), request = { ...offer, type: 'observe-retirement', nonce,
    ...(custody ? { custody: true } : {}) };
  const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class LegacyPeer {
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr h,out uint id);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder b,ref uint n);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h,out long born,out long exited,out long kernel,out long user);}'
$pipe=[IO.Pipes.NamedPipeClientStream]::new('.','${offer.pipePath.slice(9).replaceAll("'", "''")}',[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous)
$p=$null;$processWait=$null;$idle=$null;$inputReader=$null
try {
$pipe.Connect(5000);[uint32]$peer=0
if(![LegacyPeer]::GetNamedPipeServerProcessId($pipe.SafePipeHandle.DangerousGetHandle(),[ref]$peer)){throw 'native pipe peer unavailable'}
$p=[Diagnostics.Process]::GetProcessById($peer);$handle=$p.Handle
[long]$born=0;[long]$exited=0;[long]$kernel=0;[long]$user=0
if(![LegacyPeer]::GetProcessTimes($handle,[ref]$born,[ref]$exited,[ref]$kernel,[ref]$user)){throw 'native birth unavailable'}
$image=[Text.StringBuilder]::new(32768);[uint32]$size=32768
if(![LegacyPeer]::QueryFullProcessImageName($handle,0,$image,[ref]$size)){throw 'native image unavailable'}
$row=Get-CimInstance Win32_Process -Filter "ProcessId=$peer"
if(!$row.CommandLine -or $p.StartTime.ToUniversalTime().ToFileTimeUtc() -ne $born){throw 'native argv or birth changed'}
$writer=[IO.StreamWriter]::new($pipe,[Text.UTF8Encoding]::new($false),4096,$true);$writer.AutoFlush=$true
$reader=[IO.StreamReader]::new($pipe,[Text.UTF8Encoding]::new($false),$false,4096,$true)
$writer.WriteLine('${JSON.stringify(request).replaceAll("'", "''")}')
$custodyMode=${custody ? '$true' : '$false'}
if($custodyMode){
$welcome=$reader.ReadLineAsync();if(!$welcome.Wait(15000) -or !$welcome.Result){throw 'live custody binding unavailable'}
[Console]::WriteLine('OBSERVING '+$welcome.Result)
}
$identity=@{ProcessId=[int]$peer;Birth=$born.ToString();ExecutablePath=$image.ToString();CommandLine=$row.CommandLine;ParentProcessId=[int]$row.ParentProcessId;Handle=$handle.ToInt64().ToString()}
[Console]::WriteLine('ARMED '+(ConvertTo-Json -InputObject $identity -Compress))
if($custodyMode){
$custodyInvalid=$false;$producerDead=$false;$disposing=$false
$processWait=[Threading.ManualResetEvent]::new($false)
$processWait.SafeWaitHandle=[Microsoft.Win32.SafeHandles.SafeWaitHandle]::new($handle,$false)
$idle=[Threading.ManualResetEvent]::new($false)
$inputReader=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false),$false,4096,$true)
$pipeRead=$reader.ReadLineAsync();$inputRead=$inputReader.ReadLineAsync()
while($true){
$pipeHandle=if($pipeRead){([IAsyncResult]$pipeRead).AsyncWaitHandle}else{$idle}
$deathHandle=if($producerDead){$idle}else{$processWait}
$inputHandle=if($disposing){$idle}else{([IAsyncResult]$inputRead).AsyncWaitHandle}
$handles=[Threading.WaitHandle[]]@($pipeHandle,$inputHandle,$deathHandle)
$deadline=if(!$pipeRead -and !$producerDead -and !$custodyInvalid){15000}else{-1}
$selected=[Threading.WaitHandle]::WaitAny($handles,$deadline)
if($selected -eq 258){$custodyInvalid=$true;continue}
if($selected -eq 2){
$producerDead=$true
[Console]::WriteLine('CUSTODY_PRODUCER_DEAD '+(ConvertTo-Json -InputObject @{helperPid=$PID;producerPid=[int]$peer;producerBirth=$born.ToString();nonce='${nonce}';exitCode=$p.ExitCode;custodyInvalid=$custodyInvalid} -Compress))
continue
}
if($selected -eq 0){
$raw=$pipeRead.Result
if(!$raw){
[Console]::WriteLine('CUSTODY_PIPE_EOF '+(ConvertTo-Json -InputObject @{helperPid=$PID;producerPid=[int]$peer;nonce='${nonce}';disposing=$disposing;producerDead=$producerDead;custodyInvalid=$custodyInvalid;pipeConnected=$pipe.IsConnected;inputStatus=[string]$inputRead.Status} -Compress))
if($disposing){if(!$processWait.WaitOne(0)){throw 'unacknowledged custody disposal'};break}
if(!$processWait.WaitOne(0)){$custodyInvalid=$true}
$pipeRead=$null;continue
}
$packet=ConvertFrom-Json $raw
if($packet.type -eq 'custody-effect' -and $packet.nonce -ceq '${nonce}' -and $packet.token -ceq '${offer.token.replaceAll("'", "''")}'){
$custodyInvalid=$true
[Console]::WriteLine('EFFECT '+$raw)
$packet.type='custody-invalidated'
$writer.WriteLine((ConvertTo-Json -InputObject $packet -Compress -Depth 32))
}elseif($disposing -and $packet.type -eq 'custody-disposed' -and $packet.nonce -ceq '${nonce}' -and $packet.token -ceq '${offer.token.replaceAll("'", "''")}'){
break
}elseif($packet.type -ne 'observing' -and $packet.type -ne 'released'){$custodyInvalid=$true}
$pipeRead=$reader.ReadLineAsync();continue
}
$mode=$inputRead.Result
[Console]::WriteLine('CUSTODY_INPUT '+(ConvertTo-Json -InputObject @{helperPid=$PID;producerPid=[int]$peer;nonce='${nonce}';mode=$mode;disposing=$disposing;producerDead=$producerDead;custodyInvalid=$custodyInvalid;inputStatus=[string]$inputRead.Status} -Compress))
if($mode -eq 'custody-check'){
[Console]::WriteLine('CHECK '+(!$custodyInvalid).ToString().ToLowerInvariant())
}
elseif($mode -eq 'death'){if(!$p.WaitForExit(15000)){throw 'producer death deadline'};[Console]::WriteLine('DEAD '+$p.ExitCode)}
elseif($mode -eq 'dispose' -or $null -eq $mode){
$disposed=ConvertFrom-Json '${JSON.stringify(request).replaceAll("'", "''")}';$disposed.type='custody-disposed'
$custodyInvalid=$true;$disposing=$true
if($pipeRead -and $pipe.IsConnected){
[Console]::WriteLine('CUSTODY_DISPOSE_WRITE_ENTER '+(ConvertTo-Json -InputObject @{helperPid=$PID;producerPid=[int]$peer;nonce='${nonce}';disposing=$disposing;pipeConnected=$pipe.IsConnected} -Compress))
if([Environment]::GetEnvironmentVariable('OMO_RESTART_QA_DISPOSE_GATE') -ceq '1'){
$gate=[Threading.EventWaitHandle]::OpenExisting('Local\\omo-restart-qa-dispose-${nonce}')
$gateHandle=$gate.SafeWaitHandle
try{if(!$gate.WaitOne(3000)){throw 'owned disposal gate deadline'}}finally{
$gate.Dispose()
[Console]::WriteLine('CUSTODY_DISPOSE_GATE_CLOSED '+(ConvertTo-Json -InputObject @{helperPid=$PID;nonce='${nonce}';closed=$gateHandle.IsClosed} -Compress))
}
}
try{$writer.WriteLine((ConvertTo-Json -InputObject $disposed -Compress))}
catch [IO.IOException]{
$originalProducerDead=$processWait.WaitOne(0)
[Console]::WriteLine('DISPOSE_PIPE_ERROR '+(ConvertTo-Json -InputObject @{helperPid=$PID;producerPid=[int]$peer;producerBirth=$born.ToString();nonce='${nonce}';originalProducerDead=$originalProducerDead;at=[DateTime]::UtcNow.ToString('o');error=$_.Exception.Message} -Compress))
if(!$originalProducerDead){throw};break
}
}else{if(!$processWait.WaitOne(0)){throw 'unacknowledged custody disposal'};break}
}else{throw 'invalid custody observer action'}
if(!$disposing){$inputRead=$inputReader.ReadLineAsync()}
}
return
}
while($true){
$mode=[Console]::ReadLine()
if($mode -eq 'death'){if(!$p.WaitForExit(15000)){throw 'producer death deadline'};[Console]::WriteLine('DEAD '+$p.ExitCode)}
elseif($mode -eq 'release'){
do {$line=$reader.ReadLineAsync();if(!$line.Wait(15000)){throw 'producer release deadline'};$raw=$line.Result;if(!$raw){throw 'producer release unknown'};$message=ConvertFrom-Json $raw}while($message.type -eq 'observing')
[Console]::WriteLine('RELEASE '+$raw)
}elseif($mode -eq 'dispose' -or $null -eq $mode){break}else{throw 'invalid observer action'}
}
}finally{if($inputReader){$inputReader.Dispose()};if($processWait){$processWait.Dispose()};if($idle){$idle.Dispose()};if($p){$p.Dispose()};$pipe.Dispose()}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = new EventEmitter();
  let stdout = '', stderr = '', buffer = '', alive = true, captured, invalidated = false, disposing;
  const terminal = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      stdout += chunk; buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
        if (line.startsWith('EFFECT ')) { invalidated = true; if (captured) captured.invalid = true; }
        events.emit('line', line);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('close', (code, signal) => {
      alive = false;
      const receipt = { code, signal, stdout, stderr, stdoutEOF: child.stdout.readableEnded, stderrEOF: child.stderr.readableEnded };
      events.emit('closed', receipt); resolve(receipt);
    });
  });
  const line = prefix => new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(20000);
    const accept = value => { if (value.startsWith(prefix + ' ')) { clear(); resolve(value.slice(prefix.length + 1)); } };
    const close = value => { clear(); reject(blocked(`native capture ${value.code}: ${value.stderr}`)); };
    const abort = () => { clear(); reject(blocked('native capture deadline')); };
    const clear = () => { events.off('line', accept); events.off('closed', close); signal.removeEventListener('abort', abort); };
    events.on('line', accept); events.once('closed', close); signal.addEventListener('abort', abort, { once: true });
  });
  const observation = { dispose() {
    if (!disposing) {
      if (alive) child.stdin.end('dispose\n');
      disposing = terminal.then(receipt => ({ ...receipt, pid: child.pid, holder: captured?.holder }));
    }
    return disposing;
  } };
  try {
    const row = JSON.parse(await line('ARMED')), identity = nativeIdentity(row);
    let ancestor = row.ParentProcessId;
    for (let depth = 0; depth < 5 && ancestor !== parent.shell.pid; depth++) {
      const next = (await nativeShellProcesses(ancestor)).find(row => row.ProcessId === ancestor);
      if (!next || next.ParentProcessId === ancestor) throw blocked('legacy producer ancestry unavailable');
      ancestor = next.ParentProcessId;
    }
    if (ancestor !== parent.shell.pid) throw blocked('legacy producer outside exact parent');
    let initialSlot, leaseRoot;
    if (slotPath) {
      leaseRoot = pathKey(await realpath(resolve(slotStateDir)));
      const pipe = record.socketPath.replaceAll('/', '\\');
      const socket = /^\\\\[.]\\pipe\\/i.test(pipe) ? pathKey(pipe) : pathKey(await realpath(resolve(record.socketPath)));
      const key = createHash('sha256').update(JSON.stringify([socket, parent.paneId])).digest('hex');
      if (pathKey(await realpath(slotPath)) !== pathKey(join(leaseRoot, 'parent-slots', key, 'slot.json')))
        throw blocked('legacy effect journal locator mismatch');
      initialSlot = await readJson(slotPath);
      if (!validParentSlot(initialSlot) || initialSlot.canonicalStateDir !== leaseRoot ||
        initialSlot.canonicalSocketPath !== socket || JSON.stringify(initialSlot.parent) !== JSON.stringify(parent) ||
        JSON.stringify(initialSlot.producer) !== JSON.stringify(identity))
        throw blocked('legacy effect journal producer mismatch');
      const role = initialSlot.roles[record.role];
      if (!role || role.paneId !== record.paneId || role.statePath !== record.statePath ||
        role.sessionId !== record.sessionId || role.launchToken !== record.launchToken || role.controlToken !== offer.token ||
        role.shell.pid !== roleIdentity.shell.pid || role.shell.birth !== roleIdentity.shell.birth ||
        JSON.stringify(role.viewer) !== JSON.stringify(roleIdentity.viewer)) initialSlot = null;
    }
    if (!/^[1-9][0-9]*$/.test(row.Handle)) throw blocked('original native handle unavailable');
    const holderRow = (await nativeShellProcesses(child.pid)).find(row => row.ProcessId === child.pid);
    if (holderRow?.ParentProcessId !== process.pid) throw blocked('original native holder parent changed');
    if (custody) {
      const raw = stdout.split(/\r?\n/).find(value => value.startsWith('OBSERVING '));
      const witnessed = raw && JSON.parse(raw.slice('OBSERVING '.length));
      if (!sameControl(witnessed, offer) || witnessed.type !== 'observing' || witnessed.nonce !== nonce ||
        !initialSlot || JSON.stringify(witnessed.slot) !== JSON.stringify(initialSlot) ||
        initialSlot.operations.some(operation => operation.status !== 'SETTLED'))
        throw blocked('live original custody journal binding changed');
    }
    captured = { root, path, statePath, recordBytes, stateBytes, parent: structuredClone(parent), herdr, roleIdentity,
      identity, slotPath, initialSlot, leaseRoot, nonce, offer, alive: () => alive, released: null, death: null, child, terminal,
      nativeHandle: row.Handle, holder: nativeIdentity(holderRow), invalid: invalidated };
    observation.recordPath = path;
    observation.identity = structuredClone(identity);
    // Diagnostic copies cannot construct or transfer the private observation.
    observation.bindings = structuredClone({ root, path, statePath, parent, roleIdentity, state, initialSlot });
    if (custody) observation.custodyValid = async () => {
      if (!alive || captured.invalid) return false;
      const received = line('CHECK'); child.stdin.write('custody-check\n');
      return await received === 'true';
    };
    observation.death = async () => {
      const received = line('DEAD');
      child.stdin.write('death\n');
      captured.death = { identity, exitCode: Number(await received) };
      if (!Number.isInteger(captured.death.exitCode)) throw blocked('native numeric exit unavailable');
      return structuredClone(captured.death);
    };
    observation.release = async () => {
      const received = line('RELEASE');
      child.stdin.write('release\n');
      const receipt = JSON.parse(await received);
      if (receipt.type !== 'released' || receipt.nonce !== nonce || !sameControl(receipt, offer) ||
        !validParentSlot(receipt.slot) || receipt.slot.phase !== 'RELEASED' ||
        JSON.stringify(receipt.slot.producer) !== JSON.stringify(identity) ||
        receipt.recordSHA256 !== createHash('sha256').update(recordBytes).digest('hex'))
        throw blocked('producer release binding mismatch');
      captured.released = receipt;
      return receipt;
    };
    retirementCaptures.set(observation, captured);
    return observation;
  } catch (error) { await observation.dispose(); throw error; }
}
export async function observeLegacyRetirement(observation, { stateDir, recordPath, parent }) {
  const captured = retirementCaptures.get(observation);
  if (!captured?.alive() || captured.invalid) return null;
  const invalid = () => { captured.invalid = true; return null; };
  if (pathKey(await realpath(stateDir)) !== captured.root ||
    pathKey(await realpath(recordPath)) !== pathKey(captured.path) ||
    JSON.stringify(parent) !== JSON.stringify(captured.parent) ||
    !Buffer.from(await readFile(captured.path)).equals(captured.recordBytes)) return invalid();
  const record = JSON.parse(captured.recordBytes);
  const members = (await captured.herdr('list')).panes?.filter(pane => pane.pane_id === parent.paneId);
  if (members?.length !== 1 || members[0].tab_id !== parent.tabId) return invalid();
  const parentInfo = await captured.herdr('process-info', '--pane', parent.paneId);
  if (parentInfo.process_info?.shell_pid !== parent.shell.pid) return invalid();
  const parentRow = (await nativeShellProcesses(parent.shell.pid)).find(row => row.ProcessId === parent.shell.pid);
  if (nativeIdentity(parentRow).birth !== parent.shell.birth) return invalid();
  const role = await legacyPaneIdentity(await captured.herdr('process-info', '--pane', record.paneId), record);
  if (JSON.stringify(role) !== JSON.stringify(captured.roleIdentity)) return invalid();
  if (captured.released) {
    const bytes = await readFile(captured.statePath);
    if (createHash('sha256').update(bytes).digest('hex') !== captured.released.stateSHA256) return invalid();
    return { identity: structuredClone(captured.identity), state: 'released', effects: 'settled' };
  }
  if (!captured.death || !captured.initialSlot) return null;
  const beforeState = JSON.parse(captured.stateBytes), afterState = JSON.parse(await readFile(captured.statePath));
  delete beforeState.updatedAt; delete afterState.updatedAt;
  if (JSON.stringify(afterState) !== JSON.stringify(beforeState)) return invalid();
  const slot = await readJson(captured.slotPath);
  if (!validParentSlot(slot) || JSON.stringify(slot.producer) !== JSON.stringify(captured.identity) ||
    JSON.stringify(slot.parent) !== JSON.stringify(parent) || slot.canonicalStateDir !== captured.leaseRoot ||
    slot.canonicalSocketPath !== captured.initialSlot.canonicalSocketPath ||
    slot.ownerNonce !== captured.initialSlot.ownerNonce || slot.generation !== captured.initialSlot.generation ||
    slot.revision < captured.initialSlot.revision ||
    JSON.stringify(slot.locatorOwners.slice(0, captured.initialSlot.locatorOwners.length)) !== JSON.stringify(captured.initialSlot.locatorOwners) ||
    captured.initialSlot.operations.some((op, index) =>
      JSON.stringify({ ...op, status: 'SETTLED' }) !== JSON.stringify(slot.operations[index])) ||
    slot.operations.some(op => op.status !== 'SETTLED')) return null;
  return { identity: structuredClone(captured.identity), state: 'dead', effects: 'settled',
    exitCode: captured.death.exitCode };
}
const custodyPipe = launchToken =>
  `\\\\.\\pipe\\omo-herdr-producer-custody-${createHash('sha256').update(launchToken).digest('hex')}`;

export async function createProducerCustodyServer(options, getObservation) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    receive(socket, message => {
      void (async () => {
        if (!['custody', 'custody-check'].includes(message?.type) || typeof message.nonce !== 'string' || !message.nonce ||
          message.launchToken !== options.launchToken || message.paneId !== options.paneId ||
          message.statePath !== options.statePath) throw blocked('custody request binding changed');
        const captured = retirementCaptures.get(getObservation());
        if (!captured?.alive() || captured.invalid || !captured.initialSlot ||
          !await getObservation().custodyValid?.() || captured.initialSlot.operations.some(op => op.status !== 'SETTLED'))
          throw blocked('original custody or settled effects unavailable');
        const slot = await readJson(captured.slotPath);
        if (!validParentSlot(slot) || slot.operations.some(op => op.status !== 'SETTLED') ||
          slot.ownerNonce !== captured.initialSlot.ownerNonce || slot.generation !== captured.initialSlot.generation ||
          JSON.stringify(slot.producer) !== JSON.stringify(captured.identity) ||
          ['parent', 'roles', 'operations', 'closures', 'locatorOwners'].some(key =>
            JSON.stringify(slot[key]) !== JSON.stringify(captured.initialSlot[key])))
          throw blocked('effects changed after original custody capture');
        if (!Buffer.from(await readFile(captured.path)).equals(captured.recordBytes))
          throw blocked('custodian role record changed');
        const state = JSON.parse(await readFile(captured.statePath)), original = JSON.parse(captured.stateBytes);
        delete state.updatedAt; delete original.updatedAt;
        if (JSON.stringify(state) !== JSON.stringify(original)) throw blocked('custodian role state changed');
        const rows = await nativeShellProcesses(captured.child.pid);
        const holder = rows.find(row => row.ProcessId === captured.child.pid);
        if (holder?.ParentProcessId !== process.pid || JSON.stringify(nativeIdentity(holder)) !== JSON.stringify(captured.holder))
          throw blocked('original custodian holder changed');
        if (message.type === 'custody-check') {
          if (message.nativeHandle !== captured.nativeHandle ||
            JSON.stringify(message.holder) !== JSON.stringify(captured.holder))
            throw blocked('original custody holder changed after transfer');
          send(socket, { type: 'custody-valid', nonce: message.nonce, launchToken: options.launchToken });
          return;
        }
        socket.write(`${JSON.stringify({ type: 'custody', nonce: message.nonce, launchToken: options.launchToken,
          identity: captured.identity, parent: captured.parent, initialSlot: captured.initialSlot,
          recordBase64: captured.recordBytes.toString('base64'), stateBase64: captured.stateBytes.toString('base64'),
          root: captured.root, path: captured.path, statePath: captured.statePath, roleIdentity: captured.roleIdentity,
          slotPath: captured.slotPath, leaseRoot: captured.leaseRoot,
          holder: captured.holder, nativeHandle: captured.nativeHandle })}\n`);
      })().catch(() => socket.destroy());
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.once('listening', resolve);
    server.listen(custodyPipe(options.launchToken));
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  };
}

export async function captureCustodiedProducer({ stateDir, recordPath, parent, herdr, slotPath, previous }) {
  const root = pathKey(await realpath(resolve(stateDir))), path = await realpath(recordPath);
  if (!pathKey(path).startsWith(root + '/')) throw blocked('custodian locator leaves configured root');
  const recordBytes = await readFile(path), record = JSON.parse(recordBytes);
  const statePath = await realpath(record.statePath), stateBytes = await readFile(statePath);
  if (!pathKey(statePath).startsWith(root + '/') || !validParentSlot(previous) ||
    JSON.stringify(previous.parent) !== JSON.stringify(parent)) throw blocked('custodian parent or state root changed');
  const roleIdentity = await legacyPaneIdentity(await herdr('process-info', '--pane', record.paneId), record);
  const role = previous.roles.todo;
  if (!roleIdentity?.viewer || record.role !== 'todo' || record.manualClose ||
    role?.paneId !== record.paneId || role.statePath !== record.statePath || role.launchToken !== record.launchToken ||
    role.shell.pid !== roleIdentity.shell.pid || role.shell.birth !== roleIdentity.shell.birth ||
    JSON.stringify(role.viewer) !== JSON.stringify(roleIdentity.viewer))
    throw blocked('surviving original custodian native identity unavailable');
  const nonce = randomUUID(), literal = value => "'" + String(value).replaceAll("'", "''") + "'";
  const request = { type: 'custody', nonce, launchToken: record.launchToken,
    paneId: record.paneId, statePath: record.statePath };
  const viewer = roleIdentity.viewer, producer = previous.producer;
  const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class CustodyPeer {
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr h,out uint id);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h,out long born,out long exited,out long kernel,out long user);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder b,ref uint n);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr duplicate,uint access,bool inherit,uint options);
[DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
[DllImport("kernel32.dll",SetLastError=true)] public static extern uint GetProcessId(IntPtr h);
[DllImport("kernel32.dll",SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h,uint ms);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr h,out uint code);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr h);}'
function Verify([Diagnostics.Process]$p,[string]$birth,[string]$image,[string]$argv) {
[long]$born=0;[long]$exited=0;[long]$kernel=0;[long]$user=0
if(![CustodyPeer]::GetProcessTimes($p.Handle,[ref]$born,[ref]$exited,[ref]$kernel,[ref]$user) -or $born.ToString() -cne $birth){throw 'live custody peer birth changed'}
$actual=[Text.StringBuilder]::new(32768);[uint32]$size=32768
if(![CustodyPeer]::QueryFullProcessImageName($p.Handle,0,$actual,[ref]$size) -or $actual.ToString() -ine $image){throw 'live custody peer image changed'}
$row=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)"
$hash=[Security.Cryptography.SHA256]::Create()
try{$digest=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($row.CommandLine)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
if($digest -cne $argv){throw 'live custody peer argv changed'}
return $row
}
$pipe=[IO.Pipes.NamedPipeClientStream]::new('.',${literal(custodyPipe(record.launchToken).slice(9))},[IO.Pipes.PipeDirection]::InOut)
$v=$null;$holder=$null;$duplicate=[IntPtr]::Zero
try{
$pipe.Connect(5000);[uint32]$peer=0
if(![CustodyPeer]::GetNamedPipeServerProcessId($pipe.SafePipeHandle.DangerousGetHandle(),[ref]$peer) -or $peer -ne ${viewer.pid}){throw 'custodian native peer changed'}
$v=[Diagnostics.Process]::GetProcessById($peer)
$row=Verify $v ${literal(viewer.birth)} ${literal(viewer.executable)} ${literal(viewer.argvDigest)}
if($row.ParentProcessId -ne ${roleIdentity.shell.pid}){throw 'custodian native shell changed'}
$writer=[IO.StreamWriter]::new($pipe,[Text.UTF8Encoding]::new($false),4096,$true);$writer.AutoFlush=$true
$reader=[IO.StreamReader]::new($pipe,[Text.UTF8Encoding]::new($false),$false,4096,$true)
$writer.WriteLine(${literal(JSON.stringify(request))})
$line=$reader.ReadLineAsync();if(!$line.Wait(15000) -or !$line.Result){throw 'live custody response unavailable'}
$capture=ConvertFrom-Json $line.Result
if($capture.type -cne 'custody' -or $capture.nonce -cne ${literal(nonce)} -or $capture.launchToken -cne ${literal(record.launchToken)}){throw 'live custody response changed'}
$holder=[Diagnostics.Process]::GetProcessById([int]$capture.holder.pid)
$holderRow=Verify $holder $capture.holder.birth $capture.holder.executable $capture.holder.argvDigest
if($holderRow.ParentProcessId -ne $peer){throw 'original holder no longer belongs to verified custodian'}
if($capture.nativeHandle -notmatch '^[1-9][0-9]*$' -or ![CustodyPeer]::DuplicateHandle($holder.Handle,[IntPtr]::new([long]$capture.nativeHandle),[CustodyPeer]::GetCurrentProcess(),[ref]$duplicate,0x101000,$false,0)){throw 'original handle duplication unavailable'}
[long]$born=0;[long]$exited=0;[long]$kernel=0;[long]$user=0
if([CustodyPeer]::GetProcessId($duplicate) -ne ${producer.pid} -or ![CustodyPeer]::GetProcessTimes($duplicate,[ref]$born,[ref]$exited,[ref]$kernel,[ref]$user) -or $born.ToString() -cne ${literal(producer.birth)}){throw 'duplicated original producer identity changed'}
[Console]::WriteLine('CAPTURE '+$line.Result)
while($true){
$mode=[Console]::ReadLine()
if($mode -eq 'death'){
if([CustodyPeer]::WaitForSingleObject($duplicate,15000) -ne 0){throw 'original producer death unavailable'}
[uint32]$code=0;if(![CustodyPeer]::GetExitCodeProcess($duplicate,[ref]$code)){throw 'original producer numeric exit unavailable'}
$check=ConvertFrom-Json ${literal(JSON.stringify(request))};$check.type='custody-check'
$check | Add-Member -NotePropertyName holder -NotePropertyValue $capture.holder
$check | Add-Member -NotePropertyName nativeHandle -NotePropertyValue $capture.nativeHandle
$writer.WriteLine((ConvertTo-Json -InputObject $check -Compress -Depth 8))
$valid=$reader.ReadLineAsync();if(!$valid.Wait(15000) -or !$valid.Result){throw 'original custody effect validity unavailable'}
$proof=ConvertFrom-Json $valid.Result
if($proof.type -cne 'custody-valid' -or $proof.nonce -cne ${literal(nonce)} -or $proof.launchToken -cne ${literal(record.launchToken)}){throw 'original custody effect validity changed'}
[Console]::WriteLine('DEAD '+$code)
}elseif($mode -eq 'dispose' -or $null -eq $mode){break}else{throw 'invalid custody observer action'}
}
}finally{if($duplicate -ne [IntPtr]::Zero){$null=[CustodyPeer]::CloseHandle($duplicate)};if($holder){$holder.Dispose()};if($v){$v.Dispose()};$pipe.Dispose()}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = new EventEmitter();
  let stdout = '', stderr = '', buffer = '', alive = true;
  const terminal = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      stdout += chunk; buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1); events.emit('line', line);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('close', (code, signal) => {
      alive = false;
      const receipt = { code, signal, stdout, stderr, stdoutEOF: child.stdout.readableEnded, stderrEOF: child.stderr.readableEnded };
      events.emit('closed', receipt); resolve(receipt);
    });
  });
  const line = prefix => new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(20000);
    const clear = () => { events.off('line', accept); events.off('closed', close); signal.removeEventListener('abort', abort); };
    const accept = value => { if (value.startsWith(prefix + ' ')) { clear(); resolve(value.slice(prefix.length + 1)); } };
    const close = receipt => { clear(); reject(blocked(`native custody ${receipt.code}: ${receipt.stderr}`)); };
    const abort = () => { clear(); reject(blocked('native custody deadline')); };
    events.on('line', accept); events.once('closed', close); signal.addEventListener('abort', abort, { once: true });
  });
  const observation = { async dispose() { if (alive) child.stdin.end('dispose\n'); return terminal; } };
  try {
    const capture = JSON.parse(await line('CAPTURE'));
    if (capture.root !== root || pathKey(capture.path) !== pathKey(path) ||
      pathKey(capture.statePath) !== pathKey(statePath) || pathKey(capture.slotPath) !== pathKey(slotPath) ||
      JSON.stringify(capture.parent) !== JSON.stringify(parent) ||
      JSON.stringify(capture.identity) !== JSON.stringify(producer) ||
      JSON.stringify(capture.roleIdentity) !== JSON.stringify(roleIdentity) ||
      !validParentSlot(capture.initialSlot) ||
      capture.initialSlot.ownerNonce !== previous.ownerNonce || capture.initialSlot.generation !== previous.generation ||
      JSON.stringify(capture.initialSlot.operations) !== JSON.stringify(previous.operations) ||
      capture.initialSlot.operations.some(op => op.status !== 'SETTLED') ||
      !Buffer.from(capture.recordBase64, 'base64').equals(recordBytes) ||
      !Buffer.from(capture.stateBase64, 'base64').equals(stateBytes))
      throw blocked('original live custody provenance changed');
    const captured = { root, path, statePath, recordBytes, stateBytes, parent: structuredClone(parent), herdr,
      roleIdentity, identity: producer, slotPath, initialSlot: capture.initialSlot, leaseRoot: capture.leaseRoot,
      alive: () => alive, released: null, death: null, child, terminal };
    observation.recordPath = path;
    observation.identity = structuredClone(producer);
    observation.death = async () => {
      const received = line('DEAD'); child.stdin.write('death\n');
      const exitCode = Number(await received);
      if (!Number.isInteger(exitCode)) throw blocked('original native numeric exit unavailable');
      captured.death = { identity: producer, exitCode };
      return structuredClone(captured.death);
    };
    retirementCaptures.set(observation, captured);
    return observation;
  } catch (error) { await observation.dispose(); throw error; }
}
async function observeNativeExit(identity, held = false) {
  const script = `$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById(${identity.pid});try{
    $null=$p.Handle;if($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne '${identity.birth.replaceAll("'", "''")}'){throw 'birth changed'}
    [Console]::WriteLine('ARMED')
    ${held ? "$mode=[Console]::ReadLine();if($mode -eq 'dispose' -or $null -eq $mode){[Console]::WriteLine('DISPOSED');return};if($mode -ne 'death'){throw 'invalid held observer action'}" : ''}
    if(!$p.WaitForExit(15000)){throw 'native effect deadline'}
    [Console]::WriteLine($p.ExitCode)
  }finally{$p.Dispose()}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: [held ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', armed;
  const subscribed = new Promise((resolve, reject) => { armed = { resolve, reject }; });
  const effects = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { stdout += chunk; if (/^ARMED\r?$/m.test(stdout)) armed.resolve(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { armed.reject(error); reject(error); });
    child.once('close', code => {
      if (code !== 0 || !child.stdout.readableEnded || !child.stderr.readableEnded) {
        const error = blocked(`native exit observer ${code}: ${stdout}\n${stderr}`);
        armed.reject(error); reject(error);
      } else {
        const last = stdout.trim().split(/\r?\n/).at(-1);
        resolve({ exitCode: last === 'DISPOSED' ? null : Number(last), disposed: last === 'DISPOSED',
          stdout, stderr, code, pid: child.pid, stdoutEOF: true, stderrEOF: true });
      }
    });
  });
  effects.catch(() => {});
  await subscribed;
  let requested;
  return { effects,
    ...(held ? {
      death() { if (!requested) { requested = 'death'; child.stdin.end('death\n'); } return effects; },
      dispose() { if (!requested) { requested = 'dispose'; child.stdin.end('dispose\n'); } return effects; },
    } : {}) };
}
export async function observePaneShell(info, record, inspect = nativeShellProcesses) {
  const pid = info?.process_info?.shell_pid;
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1 ||
    pid !== record.creationProcessId || info.process_info.pane_id && info.process_info.pane_id !== record.paneId) return null;
  let rows;
  try { rows = await inspect(pid); } catch { return null; }
  if (!Array.isArray(rows) || rows.filter(row => row.ProcessId === pid).length !== 1 ||
    new Set(rows.map(row => row.ProcessId)).size !== rows.length) return null;
  const shell = rows.find(row => row.ProcessId === pid), born = Date.parse(shell.CreationDate);
  if (!Number.isFinite(born) || !shell.ExecutablePath || !shell.CommandLine ||
    record.creationDate && shell.CreationDate !== record.creationDate) return null;
  const reported = info.process_info.foreground_processes?.find(row => row.pid === pid);
  if (reported && pathKey(reported.argv?.[0]) !== pathKey(shell.ExecutablePath)) return null;
  const children = rows.filter(row => row !== shell);
  if (children.some(child => !Number.isSafeInteger(child.ProcessId) || child.ProcessId < 1 ||
    child.ParentProcessId !== pid || !child.ExecutablePath || !child.CommandLine ||
    !Number.isFinite(Date.parse(child.CreationDate)) || Date.parse(child.CreationDate) < born)) return null;
  return { shell, children };
}
export async function legacyPaneIdentity(info, record, inspect) {
  if (!record.creationDate) return null;
  const observation = await observePaneShell(info, record, inspect);
  if (!observation || !observation.shell.Birth || record.creationBirth && observation.shell.Birth !== record.creationBirth ||
    observation.children.length > 1) return null;
  const foreground = info.process_info.foreground_processes ?? [];
  if (foreground.length !== 1 || ![record.creationProcessId, record.processId].includes(foreground[0].pid)) return null;
  const actual = { shell: nativeIdentity(observation.shell) };
  if (!observation.children.length) return record.prepared === true && !record.processId ? actual : null;
  const child = observation.children[0], argv = parseLaunchCommand(child.CommandLine);
  const expected = [record.nodePath, record.viewerPath,
    ...(record.role && record.role !== 'todo' ? ['--view', record.role === 'dag' ? 'dag' : 'tasks'] : []),
    '--state', record.statePath, '--close-pane', record.paneId, '--launch-token', record.launchToken];
  if (!child.Birth || record.viewerBirth && child.Birth !== record.viewerBirth ||
    child.ProcessId !== record.processId || pathKey(child.ExecutablePath) !== pathKey(record.nodePath) ||
    !argv || argv.length !== expected.length || argv.some((value, index) =>
      [0, 1, expected.indexOf('--state') + 1].includes(index) ? pathKey(value) !== pathKey(expected[index]) : value !== expected[index])) return null;
  actual.viewer = nativeIdentity(child);
  return actual;
}
export async function paneViewerProcess(info, record, expectedPid, inspect) {
  const foreground = viewerProcess(info, record, expectedPid);
  if (foreground) return foreground;
  const shell = info?.process_info?.shell_pid, pid = expectedPid ?? record.processId;
  // Windows Herdr reports the PowerShell shell, not its foreground Node child.
  // Only the shell returned for this exact split can anchor a native PID query.
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1 ||
    !record.creationDate || !Number.isSafeInteger(record.creationProcessId) || shell !== record.creationProcessId ||
    info.process_info.foreground_processes?.length !== 1 ||
    info.process_info.foreground_processes[0].pid !== shell) return null;
  const observation = await observePaneShell(info, record, inspect);
  if (!observation || observation.children.length !== 1) return null;
  const child = observation.children[0];
  if (child.ProcessId !== pid || record.viewerBirth && child.Birth !== record.viewerBirth ||
    pathKey(child.ExecutablePath) !== pathKey(record.nodePath)) return null;
  const argv = parseLaunchCommand(child.CommandLine);
  if (!argv) return null;
  return viewerProcess({ process_info: { foreground_processes: [{ pid, argv }] } }, record, pid);
}
export async function canCleanupPane(info, record, inspect) {
  if (info?.process_info?.shell_pid !== record.creationProcessId) return false;
  if (process.platform !== 'win32') return (info.process_info.foreground_processes ?? [])
    .every(row => row.pid === record.creationProcessId) || Boolean(viewerProcess(info, record));
  if (!record.creationDate) return false;
  const observation = await observePaneShell(info, record, inspect);
  if (!observation) return false;
  if (!observation.children.length) return true;
  if (observation.children.length !== 1) return false;
  const child = observation.children[0], argv = parseLaunchCommand(child.CommandLine);
  return pathKey(child.ExecutablePath) === pathKey(record.nodePath) && argv !== null &&
    Boolean(viewerProcess({ process_info: { foreground_processes: [{ pid: child.ProcessId, argv }] } }, record));
}

export class TodoPane {
  constructor({ ctx, environment = process.env, stateDir, cwd, node = process.execPath,
    viewer, herdr = createDashboardHerdr(environment), inspectShell, language = 'en', notify = () => {}, managed = false,
    retirementObservations = new Map() }) {
    Object.assign(this, { ctx, environment, stateDir, cwd, node, viewer, herdr, inspectShell, language, notify, managed });
    this.binding = { socketPath: environment.HERDR_SOCKET_PATH, parentPaneId: environment.HERDR_PANE_ID,
      sessionId: ctx.sessionManager.getSessionId() };
    this.binding.ownerKey = displayOwnerKey(this.binding.socketPath, this.binding.parentPaneId, this.binding.sessionId);
    this.directory = join(stateDir, this.binding.ownerKey);
    this.stateFile = join(this.directory, 'todo.json');
    this.recordFile = join(this.directory, 'todo.pane.json');
    this.lifetimeId = randomUUID();
    this.events = new EventEmitter();
    this.tail = Promise.resolve();
    this.roleTail = Promise.resolve();
    this.controlJobs = new Set();
    this.stopSignal = new AbortController();
    this.stopped = false;
    this.provider = null;
    this.source = null;
    this.ownedRoles = new Map();
    this.unsubscribers = [];
    this.controlToken = randomBytes(32).toString('hex');
    this.controlPath = `\\\\.\\pipe\\omo-herdr-todo-control-${randomUUID()}`;
    this.presencePath = `\\\\.\\pipe\\omo-herdr-todo-${randomUUID()}`;
    this.controlSockets = new Set();
    this.status = 'waiting';
    this.managedTail = Promise.resolve();
    this.pendingLaunches = new Set();
    this.launchRegistrations = new Map();
    this.effectObservations = new Map();
    this.viewerHolders = new Map();
    this.viewerDeaths = new Map();
    this.legacyObservations = retirementObservations;
    this.retirementSubscribers = new Map();
    this.custodyLost = false;
    this.retainedTargets = new Map();
    this.closureVersions = new Map();
  }
  assertManaged() {
    if (this.stopped || this.managedBlocked || this.custodyLost || !this.actor?.leaseHeld || this.actor.draining || this.actor.blocked) {
      this.status = 'BLOCKED';
      this.bridge?.readinessChanged();
      throw blocked('managed controller or lease unavailable');
    }
  }
  managedWrite(job) {
    const actor = this.actor, lifetime = this.lifetimeId;
    const result = this.managedTail.then(async () => {
      this.assertManaged();
      if (actor !== this.actor || lifetime !== this.lifetimeId) throw blocked('stale publisher');
      return job(actor);
    }).catch(error => {
      if (this.actor === actor) {
        this.status = 'BLOCKED';
        this.recoveryBlocked = true;
        this.bridge?.readinessChanged();
        void this.watchRecoveryMembership().catch(() => {});
      }
      throw error;
    });
    this.managedTail = result.catch(() => {});
    return result;
  }
  async managedIdle() { await this.managedTail; }
  async nativePane(paneId, record) {
    const member = await this.membership(paneId);
    const info = await this.herdr('process-info', '--pane', paneId);
    const pid = info?.process_info?.shell_pid;
    const rows = await (this.inspectShell ?? nativeShellProcesses)(pid);
    const shell = rows.filter(row => row.ProcessId === pid);
    if (shell.length !== 1 || record && (record.creationProcessId !== pid ||
      record.creationDate !== shell[0].CreationDate || record.creationBirth && record.creationBirth !== shell[0].Birth)) {
      throw blocked('parent or role shell changed');
    }
    const actual = { paneId: member.pane.pane_id, tabId: member.tabId,
      shell: { pid, birth: nativeIdentity(shell[0]).birth } };
    if (!record && paneId !== this.binding.parentPaneId && rows.some(row => row.ParentProcessId === pid)) {
      throw blocked('unregistered target has a foreground child');
    }
    if (record) {
      const state = await readRoleState(this.stateFile);
      if (!state || state.scopeEpoch !== this.scopeEpoch || state.launchToken !== record.launchToken ||
        !sameDashboardOwner(state, this.binding)) throw blocked('role source changed');
      Object.assign(actual, { statePath: this.stateFile, sourcePath: this.ctx.sessionManager.getSessionFile(),
        cachePath: state.cachePath, prefsPath: state.prefsPath, launchToken: state.launchToken,
        controlToken: state.controlOffer?.token ?? this.controlToken });
      if (record.processId) {
        const children = rows.filter(row => row.ParentProcessId === pid);
        if (children.length !== 1 || children[0].ProcessId !== record.processId ||
          record.viewerBirth && children[0].Birth !== record.viewerBirth ||
          !await paneViewerProcess(info, record, record.processId, async () => rows)) throw blocked('role viewer changed');
        actual.viewer = nativeIdentity(children[0]);
      } else if (rows.some(row => row.ParentProcessId === pid)) throw blocked('launch target is occupied');
    }
    return actual;
  }
  async currentTarget(paneId) {
    const retained = this.retainedTargets.get(paneId);
    if (retained) return this.observeRetainedTarget(retained);
    const role = Object.values(this.actor.snapshot.roles).find(role => role.paneId === paneId);
    if (!role) return this.nativePane(paneId);
    return role.role === 'todo' ? this.nativePane(paneId, await readJson(this.recordFile)) : this.provider.observeTarget(role);
  }
  async observeManaged({ target, operation, locator }) {
    const parent = await this.nativePane(this.binding.parentPaneId);
    const rows = await (this.inspectShell ?? nativeShellProcesses)(process.pid);
    const producerRow = rows.find(row => row.ProcessId === process.pid);
    const producer = nativeIdentity(producerRow);
    let ancestor = producerRow.ParentProcessId;
    for (let depth = 0; depth < 5 && ancestor !== parent.shell.pid; depth++) {
      const row = (await (this.inspectShell ?? nativeShellProcesses)(ancestor)).find(item => item.ProcessId === ancestor);
      if (!row || row.ParentProcessId === ancestor) throw blocked('producer parent membership unavailable');
      ancestor = row.ParentProcessId;
    }
    if (ancestor !== parent.shell.pid) throw blocked('producer is outside native parent');
    let missing;
    if (locator) {
      try { await this.herdr('get', locator.paneId); }
      catch (error) {
        if (!authoritativePaneNotFound(error)) throw error;
        missing = { code: error.code, paneId: locator.paneId };
      }
    }
    const retained = operation && this.effectObservations.get(operation.id);
    if (retained?.promise) await retained.promise;
    if (operation?.type === 'close' && retained?.settled && retained.retiredTarget) {
      try { await this.herdr('get', target.paneId); }
      catch (error) {
        if (!authoritativePaneNotFound(error)) throw error;
        return { parent, producer, missing: { code: error.code, paneId: target.paneId },
          retiredTarget: retained.retiredTarget, effect: { id: operation.id, settled: true } };
      }
      throw blocked('retired close target reappeared');
    }
    let observed;
    if (target) {
      if (this.retainedTargets.has(target.paneId)) {
        observed = await this.observeRetainedTarget(this.retainedTargets.get(target.paneId));
      } else if (target.statePath === this.stateFile) {
        observed = await this.nativePane(target.paneId, await readJson(this.recordFile));
      } else if (target.statePath) {
        observed = await this.provider?.observeTarget(target);
      } else observed = await this.nativePane(target.paneId);
      if (!observed) throw blocked('target participant unavailable');
    }
    // The actor's equality contract retains the requested key order. Values
    // above come from current membership, native rows and bound role files.
    const effect = operation && this.effectObservations.get(operation.id);
    return { parent, producer, missing,
      target: target && Object.fromEntries(Object.keys(target).map(key => [key, observed[key]])),
      effect: effect?.settled && effect.ownerNonce === this.actor.snapshot.ownerNonce &&
        effect.generation === this.actor.snapshot.generation && effect.lifetimeId === operation.lifetimeId
        ? { id: operation.id, settled: true } : undefined };
  }
  perform(role, type, target, dispatch) {
    const result = this.managedWrite(async actor => {
      this.layoutActive = true;
      this.bridge?.readinessChanged();
      try {
        const result = await actor.perform(actor.capability(role === 'todo' ? 'todo' : 'dag', role), { type, target }, dispatch,
          ({ operation }) => this.invalidateCustodyEffect(operation));
        if (type === 'arrange' || type === 'close' ||
          (type === 'split' || type === 'run') && actor.snapshot.roles[role]?.ack?.painted === false) {
          // PREPARED keeps the paint sequence floor. Repaint the current source
          // through the real publisher; an old same-sequence ACK cannot restore READY.
          this.bridge?.invalidate();
          await this.presence?.idle();
        }
        return result;
      } finally {
        this.layoutActive = false;
        this.bridge?.readinessChanged();
      }
    });
    return result.then(value => {
      void this.publishCustodyBinding().catch(error => { if (!this.stopped) this.notify(error.message); });
      return value;
    });
  }
  publishCustodyBinding() {
    return this.roleWrite(async () => {
      const record = await readJson(this.recordFile), slot = this.actor?.snapshot;
      if (!this.stopped && !this.actor?.blocked && !this.actor?.draining &&
        slot?.operations.every(operation => operation.status === 'SETTLED') &&
        this.recordMatches(record) && record.scopeEpoch === this.scopeEpoch &&
        !record.manualClose && slot.roles.todo?.viewer?.pid === record.processId)
        await writeJson(this.stateFile, this.roleState(record));
    });
  }
  async invalidateCustodyEffect(operation) {
    if (this.custodyLost) throw blocked('original custody channel lost before dispatch');
    const pending = [];
    for (const [socket, subscriber] of this.retirementSubscribers) {
      if (!subscriber.custody || subscriber.invalidated) continue;
      const signal = AbortSignal.any([this.stopSignal.signal, AbortSignal.timeout(10000)]);
      const result = new Promise((resolve, reject) => {
        const clear = () => {
          subscriber.pending.delete(operation.id);
          socket.off('close', close); signal.removeEventListener('abort', abort);
        };
        const close = () => { clear(); reject(blocked('original custody effect channel closed')); };
        const abort = () => { clear(); reject(signal.reason); };
        subscriber.pending.set(operation.id, { operation, accept: () => {
          subscriber.invalidated = true; clear(); resolve();
        } });
        socket.once('close', close); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted || socket.destroyed) return abort();
        send(socket, { ...subscriber.offer, type: 'custody-effect', nonce: subscriber.nonce, operation });
      });
      pending.push(result);
    }
    await Promise.all(pending);
  }
  async observeArrange(target, args, expected) {
    const kind = args[0], option = name => args[args.indexOf(name) + 1];
    const before = (await this.herdr('layout', '--pane', target.paneId))?.layout;
    const rect = (layout, id) => {
      const rows = layout?.panes?.filter(pane => pane.pane_id === id);
      if (rows?.length !== 1 || !rows[0].rect ||
        !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rows[0].rect[key])))
        throw blocked('arrange target geometry unavailable');
      return rows[0].rect;
    };
    if (before?.tab_id !== target.tabId || !['move', 'swap', 'resize', 'focus'].includes(kind))
      throw blocked('arrange intent unavailable');
    rect(before, target.paneId);
    const otherId = kind === 'swap' || kind === 'move' ? option('--target-pane') :
      kind === 'focus' ? (await this.herdr('neighbor', '--pane', target.paneId,
        '--direction', option('--direction')))?.neighbor?.neighbor_pane_id : null;
    if ((kind === 'swap' ? option('--source-pane') : kind === 'move' ? args[1] : option('--pane')) !== target.paneId ||
      kind === 'move' && option('--tab') !== target.tabId ||
      ['move', 'swap', 'focus'].includes(kind) && (!otherId || otherId === target.paneId))
      throw blocked('arrange intent target mismatch');
    if (otherId) rect(before, otherId);
    if (kind === 'resize' && (expected?.paneId !== target.paneId || !expected.rect ||
      !['x', 'y', 'width', 'height'].every(key => Number.isFinite(expected.rect[key]))))
      throw blocked('resize expected geometry unavailable');
    const identities = new Map();
    for (const pane of before.panes) identities.set(pane.pane_id, await this.currentTarget(pane.pane_id));
    const actor = this.actor, lifetime = this.lifetimeId, provider = this.provider;
    const generation = actor.snapshot.generation, ownerNonce = actor.snapshot.ownerNonce;
    const participants = JSON.stringify(actor.snapshot.participants);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const sameSplits = (a, b) => a?.length === b?.length && a?.every((split, index) =>
      split.id === b[index].id && split.direction === b[index].direction &&
      Math.fround(split.ratio) === Math.fround(b[index].ratio) && same(split.rect, b[index].rect));
    const matches = layout => {
      if (layout?.tab_id !== before.tab_id || layout.workspace_id !== before.workspace_id ||
        !same(layout.area, before.area) || layout.zoomed !== before.zoomed ||
        layout.panes?.length !== before.panes.length) return false;
      if (kind === 'move') {
        const a = rect(layout, target.paneId), b = rect(layout, otherId);
        return option('--split') === 'right'
          ? a.x === b.x + b.width && a.y === b.y && a.height === b.height
          : a.y === b.y + b.height && a.x === b.x && a.width === b.width;
      }
      if (kind === 'resize') {
        if (layout.focused_pane_id !== before.focused_pane_id ||
          !same(rect(layout, target.paneId), expected.rect) ||
          layout.splits?.length !== before.splits?.length || before.splits.length !== before.panes.length - 1)
          return false;
        const equalRect = (a, b) => ['x', 'y', 'width', 'height'].every(key => a?.[key] === b?.[key]);
        // Native split rectangles are subtree areas, not divider rectangles.
        // Retain each leaf and split's original first/second-child attachment.
        const children = split => {
          const axis = split.direction === 'right' ? 'width' : 'height';
          const coordinate = split.direction === 'right' ? 'x' : 'y';
          const size = Math.round(Math.fround(split.rect[axis] * Math.fround(split.ratio)));
          return [{ ...split.rect, [axis]: size }, { ...split.rect,
            [coordinate]: split.rect[coordinate] + size, [axis]: split.rect[axis] - size }];
        };
        const originalChildren = before.splits.map(children), currentChildren = layout.splits.map(children);
        const attachment = (oldRect, newRect) => {
          const parent = originalChildren.findIndex(parts => parts.some(part => equalRect(part, oldRect)));
          return parent !== -1 && equalRect(newRect,
            currentChildren[parent][originalChildren[parent].findIndex(part => equalRect(part, oldRect))]);
        };
        const changed = before.splits.filter((split, index) =>
          Math.fround(split.ratio) !== Math.fround(layout.splits[index].ratio));
        if (changed.length !== 1 || changed[0].direction !==
          (['left', 'right'].includes(option('--direction')) ? 'right' : 'down')) return false;
        const targetBefore = rect(before, target.paneId), area = changed[0].rect;
        const horizontal = changed[0].direction === 'right';
        const coordinate = horizontal ? 'x' : 'y', axis = horizontal ? 'width' : 'height';
        const cross = horizontal ? 'y' : 'x', crossSize = horizontal ? 'height' : 'width';
        const nearest = edge => before.splits.map((split, index) => ({ split,
          distance: Math.abs(originalChildren[index][0][coordinate] + originalChildren[index][0][axis] - edge) }))
          .filter(({ split, distance }) => split.direction === changed[0].direction && distance <= 1 &&
            split.rect[cross] < targetBefore[cross] + targetBefore[crossSize] &&
            split.rect[cross] + split.rect[crossSize] > targetBefore[cross])
          .sort((a, b) => a.distance - b.distance)[0]?.split;
        const nearEdge = targetBefore[coordinate], farEdge = nearEdge + targetBefore[axis];
        const forward = ['right', 'down'].includes(option('--direction'));
        if (changed[0] !== (nearest(forward ? farEdge : nearEdge) ?? nearest(forward ? nearEdge : farEdge)))
          return false;
        if (targetBefore.x < area.x || targetBefore.y < area.y ||
          targetBefore.x + targetBefore.width > area.x + area.width ||
          targetBefore.y + targetBefore.height > area.y + area.height) return false;
        return before.splits.every((split, index) => split.id === layout.splits[index].id &&
          split.direction === layout.splits[index].direction &&
          Number.isFinite(layout.splits[index].ratio) && layout.splits[index].ratio > 0 && layout.splits[index].ratio < 1 &&
          (index === 0 ? equalRect(split.rect, before.area) && equalRect(layout.splits[index].rect, before.area) :
            attachment(split.rect, layout.splits[index].rect))) &&
          before.panes.every(pane => attachment(pane.rect, rect(layout, pane.pane_id)));
      }
      return layout.focused_pane_id === (kind === 'swap' ? target.paneId : otherId) &&
        sameSplits(layout.splits, before.splits) && before.panes.every(pane => same(rect(layout, pane.pane_id),
          rect(before, kind === 'swap' && pane.pane_id === target.paneId ? otherId :
            kind === 'swap' && pane.pane_id === otherId ? target.paneId : pane.pane_id)));
    };
    let started, failed, completed, effectsReject, submitted = false;
    const ready = new Promise((resolve, reject) => { started = resolve; failed = reject; });
    const effects = new Promise((resolve, reject) => { completed = resolve; effectsReject = reject; });
    ready.catch(() => {}); effects.catch(() => {});
    const socket = net.createConnection(process.platform === 'win32'
      ? `\\\\.\\pipe\\${this.binding.socketPath}` : this.binding.socketPath);
    const signal = AbortSignal.any([this.stopSignal.signal, AbortSignal.timeout(10000)]);
    const id = randomUUID();
    const fail = error => { failed(error); effectsReject(error); socket.destroy(); };
    const abort = () => fail(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) fail(signal.reason);
    socket.once('error', fail);
    socket.once('close', () => fail(blocked('arrange completion connection lost')));
    socket.once('connect', () => send(socket, { id, method: 'events.subscribe', params: {
      subscriptions: [{ type: kind === 'focus' ? 'pane.focused' : kind === 'move' ? 'pane.moved' : 'layout.updated' }],
    } }));
    receive(socket, message => {
      try {
        if (message.id === id && message.error) return fail(blocked(message.error.code));
        if (message.id === id && message.result?.type === 'subscription_started') return started();
        if (!submitted) return;
        if (kind === 'focus' && message.event === 'pane_focused' &&
          message.data?.pane_id === otherId && message.data.workspace_id === before.workspace_id) completed(message);
        else if (kind === 'move' && message.event === 'pane_moved' &&
          message.data?.previous_pane_id === target.paneId && message.data.previous_tab_id === target.tabId) completed(message);
        else if (message.event === 'layout_updated' && matches(message.data?.layout)) completed(message);
      } catch (error) { fail(error); }
    });
    const close = () => { signal.removeEventListener('abort', abort); socket.destroy(); };
    try { await ready; }
    catch (error) { close(); throw error; }
    return { effects, submit: () => {
      this.assertManaged();
      if (signal.aborted || actor !== this.actor || lifetime !== this.lifetimeId || provider !== this.provider ||
        participants !== JSON.stringify(actor.snapshot.participants)) throw blocked('arrange source lifetime changed');
      submitted = true;
    }, close,
      complete: async result => {
        const receipt = result?.[kind === 'move' ? 'move_result' : kind];
        if (!receipt?.changed || result.type !== (kind === 'focus' ? 'pane_focus_direction' : 'pane_' + kind) ||
          (kind === 'swap' || kind === 'focus' ? receipt.source_pane_id : kind === 'move' ? receipt.previous_pane_id : receipt.pane_id) !== target.paneId ||
          kind === 'swap' && receipt.target_pane_id !== otherId ||
          !matches(kind === 'move' ? receipt.target_layout : receipt.layout))
          throw blocked('arrange operation receipt mismatch');
        await effects;
        this.assertManaged();
        if (actor !== this.actor || lifetime !== this.lifetimeId || provider !== this.provider ||
          generation !== actor.snapshot.generation || ownerNonce !== actor.snapshot.ownerNonce ||
          participants !== JSON.stringify(actor.snapshot.participants))
          throw blocked('arrange source lifetime changed');
        for (const [paneId, identity] of identities) {
          if (!same(await this.currentTarget(paneId), identity)) throw blocked('arrange native target changed');
        }
        const current = (await this.herdr('layout', '--pane', target.paneId))?.layout;
        if (!matches(current) || !same(current, kind === 'move' ? receipt.target_layout : receipt.layout))
          throw blocked('arrange current effect mismatch');
        if (!same((await this.observeManaged({ target })).target, target)) throw blocked('arrange source target changed');
        this.assertManaged();
        if (actor !== this.actor || lifetime !== this.lifetimeId || provider !== this.provider ||
          participants !== JSON.stringify(actor.snapshot.participants)) throw blocked('arrange source lifetime changed');
      } };
  }
  async mutate(role, type, target, args, observedEffect, beforeSubmit) {
    if (!this.managed) return this.herdr(...args);
    return this.perform(role, type, target, async ({ operation }) => {
      let resolve, reject;
      const effects = new Promise((done, fail) => { resolve = done; reject = fail; });
      effects.catch(() => {});
      let arrange, submitted = false;
      const actor = this.actor, lifetime = this.lifetimeId;
      const observation = { settled: false, ownerNonce: operation.ownerNonce,
        generation: operation.generation, lifetimeId: operation.lifetimeId };
      this.effectObservations.set(operation.id, observation);
      try {
        const exit = type === 'close' ? await observeNativeExit(target.shell) : null;
        if (type === 'arrange') arrange = await this.observeArrange(target, args, observedEffect);
        if (type === 'run' && observedEffect || type === 'close') {
          observation.promise = (type === 'run' ? observedEffect : exit.effects).then(async () => {
            if (!submitted || this.stopped || this.actor !== actor || this.lifetimeId !== lifetime ||
              !actor.leaseHeld || actor.draining || actor.snapshot.ownerNonce !== operation.ownerNonce ||
              actor.snapshot.generation !== operation.generation) throw blocked('late effect lifetime changed');
            if (type === 'close') {
              try { await this.herdr('get', target.paneId); throw blocked('close target remains'); }
              catch (error) { if (!authoritativePaneNotFound(error)) throw error; }
              observation.retiredTarget = structuredClone(target);
            } else {
              const actual = await this.observeManaged({ target });
              if (JSON.stringify(actual.target) !== JSON.stringify(target)) throw blocked('late run source changed');
            }
            observation.settled = true;
          }).catch(error => { observation.error = error; });
        }
        await beforeSubmit?.();
        arrange?.submit();
        submitted = true;
        const result = await this.herdr(...args);
        if (type === 'split') await this.nativePane(result?.pane?.pane_id);
        else if (type === 'close') {
          await exit.effects;
          if ((await this.herdr('list')).panes.some(pane => pane.pane_id === target.paneId)) throw blocked('close effect not settled');
        } else if (type === 'arrange') await arrange.complete(result);
        if (observedEffect && type !== 'arrange') await observedEffect;
        resolve();
        observation.settled = true;
        return { result, effects };
      } catch (error) { reject(error); throw error; }
      finally { arrange?.close(); }
    });
  }
  registerManagedRole(role, readTarget) {
    return this.managedWrite(async actor => {
      const target = await readTarget();
      if (target === null) return false;
      const old = actor.snapshot.roles[role];
      if (old?.lifetimeId === actor.snapshot.participants[role === 'todo' ? 'todo' : 'dag']?.lifetimeId &&
        ['paneId', 'tabId', 'shell', 'viewer', 'statePath', 'sourcePath', 'cachePath', 'prefsPath', 'launchToken', 'controlToken']
          .every(key => JSON.stringify(old[key]) === JSON.stringify(target[key]))) return;
      await actor.registerRole(actor.capability(role === 'todo' ? 'todo' : 'dag', role), target);
      this.bridge?.readinessChanged();
    });
  }
  paintManaged(event) {
    if (this.stopped || !this.actor?.leaseHeld) { this.bridge?.readinessChanged(); return; }
    const old = this.actor.snapshot.roles[event.role];
    if (this.actor.snapshot.phase === 'READY' && old?.ack?.painted &&
      old.ack.sequence === event.sequence && old.generation === this.actor.snapshot.generation) return;
    void this.managedWrite(async actor => {
      const record = actor.snapshot.roles[event.role];
      const receipt = { ...this.presence.getOwner(), role: event.role, sequence: event.sequence };
      if (!record || !this.presence.isReady(receipt)) return;
      if (record.ack && event.sequence <= record.ack.sequence &&
        !(record.ack.painted && event.sequence === record.ack.sequence)) return;
      if (!record.ack?.painted || record.ack.sequence !== event.sequence)
        await actor.ackRole({ ...actor.capability(event.role === 'todo' ? 'todo' : 'dag', event.role),
          paneId: record.paneId, statePath: record.statePath, launchToken: record.launchToken,
          controlToken: record.controlToken, painted: true, sequence: event.sequence });
      const snapshot = actor.snapshot;
      if (snapshot.phase !== 'READY' && ['todo', 'dag', 'workers'].every(role => snapshot.roles[role]?.ack?.painted &&
        this.presence.isReady({ ...receipt, role }) && snapshot.roles[role].ack.sequence === event.sequence)) {
        await actor.ready();
        return true;
      }
      this.bridge?.readinessChanged();
    }).then(async becameReady => {
      if (becameReady && !this.stopped) await this.roleWrite(async () => {
        const record = await readJson(this.recordFile);
        if (this.actor?.snapshot.phase === 'READY' && this.recordMatches(record) &&
          record.scopeEpoch === this.scopeEpoch && !record.manualClose)
          await writeJson(this.stateFile, this.roleState(record));
      });
      this.bridge?.readinessChanged();
    }).catch(error => { if (!this.stopped) this.notify(error.message); });
  }
  enqueue(job) {
    const lifetime = this.lifetimeId;
    const result = this.tail.then(() => {
      if (this.stopped || lifetime !== this.lifetimeId) return;
      return job();
    });
    this.tail = result.catch(error => { if (!this.stopped) {
      this.status = this.managed || error.inlineFallback ? 'BLOCKED' : 'layout-waiting'; this.notify(error.message);
      if (this.managed) {
        this.recoveryBlocked = true;
        this.bridge?.readinessChanged();
        void this.watchRecoveryMembership().catch(() => {});
      }
    } });
    return result;
  }
  roleWrite(job) {
    const result = this.roleTail.then(job);
    this.roleTail = result.catch(() => {});
    return result;
  }
  async start() {
    const old = await readJson(this.recordFile);
    this.scopeEpoch = Math.max(0, old?.scopeEpoch ?? 0) + 1;
    let cache;
    const directory = this.directory;
    this.storage = {
      get path() { return cache.path; },
      rebase(next) {
        cache?.rebase(next); // Invalidate an old in-flight write before changing its path.
        cache = createSnapshotStorage({ path: join(directory, `scope-${next.scopeEpoch}`, 'todo.cache.json') });
        cache.rebase(next);
      },
      write(snapshot) { return cache.write(snapshot); },
    };
    this.presence = createPresence({ ...this.binding, scopeEpoch: this.scopeEpoch, storage: this.storage, pipePath: this.presencePath,
      hasDagOwnedTasks: () => this.source !== null && this.source.runs.some(run => run.nodes.some(node => node.taskId)) });
    await this.startControl();
    await this.presence.start();
    if (this.stopped) return;
    this.adapter = {
      getOwner: () => this.presence.getOwner(),
      publish: snapshot => this.presence.publish(snapshot),
      settings: this.presence.settings,
      hasDagOwnedTasks: () => this.presence.hasDagOwnedTasks(),
      isReady: receipt => {
        const record = this.ownedRoles.get(receipt?.role);
        if (this.managed) {
          const snapshot = this.actor?.snapshot;
          if (this.stopped || this.managedBlocked || this.recoveryBlocked || this.layoutActive || this.sourceRefreshing ||
            this.actor?.inlineFallback !== false || snapshot?.sessionId !== this.binding.sessionId ||
            snapshot.participants.todo?.lifetimeId !== this.lifetimeId ||
            snapshot.participants.dag?.lifetimeId !== this.provider?.lifetimeId ||
            !['todo', 'dag', 'workers'].every(role => snapshot.roles[role]?.generation === snapshot.generation &&
              snapshot.roles[role]?.ack?.painted && snapshot.roles[role].ack.sequence === receipt.sequence &&
              this.ownedRoles.get(role)?.ready && !this.ownedRoles.get(role).manualClose &&
              this.presence.isReady({ ...receipt, role }))) return false;
        }
        return record?.scopeEpoch === this.scopeEpoch && record.ready === true && record.manualClose !== true &&
          Number.isSafeInteger(record.processId) && this.presence.isReady(receipt);
      },
    };
    this.onPresenceEvent = event => {
      if (event.type === 'disconnected') {
        this.ownedRoles.delete(event.role);
        if (this.managed && !this.stopped) void this.observeViewerDeath(event.role).catch(() => {});
      }
      if (this.managed && event.type === 'ack') this.paintManaged(event);
    };
    this.presence.events.on('event', this.onPresenceEvent);
    this.bridge = installDisplayBridge(this.ctx, this.adapter, { environment: this.environment });
    if (!this.bridge) throw new Error('Native display bridge is unavailable for this owner');
    this.offReadiness = this.presence.subscribeReadiness(() => {
      if (!this.stopped) this.bridge?.readinessChanged();
    });
    await this.presence.idle();
    if (!this.presence.state.snapshot) throw new Error('Initial native source save failed');
    if (this.managed) {
      const observation = await this.observeManaged({});
      const paths = await parentSlotPaths({ stateDir: this.stateDir, socketPath: this.binding.socketPath,
        parent: observation.parent });
      const previous = await readJson(paths.slotPath);
      if (validParentSlot(previous) && previous.phase !== 'RELEASED') {
        let capture = [...this.legacyObservations.values()].find(value =>
          JSON.stringify(value.identity) === JSON.stringify(previous.producer));
        if (!capture) {
          const records = await discoverLegacyRecords(this.stateDir, this.binding);
          const custodian = records.find(entry => entry.record.role === 'todo' &&
            entry.record.paneId === previous.roles.todo?.paneId &&
            entry.record.statePath === previous.roles.todo?.statePath &&
            entry.record.launchToken === previous.roles.todo?.launchToken && !entry.record.manualClose);
          if (!custodian) throw blocked('surviving original producer custody unavailable');
          capture = await captureCustodiedProducer({ stateDir: this.stateDir, recordPath: custodian.path,
            parent: observation.parent, herdr: this.herdr, slotPath: paths.slotPath, previous });
          this.legacyObservations.set(capture.recordPath, capture);
        }
        const retired = await observeLegacyRetirement(capture, { stateDir: this.stateDir,
          recordPath: capture.recordPath, parent: observation.parent });
        if (retired?.state !== 'dead') await capture.death();
      }
      this.actor = await claimParentSlot({ stateDir: this.stateDir, socketPath: this.binding.socketPath,
        parent: observation.parent, producer: observation.producer, sessionId: this.binding.sessionId,
        observe: request => this.observeManaged(request),
        observePrevious: async identity => {
          for (const capture of this.legacyObservations.values()) {
            if (JSON.stringify(capture.identity) !== JSON.stringify(identity)) continue;
            const retired = await observeLegacyRetirement(capture, { stateDir: this.stateDir,
              recordPath: capture.recordPath, parent: observation.parent });
            if (retired?.state === 'dead') return retired;
          }
          return null;
        } });
      await this.actor.join('todo', this.lifetimeId);
      this.publisherScope = Object.freeze({
        ownerNonce: this.actor.snapshot.ownerNonce, generation: this.actor.snapshot.generation,
        sessionId: this.binding.sessionId, lifetimeId: this.lifetimeId,
        producer: this.actor.snapshot.producer, parent: this.actor.snapshot.parent,
      });
      this.claimRetired = this.actor.snapshot.generation > 1;
    }
    this.status = 'layout-waiting';
  }
  async startControl() {
    this.control = net.createServer(socket => {
      this.controlSockets.add(socket);
      socket.once('close', () => this.controlSockets.delete(socket));
      socket.on('error', () => {});
      receive(socket, message => {
        const job = this.handleControl(message, socket);
        this.controlJobs.add(job);
        void job.catch(() => socket.destroy()).finally(() => this.controlJobs.delete(job));
      });
    });
    await new Promise((resolve, reject) => {
      this.control.once('error', reject); this.control.once('listening', resolve); this.control.listen(this.controlPath);
    });
  }
  async membership(paneId) {
    const panes = (await this.herdr('list'))?.panes ?? [];
    const parents = panes.filter(pane => pane.pane_id === this.binding.parentPaneId);
    const matches = panes.filter(pane => pane.pane_id === paneId);
    if (parents.length !== 1 || matches.length !== 1 || !parents[0].tab_id ||
      matches[0].tab_id !== parents[0].tab_id) throw new Error('layout-waiting: missing or ambiguous owned anchor');
    return { pane: matches[0], tabId: parents[0].tab_id };
  }
  recordMatches(record) {
    return record?.schema === 'omo-herdr-dashboard/pane/1' && record.role === 'todo' &&
      sameDashboardOwner(record, this.binding) && pathKey(record.statePath) === pathKey(this.stateFile) &&
      pathKey(record.viewerPath) === pathKey(this.viewer) && typeof record.launchToken === 'string';
  }
  async verify(record, pid) {
    if (!this.recordMatches(record) || !record.paneId) return null;
    const member = await this.membership(record.paneId);
    if (record.tabId !== member.tabId) return null;
    const state = await readRoleState(this.stateFile);
    if (!state || !sameDashboardOwner(state, record) || state.launchToken !== record.launchToken ||
      state.paneId !== record.paneId || state.role !== record.role) return null;
    const info = await this.herdr('process-info', '--pane', record.paneId);
    if (this.managed) {
      const identity = await legacyPaneIdentity(info, { ...record, processId: pid ?? record.processId }, this.inspectShell);
      return identity?.viewer ? { pid: identity.viewer.pid } : null;
    }
    return paneViewerProcess(info, record, pid, this.inspectShell);
  }
  async handleControl(message, socket) {
    if (message?.type === 'custody-disposed') {
      const subscriber = this.retirementSubscribers.get(socket);
      if (!subscriber?.custody || message.nonce !== subscriber.nonce || !sameControl(message, subscriber.offer))
        return socket.destroy();
      subscriber.invalidated = true;
      send(socket, { ...subscriber.offer, type: 'custody-disposed', nonce: subscriber.nonce });
      return;
    }
    if (message?.type === 'custody-invalidated') {
      const subscriber = this.retirementSubscribers.get(socket), operation = message.operation;
      const pending = subscriber?.custody && subscriber.pending.get(operation?.id);
      if (this.stopped || !pending || message.nonce !== subscriber.nonce ||
        !sameControl(message, subscriber.offer) ||
        !['id', 'ownerNonce', 'sessionId', 'generation', 'participant', 'lifetimeId', 'role', 'type', 'preparedRevision']
          .every(key => operation[key] === pending.operation[key]) ||
        JSON.stringify(operation.target) !== JSON.stringify(pending.operation.target))
        return socket.destroy();
      pending.accept();
      return;
    }
    if (message?.type === 'observe-retirement' && !this.stopped) {
      if (message.custody === true) {
        await this.managedIdle(); await this.roleTail; await this.provider?.idle?.();
        if (this.stopped || this.actor?.blocked || this.actor?.draining ||
          this.actor?.snapshot.operations.some(operation => operation.status !== 'SETTLED'))
          return socket.destroy();
      }
      const record = await readJson(this.recordFile), state = await readRoleState(this.stateFile);
      if (!this.managed || !this.actor?.leaseHeld || !sameControl(message, state?.controlOffer) ||
        typeof message.nonce !== 'string' || !message.nonce || !await this.verify(record, record.processId))
        return socket.destroy();
      this.retirementSubscribers.set(socket, { offer: state.controlOffer, nonce: message.nonce,
        recordSHA256: createHash('sha256').update(await readFile(this.recordFile)).digest('hex'),
        ...(message.custody === true ? { custody: true, pending: new Map() } : {}) });
      socket.once('close', () => {
        const subscriber = this.retirementSubscribers.get(socket);
        this.retirementSubscribers.delete(socket);
        if (subscriber?.custody && !subscriber.invalidated && !this.stopped && this.actor?.leaseHeld) {
          this.custodyLost = true; this.recoveryBlocked = true; this.status = 'BLOCKED';
          this.bridge?.readinessChanged();
        }
      });
      if (message.custody === true) this.custodyLost = false;
      send(socket, { ...state.controlOffer, type: 'observing', nonce: message.nonce,
        ...(message.custody === true ? { slot: this.actor.snapshot } : {}) });
      return;
    }
    if (!['register', 'close'].includes(message?.type) ||
      this.stopped && !(this.managed && message.type === 'register' && this.pendingLaunches.has(message.launchToken))) return socket.destroy();
    const registration = this.roleWrite(async () => {
      const record = await readJson(this.recordFile);
      const state = await readRoleState(this.stateFile);
      if (!sameControl(message, state?.controlOffer) || message.scopeEpoch !== this.scopeEpoch ||
        !this.recordMatches(record) || record.launchToken !== message.launchToken ||
        !Number.isSafeInteger(message.pid) || !(await this.verify(record, message.pid))) return socket.destroy();
      if (message.scopeEpoch !== this.scopeEpoch) return socket.destroy();
      if (this.managed && message.type === 'register' && this.pendingLaunches.has(message.launchToken))
        this.launchRegistrations.set(message.launchToken, registration);
      if (this.stopped) {
        send(socket, { ...state.controlOffer, type: 'registered' });
        this.events.emit(`created:${message.launchToken}`, record.paneId);
        return;
      }
      if (message.type === 'register') {
        const ready = { ...record, processId: message.pid, ready: true };
        if (this.managed) {
          const rows = await (this.inspectShell ?? nativeShellProcesses)(record.creationProcessId);
          ready.viewerBirth = nativeIdentity(rows.find(row => row.ProcessId === message.pid)).birth;
        }
        await writeJson(this.recordFile, ready);
        this.ownedRoles.set('todo', ready);
        send(socket, { ...state.controlOffer, type: 'registered' });
        this.events.emit(`created:${message.launchToken}`, record.paneId);
        if (this.managed && this.actor.blocked) await this.observeRegisteredRun('todo', ready);
        if (this.managed) await this.registerManagedRole('todo', () => this.nativePane(record.paneId, ready));
        if (this.managed) await this.holdRoleViewer('todo', ready);
        this.bridge?.readinessChanged();
      } else {
        this.closureVersions.set('todo', (this.closureVersions.get('todo') ?? 0) + 1);
        if (this.managed) await this.managedWrite(actor => actor.closeRole(actor.capability('todo', 'todo'),
          { paneId: record.paneId, reason: 'q' }));
        await writeJson(this.recordFile, { ...record, manualClose: true });
        this.ownedRoles.delete('todo');
        this.bridge?.readinessChanged();
        const target = this.managed ? await this.nativePane(record.paneId, record) : null;
        const reply = () => new Promise(resolve => socket.end(`${JSON.stringify({ ...state.controlOffer, type: 'closed' })}\n`, resolve));
        if (this.managed) await this.mutate('todo', 'close', target, ['close', record.paneId], null, reply);
        else { await reply(); await this.herdr('close', record.paneId); }
      }
    });
    return registration;
  }
  roleState(record, connected = true) {
    const slot = this.actor?.snapshot;
    return { schema: 'omo-herdr-dashboard/role/1', ...this.binding, scopeEpoch: this.scopeEpoch,
      ...(this.managed && this.actor ? { managedScope: { ownerNonce: this.actor.snapshot.ownerNonce,
        sessionId: this.binding.sessionId, generation: this.actor.snapshot.generation,
        participant: 'todo', lifetimeId: this.lifetimeId } } : {}),
      role: 'todo', tabId: record.tabId, launchToken: record.launchToken, paneId: record.paneId,
      ...(connected && this.managed && !this.actor?.blocked && !this.actor?.draining &&
        slot?.operations.every(operation => operation.status === 'SETTLED') &&
        slot.roles.todo?.lifetimeId === this.lifetimeId && slot.roles.todo.viewer?.pid === record.processId
        ? { custodyBinding: { stateDir: this.stateDir, slotStateDir: this.stateDir,
          slotPath: this.actor.paths.slotPath, recordPath: this.recordFile, statePath: this.stateFile,
          parent: slot.parent, ownerNonce: slot.ownerNonce, generation: slot.generation, revision: slot.revision } } : {}),
      connected, language: this.language, updatedAt: new Date().toISOString(), availability: 'waiting',
      cachePath: this.storage.path, prefsPath: `${this.stateFile}.view.json`,
      presenceOffer: connected ? this.presence.offer('todo') : null,
      controlOffer: connected ? { pipePath: this.controlPath, v: 1, token: this.controlToken,
        ownerKey: this.binding.ownerKey, sessionId: this.binding.sessionId, scopeEpoch: this.scopeEpoch,
        role: 'todo', launchToken: record.launchToken, paneId: record.paneId, statePath: this.stateFile } : null };
  }
  bind(pi) {
    const accept = event => {
      if (this.stopped || event?.v !== 1 || event.kind !== 'dag-provider' ||
        !sameDashboardOwner(event, this.binding) || !event.provider) return;
      if (this.provider?.lifetimeId === event.provider.lifetimeId) return;
      this.offSource?.();
      this.provider = event.provider;
      const provider = this.provider;
      this.source = provider.getSource();
      this.offSource = provider.subscribeSource(source => {
        if (this.stopped || this.provider !== provider) return;
        this.source = source;
        if (this.managed) { this.sourceDirty = true; this.sourceRefreshing = true; }
        this.bridge?.readinessChanged();
        void this.schedule().catch(() => {});
      });
      provider.setCoordinator(this.coordinator());
      void this.schedule().catch(() => {});
    };
    this.unsubscribers.push(pi.events.on(dashboardChannels.provider, accept),
      pi.events.on(dashboardChannels.reply, accept),
      pi.events.on(dashboardChannels.query, event => {
        if (!this.stopped && event?.v === 1 && event.kind === 'todo-owner' && sameDashboardOwner(event, this.binding))
          pi.events.emit(dashboardChannels.reply, { v: 1, requestId: event.requestId, kind: 'todo-owner',
            ...this.binding, provider: this.coordinator() });
      }),
      pi.events.on(dashboardChannels.retired, event => {
        if (sameDashboardOwner(event, this.binding) && event.lifetimeId === this.provider?.lifetimeId) {
          this.offSource?.(); this.provider = null; this.source = null; this.status = 'layout-waiting';
          this.ownedRoles.delete('dag'); this.ownedRoles.delete('workers');
          this.bridge?.readinessChanged();
        }
      }));
    this.pi = pi;
    pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'todo-owner', ...this.binding, provider: this.coordinator() });
    pi.events.emit(dashboardChannels.query, { v: 1, requestId: randomUUID(), kind: 'dag-provider', ...this.binding });
  }
  coordinator() {
    const owner = this;
    return { lifetimeId: this.lifetimeId, binding: this.binding,
      get actor() { return owner.actor; },
      join: lifetime => this.managedWrite(actor => actor.join('dag', lifetime)),
      perform: (role, type, target, dispatch) => this.perform(role, type, target, dispatch),
      mutate: (role, type, target, args, effect, beforeSubmit) => this.mutate(role, type, target, args, effect, beforeSubmit),
      target: paneId => this.currentTarget(paneId),
      reconcileLegacy: (root, reader, viewer) => this.reconcileLegacy(root, reader, viewer),
      retireRetainedRole: (retained, prepare) => this.retireRetainedRole(retained, prepare),
      registerRole: (role, readTarget) => this.registerManagedRole(role, readTarget),
      holdRoleViewer: (role, record) => this.holdRoleViewer(role, record),
      viewerDeath: role => this.viewerDeaths.get(role),
      repairedViewer: role => this.viewerDeaths.delete(role),
      observeRegisteredRun: (role, record) => this.observeRegisteredRun(role, record),
      closeRole: (role, paneId) => this.managedWrite(async actor => {
        await actor.closeRole(actor.capability(role === 'todo' ? 'todo' : 'dag', role), { paneId, reason: 'q' });
        this.ownedRoles.delete(role);
        this.bridge?.readinessChanged();
      }),
      noteRoleClosure: role => this.closureVersions.set(role, (this.closureVersions.get(role) ?? 0) + 1),
      terminalAuthority: (participant, lifetimeId, records) => this.terminalAuthority(participant, lifetimeId, records),
      ownsPublisherClaim: () => this.ownsPublisherClaim(),
      assertCurrent: () => this.assertManaged(),
      claim: { ...this.binding, lifetimeId: this.lifetimeId },
      inspectTodo: async () => {
        if (this.stopped) return null;
        const record = await readJson(this.recordFile);
        if (!this.recordMatches(record) || record.manualClose || record.scopeEpoch !== this.scopeEpoch) return null;
        if (owner.actor?.snapshot.closures?.some(entry => entry.role === 'todo' &&
          entry.paneId === record.paneId && entry.sessionId === record.sessionId &&
          entry.reason === 'pane_not_found')) return null;
        return await this.verify(record) ? record : null;
      },
      schedule: options => this.schedule(options) };
  }
  async reconcileLegacy(root, reader = legacyPaneIdentity, viewer = this.viewer) {
    const entries = await discoverLegacyRecords(root, this.binding), observations = [];
    for (const { path, record } of entries) {
      if (!roles.has(record.role) || !record.paneId || record.manualClose) continue;
      const registered = this.actor?.snapshot.roles[record.role];
      if (this.actor?.snapshot.closures.some(entry => entry.role === record.role && entry.paneId === record.paneId &&
        entry.sessionId === record.sessionId && entry.reason === 'pane_not_found')) continue;
      try { await this.herdr('get', record.paneId); }
      catch (error) {
        if (!authoritativePaneNotFound(error)) throw blocked(error);
        if (!this.actor) throw blocked('legacy tombstone requires held owner');
        await this.managedWrite(actor => actor.obsoleteLocator(actor.capability(record.role === 'todo' ? 'todo' : 'dag', record.role), record));
        observations.push({ path, paneId: record.paneId, state: 'obsolete', code: error.code });
        continue;
      }
      if (registered?.generation === this.actor.snapshot.generation && registered.paneId === record.paneId ||
        this.ownedRoles.get(record.role)?.launchToken === record.launchToken && record.scopeEpoch === this.scopeEpoch) continue;
      if (typeof this.node === 'function') this.node = await this.node();
      if (record.schema !== 'omo-herdr-dashboard/pane/1' ||
        pathKey(record.viewerPath) !== pathKey(viewer) || pathKey(record.nodePath) !== pathKey(this.node))
        throw blocked('legacy executable or viewer source mismatch');
      const member = await this.membership(record.paneId);
      if (member.tabId !== record.tabId || record.paneId === this.binding.parentPaneId)
        throw blocked('legacy membership changed');
      const info = await this.herdr('process-info', '--pane', record.paneId);
      let identity = await reader(info, record, this.inspectShell), empty = false;
      // A successor has no old in-memory death observer. A held claim with
      // settled predecessor effects may reuse only that registered empty shell;
      // it cannot adopt an unregistered record or retire a guessed viewer PID.
      if (!identity && this.claimRetired && this.ownsPublisherClaim() &&
        !this.actor.blocked && !this.actor.draining && registered?.generation < this.actor.snapshot.generation &&
        registered.paneId === record.paneId && registered.sessionId === record.sessionId &&
        registered.statePath === record.statePath && registered.launchToken === record.launchToken &&
        registered.viewer?.pid === record.processId && registered.viewer.birth === record.viewerBirth &&
        pathKey(registered.viewer.executable) === pathKey(record.nodePath) &&
        this.actor.snapshot.operations.every(operation => operation.status === 'SETTLED')) {
        const observed = await observePaneShell(info, record, this.inspectShell);
        const foreground = info.process_info.foreground_processes ?? [];
        if (observed && !observed.children.length && foreground.length === 1 &&
          foreground[0].pid === record.creationProcessId && observed.shell.Birth === registered.shell.birth &&
          observed.shell.ProcessId === registered.shell.pid) {
          identity = { shell: nativeIdentity(observed.shell) }; empty = true;
        }
      }
      if (!identity) throw blocked('legacy shell or viewer identity unverified');
      const state = await readJson(record.statePath);
      if (!state || !sameDashboardOwner(state, record) || state.role !== record.role ||
        state.paneId !== record.paneId || state.launchToken !== record.launchToken)
        throw blocked('legacy role state changed');
      if (empty && (state.managedScope?.generation !== registered.generation ||
        state.managedScope.sessionId !== registered.sessionId ||
        state.managedScope.participant !== registered.participant ||
        state.managedScope.lifetimeId !== registered.lifetimeId ||
        registered.prefsPath !== state.prefsPath ||
        registered.cachePath !== (record.role === 'todo' ? state.cachePath : record.statePath)))
        throw blocked('empty retained role source is outside predecessor claim');
      if (record.sessionId !== this.binding.sessionId && (!this.claimRetired ||
        registered?.paneId !== record.paneId || registered.sessionId !== record.sessionId ||
        registered.statePath !== record.statePath || registered.launchToken !== record.launchToken ||
        registered.shell.pid !== identity.shell.pid || registered.shell.birth !== identity.shell.birth ||
        !empty && JSON.stringify(registered.viewer) !== JSON.stringify(identity.viewer)))
        throw blocked('prior legacy conversation retirement or native role binding unverified');
      if (record.prepared && !identity.viewer || this.claimRetired && registered?.paneId === record.paneId) {
        const retained = { path, record, paneId: record.paneId, state: 'retained', identity, empty };
        if (record.sessionId !== this.binding.sessionId || empty) {
          retained.target = Object.fromEntries(['paneId', 'tabId', 'shell', ...(empty ? [] : ['viewer']), 'statePath',
            'sourcePath', 'cachePath', 'prefsPath', 'launchToken', 'controlToken'].map(key => [key, registered[key]]));
          this.retainedTargets.set(record.paneId, retained);
        }
        observations.push(retained);
        continue;
      }
      const request = { stateDir: root, recordPath: path, parent: this.actor.snapshot.parent,
        herdr: this.herdr, slotPath: this.actor.paths.slotPath, slotStateDir: this.stateDir };
      let capture = await this.legacyObservation(path, request);
      let retirement = await observeLegacyRetirement(capture, request);
      if (!retirement && this.recoveryRetry && this.legacyObservationState(capture) === 'invalid') {
        capture = await this.legacyObservation(path, request);
        retirement = await observeLegacyRetirement(capture, request);
      }
      if (!retirement) throw blocked('legacy producer retirement and settled effects unverified');
      observations.push({ path, paneId: record.paneId, identity, retirement });
    }
    return observations;
  }
  async observeRetainedTarget(retained) {
    const { record, identity, target } = retained;
    const member = await this.membership(record.paneId);
    const state = await readRoleState(record.statePath);
    if (member.tabId !== record.tabId || !state || !sameDashboardOwner(state, record) ||
      state.role !== record.role || state.paneId !== record.paneId ||
      state.launchToken !== record.launchToken || state.scopeEpoch !== record.scopeEpoch)
      throw blocked('retained role source changed');
    const info = await this.herdr('process-info', '--pane', record.paneId);
    let actual;
    if (retained.empty) {
      const observation = await observePaneShell(info, record, this.inspectShell);
      const foreground = info.process_info.foreground_processes ?? [];
      if (observation && !observation.children.length && foreground.length === 1 &&
        foreground[0].pid === record.creationProcessId) actual = { shell: nativeIdentity(observation.shell) };
    } else actual = await legacyPaneIdentity(info, record, this.inspectShell);
    if (JSON.stringify(actual) !== JSON.stringify(identity)) throw blocked('retained role native identity changed');
    return structuredClone(target);
  }
  async holdRoleViewer(role, record) {
    const target = role === 'todo' ? await this.nativePane(record.paneId, record) : await this.provider.observeTarget(record);
    const old = this.viewerHolders.get(role);
    if (old && JSON.stringify(old.identity) === JSON.stringify(target.viewer)) return;
    const observer = await observeNativeExit(target.viewer, true);
    if (old) await old.observer.dispose();
    this.viewerHolders.set(role, { identity: target.viewer, target, record, observer });
  }
  async observeViewerDeath(role) {
    const held = this.viewerHolders.get(role);
    if (!held || this.viewerDeaths.has(role) || this.stopped) return;
    const exit = await held.observer.death();
    if (exit.disposed || !Number.isInteger(exit.exitCode) || this.stopped ||
      this.viewerHolders.get(role) !== held) return;
    this.viewerDeaths.set(role, { ...held, exit });
    if (role === 'todo') this.custodyLost = false;
    this.recoveryChanged = true;
    void this.schedule().catch(() => {});
  }
  async retireRetainedRole(retained, prepare) {
    const { record, identity, target } = retained;
    const before = (await this.herdr('layout', '--pane', record.paneId))?.layout;
    const layoutBinding = layout => JSON.stringify(layout && {
      tabId: layout.tab_id, workspaceId: layout.workspace_id, area: layout.area,
      zoomed: layout.zoomed, focusedPaneId: layout.focused_pane_id,
      panes: layout.panes?.map(pane => ({ id: pane.pane_id, rect: pane.rect })),
      splits: layout.splits,
    });
    if (before?.tab_id !== record.tabId || !before.panes?.some(pane => pane.pane_id === record.paneId))
      throw blocked('retained retirement geometry unavailable');
    await this.managedWrite(async () => {
      await this.observeRetainedTarget(retained);
      await prepare();
    });
    if (retained.empty) {
      const member = await this.membership(record.paneId);
      const observation = await observePaneShell(await this.herdr('process-info', '--pane', record.paneId), record, this.inspectShell);
      if (member.tabId !== record.tabId || !observation || observation.children.length ||
        JSON.stringify(nativeIdentity(observation.shell)) !== JSON.stringify(identity.shell) ||
        layoutBinding((await this.herdr('layout', '--pane', record.paneId))?.layout) !== layoutBinding(before))
        throw blocked('empty retained shell or geometry changed before relaunch');
      this.retainedTargets.delete(record.paneId);
      return;
    }
    await this.perform(record.role, 'retire', target, async () => {
      const receipt = await retireVerifiedViewer(record, identity);
      if (receipt.manual) throw blocked('manual closure superseded retirement');
      const member = await this.membership(record.paneId);
      const info = await this.herdr('process-info', '--pane', record.paneId);
      const observation = await observePaneShell(info, record, this.inspectShell);
      if (member.tabId !== record.tabId || !observation || observation.children.length ||
        JSON.stringify(nativeIdentity(observation.shell)) !== JSON.stringify(identity.shell) ||
        layoutBinding((await this.herdr('layout', '--pane', record.paneId))?.layout) !== layoutBinding(before))
        throw blocked('original viewer exit did not retain the exact shell and geometry');
      this.retainedTargets.delete(record.paneId);
      return { result: receipt, effects: Promise.resolve() };
    });
  }
  async replaceRetainedTodo(retained) {
    const old = retained.record;
    const record = { ...old, ...this.binding, scopeEpoch: this.scopeEpoch,
      statePath: this.stateFile, launchToken: randomBytes(24).toString('hex'),
      prepared: true, ready: false, manualClose: false, layoutClaim: this.claim };
    delete record.processId; delete record.viewerBirth;
    await this.retireRetainedRole(retained, () => this.roleWrite(async () => {
      await writeJson(this.recordFile, record);
      await writeJson(this.stateFile, this.roleState(record));
    }));
    return this.launchTodo(record);
  }
  legacyObservationState(observation) {
    const captured = retirementCaptures.get(observation);
    return captured?.alive() && !captured.invalid ? 'pending' : 'invalid';
  }
  captureLegacyProducer(request) { return captureLegacyProducer(request); }
  async legacyObservation(path, request) {
    let capture = this.legacyObservations.get(path);
    if (capture && this.recoveryRetry && this.legacyObservationState(capture) === 'invalid') {
      await capture.dispose();
      this.legacyObservations.delete(path);
      capture = null;
    }
    if (!capture) {
      capture = await this.captureLegacyProducer(request);
      this.legacyObservations.set(path, capture);
      void capture.release().then(() => {
        if (!this.stopped) { this.recoveryChanged = true; void this.schedule().catch(() => {}); }
      }, () => {});
    }
    return capture;
  }
  async observeRegisteredRun(role, record) {
    const operation = this.actor.snapshot.operations.find(op => op.status === 'UNKNOWN' && op.type === 'run' &&
      op.role === role && op.target.paneId === record.paneId && op.target.launchToken === record.launchToken &&
      op.ownerNonce === this.actor.snapshot.ownerNonce && op.generation === this.actor.snapshot.generation &&
      op.lifetimeId === this.actor.snapshot.participants[op.participant]?.lifetimeId);
    const retained = operation && this.effectObservations.get(operation.id);
    if (!retained || this.stopped || this.actor.draining || !this.actor.leaseHeld) return;
    const actual = await this.observeManaged({ target: operation.target });
    if (JSON.stringify(actual.target) !== JSON.stringify(operation.target)) return;
    retained.settled = true;
    this.recoveryChanged = true;
    void this.schedule().catch(() => {});
  }
  watchRecoveryMembership() {
    if (this.recoveryWatch || this.stopped || !this.actor) return this.recoveryWatch?.ready;
    this.recoveryWatch = { ready: (async () => {
      const before = (await this.herdr('layout', '--pane', this.binding.parentPaneId))?.layout;
      if (before?.tab_id !== this.actor.snapshot.parent.tabId) throw blocked('recovery membership unavailable');
      let members = before.panes.map(pane => pane.pane_id).sort().join('\n');
      const socket = net.createConnection(process.platform === 'win32'
        ? `\\\\.\\pipe\\${this.binding.socketPath}` : this.binding.socketPath);
      this.recoveryWatch.socket = socket;
      let accept, reject;
      const ready = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
      const signal = AbortSignal.any([this.stopSignal.signal, AbortSignal.timeout(10000)]), id = randomUUID();
      const abort = () => { reject(signal.reason); socket.destroy(); };
      signal.addEventListener('abort', abort, { once: true });
      socket.once('error', reject);
      socket.once('close', () => reject(blocked('recovery subscription closed')));
      socket.once('connect', () => send(socket, { id, method: 'events.subscribe',
        params: { subscriptions: [{ type: 'layout.updated' }] } }));
      receive(socket, message => {
        if (message.id === id && message.error) reject(blocked(message.error.code));
        if (message.id === id && message.result?.type === 'subscription_started') accept();
        const layout = message.event === 'layout_updated' && message.data?.layout;
        if (layout?.tab_id !== before.tab_id || !layout.panes?.some(pane => pane.pane_id === this.binding.parentPaneId)) return;
        const current = layout.panes.map(pane => pane.pane_id).sort().join('\n');
        if (current === members) return;
        members = current;
        if (!this.stopped && this.recoveryBlocked) {
          this.recoveryChanged = true;
          void this.schedule().catch(() => {});
        }
      });
      try { await ready; } finally { signal.removeEventListener('abort', abort); }
    })() };
    this.recoveryWatch.ready.catch(() => {});
    return this.recoveryWatch.ready;
  }
  schedule({ forceRoles = [] } = {}) {
    const closureVersions = new Map(this.closureVersions);
    return this.enqueue(async () => {
      const forceCurrent = role => forceRoles.includes(role) &&
        (closureVersions.get(role) ?? 0) === (this.closureVersions.get(role) ?? 0);
      if (this.managed) {
        if (this.recoveryBlocked && !forceRoles.length && !this.recoveryChanged)
          throw blocked('recovery awaits relevant membership/control change or explicit dashboard');
        const retry = forceRoles.length || this.recoveryChanged;
        this.recoveryRetry = Boolean(retry);
        this.recoveryChanged = false;
        if (this.actor?.blocked && retry) {
          for (const operation of this.actor.snapshot.operations.filter(op => op.status === 'UNKNOWN'))
            await this.actor.reconcile(operation.id);
        }
        this.assertManaged();
        try {
          const retainedTodo = await this.reconcileLegacy(this.stateDir);
          for (const retained of retainedTodo) if ((retained.record?.sessionId !== this.binding.sessionId || retained.empty) &&
            retained.state === 'retained') await this.replaceRetainedTodo(retained);
          const provider = this.provider;
          if (provider) {
            await provider.sourceReady;
            if (this.stopped || this.provider !== provider) return;
            await this.managedWrite(actor => actor.join('dag', provider.lifetimeId));
            const retainedPair = await provider.preflightRecovery?.();
            await provider.replaceRetained?.(retainedPair);
          }
          this.recoveryBlocked = false;
        } catch (error) {
          this.recoveryBlocked = true;
          await this.watchRecoveryMembership().catch(() => {});
          throw error;
        }
      }
      // Existing Todo must receive a new scope/offer even if a sibling role
      // was manually closed. Layout anchors only govern creation, not rebinding.
      const existing = await this.ensureTodo(null, false);
      const provider = this.provider;
      if (!provider) { this.status = 'layout-waiting'; return; }
      await provider.sourceReady;
      if (this.stopped || this.provider !== provider) return;
      if (this.managed) {
        await this.managedWrite(actor => actor.join('dag', provider.lifetimeId));
        if (this.sourceDirty || forceRoles.length) {
          this.sourceRefreshing = true;
          await this.managedWrite(async actor => {
            for (const role of ['todo', 'dag', 'workers']) if (actor.snapshot.roles[role]) {
              const retained = actor.snapshot.roles[role];
              if (actor.snapshot.closures.some(entry => entry.role === role && entry.paneId === retained.paneId &&
                entry.sessionId === retained.sessionId)) {
                const observation = await this.observeManaged({ locator: retained });
                if (observation.missing?.code === 'pane_not_found' && observation.missing.paneId === retained.paneId) continue;
              }
              const target = role === 'todo' ? await this.nativePane(actor.snapshot.roles.todo.paneId, await readJson(this.recordFile))
                : await provider.observeTarget(actor.snapshot.roles[role]);
              await actor.registerRole(actor.capability(role === 'todo' ? 'todo' : 'dag', role), target);
            }
          });
          const offers = Object.fromEntries(['todo', 'dag', 'workers'].map(role => [role, this.presence.rotateRole(role)]));
          await provider.setOffers(offers);
          const record = await readJson(this.recordFile);
          if (this.recordMatches(record) && record.paneId) await this.roleWrite(() => writeJson(this.stateFile, this.roleState(record)));
          this.bridge.invalidate();
          await this.presence.idle();
          this.sourceDirty = false; this.sourceRefreshing = false;
        }
      }
      const { tabId } = await this.membership(this.binding.parentPaneId);
      const claim = { ...this.binding, tabId, lifetimeId: this.lifetimeId, layout: 'columns' };
      this.claim = claim;
      if (this.managed && !existing && !await readJson(this.recordFile)) {
        await this.ensureTodo({ ...this.binding, paneId: this.binding.parentPaneId, tabId, initial: true }, false);
      }
      const offers = { dag: this.presence.offer('dag'), workers: this.presence.offer('workers') };
      const pair = await provider.openPair({ force: forceCurrent('dag') || forceCurrent('workers'),
        forceRoles: ['dag', 'workers'].filter(forceCurrent), forceCurrent, offers, claim });
      if (this.stopped || this.provider !== provider) return;
      for (const role of ['dag', 'workers']) {
        const record = pair?.[role];
        if (record?.role === role && sameDashboardOwner(record, this.binding) &&
          record.scopeEpoch === this.scopeEpoch && record.tabId === tabId && record.ready === true &&
          record.manualClose !== true && Number.isSafeInteger(record.processId)) this.ownedRoles.set(role, record);
        else this.ownedRoles.delete(role);
      }
      this.bridge?.readinessChanged();
      if (!pair?.workers || pair.workers.role !== 'workers' || !sameDashboardOwner(pair.workers, this.binding) ||
        pair.workers.tabId !== tabId) {
        this.status = 'layout-waiting'; return;
      }
      await this.membership(pair.workers.paneId);
      if (!existing || forceCurrent('todo')) await this.ensureTodo(pair.workers, forceCurrent('todo'));
      await provider.arrangeDashboard?.();
    });
  }
  async ensureTodo(anchor, force) {
    if (force) await this.roleTail;
    let record = await readJson(this.recordFile);
    if (record && !this.recordMatches(record)) {
      if (this.managed) throw blocked('retained Todo record identity changed');
      this.status = 'layout-waiting'; return;
    }
    if (record?.manualClose && !force) return;
    if (record?.paneId && record.prepared && !record.processId) {
      const member = await this.membership(record.paneId);
      const identity = member.tabId === record.tabId &&
        await legacyPaneIdentity(await this.herdr('process-info', '--pane', record.paneId), record, this.inspectShell);
      if (!identity || identity.viewer) throw blocked('PREPARED shell changed or occupied');
      const state = await readRoleState(this.stateFile);
      if (!state || !sameDashboardOwner(state, record) || state.paneId !== record.paneId ||
        state.launchToken !== record.launchToken) throw blocked('PREPARED source changed');
      record = { ...record, scopeEpoch: this.scopeEpoch, layoutClaim: this.claim };
      await this.roleWrite(async () => {
        await writeJson(this.recordFile, record);
        await writeJson(this.stateFile, this.roleState(record));
      });
      return this.launchTodo(record);
    }
    if (record?.paneId) {
      let process;
      try { process = await this.verify(record); } catch (error) {
        if (!/missing or ambiguous/.test(error.message)) throw error;
      }
      if (process) {
        record = await this.roleWrite(async () => {
          const current = await readJson(this.recordFile);
          if (this.stopped || current.launchToken !== record.launchToken || current.manualClose && !force) return null;
          const next = { ...current, scopeEpoch: this.scopeEpoch, layoutClaim: this.claim,
            processId: process.pid, ready: true, manualClose: false };
          await writeJson(this.recordFile, next);
          await writeJson(this.stateFile, this.roleState(next));
          return next;
        });
        if (!record) return;
        const registered = !this.managed || await this.registerManagedRole('todo', async () => {
          try { return await this.nativePane(record.paneId, record); }
          catch (error) {
            const death = this.viewerDeaths.get('todo');
            if (error.cause !== 'role viewer changed' || !this.ownsPublisherClaim() ||
              this.actor.snapshot.operations.some(operation => operation.status !== 'SETTLED') ||
              !death || death.exit.disposed !== false || !Number.isInteger(death.exit.exitCode) ||
              !sameDashboardOwner(death.record, record) || death.record.scopeEpoch !== record.scopeEpoch ||
              death.record.launchToken !== record.launchToken || death.identity.pid !== record.processId ||
              death.identity.birth !== record.viewerBirth ||
              JSON.stringify(death.identity) !== JSON.stringify(this.actor.snapshot.roles.todo?.viewer)) throw error;
            return null;
          }
        }) !== false;
        if (registered) {
          this.ownedRoles.set('todo', record);
          this.bridge?.readinessChanged();
          this.status = 'current'; return record.paneId;
        }
      }
      const panes = (await this.herdr('list'))?.panes ?? [];
      if (panes.some(pane => pane.pane_id === record.paneId)) {
        const death = this.managed && this.viewerDeaths.get('todo');
        if (death && death.record.launchToken === record.launchToken &&
          death.identity.pid === record.processId && death.identity.birth === record.viewerBirth) {
          const info = await this.herdr('process-info', '--pane', record.paneId);
          const observed = await observePaneShell(info, record, this.inspectShell);
          if (!observed || observed.children.length || observed.shell.Birth !== death.target.shell.birth)
            throw blocked('dead viewer did not leave the original empty shell');
          const next = { ...record, launchToken: randomBytes(24).toString('hex'), prepared: true, ready: false };
          delete next.processId; delete next.viewerBirth;
          await this.roleWrite(async () => {
            const current = await readJson(this.recordFile);
            if (current.manualClose) throw blocked('manual closure superseded viewer repair');
            await writeJson(this.recordFile, next); await writeJson(this.stateFile, this.roleState(next));
          });
          this.viewerDeaths.delete('todo');
          this.bridge?.invalidate(); await this.presence.idle();
          return this.launchTodo(next);
        }
        if (this.managed) throw blocked('retained Todo native identity unverified');
        this.status = 'layout-waiting'; return;
      }
      if (this.managed) {
        await this.managedWrite(actor => actor.obsoleteLocator(actor.capability('todo', 'todo'), record));
        if (!force) return;
      }
      if (!force) { await writeJson(this.recordFile, { ...record, manualClose: true }); return; }
    } else if (record?.attempted && !force) return;
    if (!anchor) return;
    const { tabId } = await this.membership(anchor.paneId);
    if (tabId !== anchor.tabId) { this.status = 'layout-waiting'; return; }
    if (typeof this.node === 'function') this.node = await this.node();
    const launchToken = randomBytes(24).toString('hex');
    record = { schema: 'omo-herdr-dashboard/pane/1', ...this.binding, scopeEpoch: this.scopeEpoch, role: 'todo',
      statePath: this.stateFile, viewerPath: this.viewer, tabId, launchToken,
      nodePath: this.node, layoutClaim: this.claim, attempted: true, ready: false, manualClose: false };
    await writeJson(this.recordFile, record);
    if (this.stopped) return;
    const split = await this.mutate('todo', 'split', this.managed ? await this.currentTarget(anchor.paneId) : null,
      ['split', '--pane', anchor.paneId, '--direction', anchor.initial ? 'right' : 'down',
        '--ratio', anchor.initial ? '0.6' : '0.5', '--cwd', this.cwd, '--no-focus']);
    if (!split?.pane?.pane_id) throw new Error('Owned Todo split returned no pane ID');
    record.paneId = split.pane.pane_id;
    await this.membership(record.paneId);
    const createdInfo = await this.herdr('process-info', '--pane', record.paneId);
    record.creationProcessId = createdInfo?.process_info?.shell_pid;
    const shell = await observePaneShell(createdInfo, record, this.inspectShell);
    if (shell) { record.creationDate = shell.shell.CreationDate; if (this.managed) record.creationBirth = shell.shell.Birth; }
    record.prepared = true;
    await writeJson(this.recordFile, record);
    await writeJson(this.stateFile, this.roleState(record));
    return this.launchTodo(record);
  }
  async launchTodo(record) {
    const launchToken = record.launchToken;
    const abort = new AbortController();
    const creation = once(this.events, `created:${launchToken}`,
      { signal: AbortSignal.any([abort.signal, ...(this.managed ? [] : [this.stopSignal.signal]), AbortSignal.timeout(10000)]) });
    creation.catch(() => {});
    this.pendingLaunches.add(launchToken);
    try {
      await this.mutate('todo', 'run', this.managed ? await this.nativePane(record.paneId, record) : null,
        ['run', record.paneId, shellCommand([this.node, this.viewer, '--state', this.stateFile,
          '--close-pane', record.paneId, '--launch-token', launchToken])], creation);
      await creation;
      if (this.managed) {
        const registration = this.launchRegistrations.get(launchToken);
        if (!registration) throw blocked('authenticated launch registration missing');
        await registration;
      }
      if (!this.stopped) this.status = 'current';
      return record.paneId;
    } catch (error) {
      if (this.managed) throw error;
      const current = await readJson(this.recordFile);
      if (!this.stopped && current?.launchToken === launchToken && Number.isSafeInteger(record.creationProcessId)) {
        await this.membership(record.paneId);
        const info = await this.herdr('process-info', '--pane', record.paneId);
        if (await canCleanupPane(info, record, this.inspectShell)) {
          await this.herdr('close', record.paneId);
          await writeJson(this.recordFile, { ...current, paneId: null, ready: false, failed: true });
        }
      }
      throw error;
    } finally { this.pendingLaunches.delete(launchToken); this.launchRegistrations.delete(launchToken); abort.abort(); }
  }
  rebase(ctx) {
    return this.enqueue(async () => {
      await this.roleWrite(() => {
        if (this.stopped) return;
        this.bridge?.observe({ type: 'session_tree' }, ctx);
        this.ctx = ctx;
        this.scopeEpoch++;
        this.ownedRoles.clear();
        this.presence.rebase({ ...this.binding, scopeEpoch: this.scopeEpoch });
        this.bridge?.observe(null, ctx);
      });
      await this.presence.idle();
    }).then(() => this.schedule());
  }
  ownsPublisherClaim() {
    const slot = this.actor?.snapshot, scope = this.publisherScope;
    return Boolean(this.actor?.leaseHeld && scope &&
      scope.lifetimeId === this.lifetimeId && scope.sessionId === this.binding.sessionId &&
      slot.ownerNonce === scope.ownerNonce && slot.generation === scope.generation &&
      slot.sessionId === scope.sessionId && slot.participants.todo?.lifetimeId === scope.lifetimeId &&
      slot.producer.pid === process.pid && JSON.stringify(slot.producer) === JSON.stringify(scope.producer) &&
      JSON.stringify(slot.parent) === JSON.stringify(scope.parent));
  }
  async terminalAuthority(participant, lifetimeId, records) {
    if (!this.ownsPublisherClaim()) return false;
    const slot = this.actor.snapshot;
    if (slot.participants[participant]?.lifetimeId !== lifetimeId) return false;
    const observed = await this.observeManaged({});
    if (JSON.stringify(observed.parent) !== JSON.stringify(slot.parent) ||
      JSON.stringify(observed.producer) !== JSON.stringify(slot.producer)) return false;
    for (const record of records) {
      const role = slot.roles[record.role];
      const state = await readRoleState(record.statePath);
      if (!role || role.participant !== participant || role.lifetimeId !== lifetimeId ||
        role.generation !== slot.generation || role.sessionId !== slot.sessionId ||
        record.scopeEpoch !== state?.scopeEpoch || role.paneId !== record.paneId ||
        role.statePath !== record.statePath || role.launchToken !== record.launchToken ||
        state?.managedScope?.ownerNonce !== slot.ownerNonce ||
        state.managedScope.generation !== slot.generation || state.managedScope.sessionId !== slot.sessionId ||
        state.managedScope.participant !== participant || state.managedScope.lifetimeId !== lifetimeId)
        return false;
      const target = Object.fromEntries(['paneId', 'tabId', 'shell', 'viewer', 'statePath', 'sourcePath',
        'cachePath', 'prefsPath', 'launchToken', 'controlToken'].map(key => [key, role[key]]));
      const native = await this.observeManaged({ target });
      if (JSON.stringify(native.parent) !== JSON.stringify(slot.parent) ||
        JSON.stringify(native.producer) !== JSON.stringify(slot.producer) ||
        JSON.stringify(native.target) !== JSON.stringify(target)) return false;
    }
    return this.ownsPublisherClaim() && this.actor.snapshot.participants[participant]?.lifetimeId === lifetimeId;
  }
  async stop() {
    if (this.stopping) return this.stopping;
    if (this.stopped) return;
    this.stopped = true;
    const provider = this.provider;
    const ownedClaim = this.ownsPublisherClaim();
    const releasing = ownedClaim ? this.actor.release() : null;
    releasing?.catch(() => {});
    const peerDrain = this.managed && ownedClaim && provider &&
      provider?.lifetimeId === this.actor.snapshot.participants.dag?.lifetimeId ? provider.drain() : null;
    this.stopSignal.abort();
    this.recoveryWatch?.socket?.destroy();
    this.offSource?.(); this.offReadiness?.();
    this.ownedRoles.clear();
    if (this.onPresenceEvent) this.presence?.events.off('event', this.onPresenceEvent);
    for (const off of this.unsubscribers) off();
    this.pi?.events.emit(dashboardChannels.retired, { v: 1, ...this.binding, lifetimeId: this.lifetimeId });
    this.bridge?.remove();
    this.stopping = (async () => {
    await this.tail;
    await Promise.allSettled([...this.controlJobs]);
    await this.roleTail;
    let terminalFailure;
    try {
      const record = await readJson(this.recordFile);
      if (this.storage && this.recordMatches(record) && record.paneId &&
        (!this.managed || record.scopeEpoch === this.scopeEpoch && !record.manualClose &&
          await this.terminalAuthority('todo', this.lifetimeId, [record])))
        await writeJson(this.stateFile, this.roleState(record, false));
    } catch (error) { terminalFailure = error; }
    finally {
      for (const socket of this.controlSockets) if (!this.retirementSubscribers.has(socket)) socket.destroy();
      await this.presence?.close();
    }
    try {
      await this.managedTail;
      await peerDrain;
      if (ownedClaim && this.ownsPublisherClaim()) await this.actor.drain('todo', this.lifetimeId);
      await releasing;
      if (this.actor?.snapshot.phase === 'RELEASED') for (const [socket, subscriber] of this.retirementSubscribers) {
        send(socket, { ...subscriber.offer, type: 'released', nonce: subscriber.nonce, slot: this.actor.snapshot,
          recordSHA256: subscriber.recordSHA256,
          stateSHA256: createHash('sha256').update(await readFile(this.stateFile)).digest('hex') });
      }
    } finally {
      for (const socket of this.controlSockets) socket.end();
      if (this.control?.listening) await new Promise(resolve => this.control.close(resolve));
      await Promise.all([...this.legacyObservations.values()].map(value => value.dispose()));
      await Promise.all([...this.viewerHolders.values()].map(value => value.observer.dispose()));
    }
    if (terminalFailure) throw terminalFailure;
    })();
    return this.stopping;
  }
}
