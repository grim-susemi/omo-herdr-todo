// Standalone SQLite multiprocess lease fixtures (test infrastructure only).
//
// Proves, with the built-in node:sqlite DatabaseSync on a real OS process
// boundary:
//   - journal_mode=DELETE, busy_timeout=0, process-lifetime BEGIN EXCLUSIVE
//   - real multiprocess exclusion: holder A makes claimant B get SQLITE_BUSY
//   - graceful release lets the actual successor acquire
//   - identity-bound forced termination releases to a real successor
//   - OS-authority identity binding: PID + exact creation FILETIME + image +
//     full command line queried through an actual held native process handle;
//     the child's own monotonic stamp is a nonce only, never birth authority
//   - rejection before action of wrong birth / reused-PID shape / argv /
//     exe, and no invented kill of an absent PID
//   - crash after db creation / before claim, corrupt fixture, and no
//     file-delete takeover
//
// Identity rules follow the windows-owned-process-identity-closure skill:
// never kill by PID alone; acquire OpenProcess first, validate and terminate
// through that same handle, including its creation time and liveness.
// A no-match is refusal, an absent process is recorded as
// absence, never as a kill. No WAL, no busy retries, no sleeps; every wait
// is an IPC/process-event subscription with a bounded rejection deadline.

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUSY_ERRCODE = 5;
export const FIXTURE_PATH = fileURLToPath(import.meta.url);

export class LeaseBusyError extends Error {
  constructor(cause) {
    super(`lease busy (SQLITE_BUSY): ${cause.message}`);
    this.name = 'LeaseBusyError';
    this.code = 'LEASE_BUSY';
    this.errcode = cause.errcode;
    this.cause = cause;
  }
}

export class OsIdentityMismatchError extends Error {
  constructor(recorded, presented, field) {
    super(`os identity mismatch on ${field}: recorded=${JSON.stringify(recorded)} presented=${JSON.stringify(presented)}`);
    this.name = 'OsIdentityMismatchError';
    this.code = 'OS_IDENTITY_MISMATCH';
    this.field = field;
  }
}

export class ProcessAbsentError extends Error {
  constructor(pid) {
    super(`os process ${pid} is absent — absence recorded, no kill performed or invented`);
    this.name = 'ProcessAbsentError';
    this.code = 'OS_PROCESS_ABSENT';
  }
}

export function isBusyError(err) {
  return err?.code === 'ERR_SQLITE_ERROR' && err?.errcode === BUSY_ERRCODE;
}

// ---- OS identity (kernel-authoritative, queried independently) ----

function psRun(script) {
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  return out.trim();
}

// All identity fields, liveness, termination and wait use the one OpenProcess
// handle. FILETIME remains a decimal string (100ns since 1601), never rounded
// through JS Number, epoch milliseconds or CIM datetime conversion.
const nativeAdapter = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public class HandleReceipt {
  public int status;
  public uint pid;
  public long parentPid;
  public string birth;
  public string exe;
  public string cl;
  public string handle;
  public bool live;
  public bool terminated;
  public uint? wait;
  public uint? exitCode;
  public bool closed;
  public string birthUnits = "FILETIME-100ns-since-1601";
}
public static class OwnedNativeProcess {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessId(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long birth, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder image, ref uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int infoClass, IntPtr buffer, uint length, out uint needed);
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString {
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicInformation {
    public IntPtr Reserved1;
    public IntPtr Peb;
    public IntPtr Reserved2;
    public IntPtr Reserved3;
    public IntPtr ProcessId;
    public IntPtr ParentId;
  }
  static void Check(bool ok) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  static string CommandLine(IntPtr h) {
    uint needed;
    // ProcessCommandLineInformation: the counted UNICODE_STRING is returned
    // for this handle; no PID lookup, CIM row or remote PEB pointer traversal.
    int status = NtQueryInformationProcess(h, 60, IntPtr.Zero, 0, out needed);
    if (status != unchecked((int)0xC0000004) || needed == 0)
      throw new InvalidOperationException("command-line size NTSTATUS=" + status);
    IntPtr buffer = Marshal.AllocHGlobal(checked((int)needed));
    try {
      status = NtQueryInformationProcess(h, 60, buffer, needed, out needed);
      if (status != 0) throw new InvalidOperationException("command-line NTSTATUS=" + status);
      UnicodeString value = (UnicodeString)Marshal.PtrToStructure(buffer, typeof(UnicodeString));
      return Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  static long Parent(IntPtr h) {
    uint needed;
    uint size = (uint)Marshal.SizeOf(typeof(BasicInformation));
    IntPtr buffer = Marshal.AllocHGlobal((int)size);
    try {
      int status = NtQueryInformationProcess(h, 0, buffer, size, out needed);
      if (status != 0) throw new InvalidOperationException("basic-information NTSTATUS=" + status);
      return ((BasicInformation)Marshal.PtrToStructure(buffer, typeof(BasicInformation))).ParentId.ToInt64();
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static HandleReceipt Run(uint acquisitionPid, bool terminate, uint expectedPid, string expectedBirth, string expectedExe, string expectedCommandLine) {
    HandleReceipt r = new HandleReceipt();
    // QUERY_LIMITED_INFORMATION + QUERY_INFORMATION + SYNCHRONIZE; add
    // PROCESS_TERMINATE only for the action path. This is the sole acquisition.
    IntPtr h = OpenProcess(0x1000 | 0x0400 | 0x00100000 | (terminate ? 1u : 0u), false, acquisitionPid);
    if (h == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (error == 87) { r.status = 10; return r; }
      throw new Win32Exception(error);
    }
    r.handle = h.ToInt64().ToString();
    try {
      r.pid = GetProcessId(h);
      Check(r.pid != 0);
      long birth, exit, kernel, user;
      Check(GetProcessTimes(h, out birth, out exit, out kernel, out user));
      r.birth = birth.ToString(System.Globalization.CultureInfo.InvariantCulture);
      r.wait = WaitForSingleObject(h, 0);
      uint observedExit;
      if (r.wait == 0) {
        Check(GetExitCodeProcess(h, out observedExit));
        r.exitCode = observedExit;
        r.status = 14;
        return r;
      }
      if (r.wait != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
      r.live = true;
      // Creation time is checked before querying potentially unavailable image
      // and argv on a replaced/exited execution.
      if (terminate && r.birth != expectedBirth) { r.status = 11; return r; }
      if (terminate && r.pid != expectedPid) { r.status = 16; return r; }
      StringBuilder image = new StringBuilder(32768);
      uint length = (uint)image.Capacity;
      Check(QueryFullProcessImageName(h, 0, image, ref length));
      r.exe = image.ToString();
      r.cl = CommandLine(h);
      r.parentPid = Parent(h);
      if (terminate && !String.Equals(r.exe, expectedExe, StringComparison.Ordinal)) { r.status = 12; return r; }
      if (terminate && !String.Equals(r.cl, expectedCommandLine, StringComparison.Ordinal)) { r.status = 13; return r; }
      if (terminate) {
        r.wait = WaitForSingleObject(h, 0);
        if (r.wait == 0) { r.status = 14; r.live = false; return r; }
        if (r.wait != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
        Check(TerminateProcess(h, 1));
        r.terminated = true;
        r.wait = WaitForSingleObject(h, 5000);
        if (r.wait != 0) { r.status = 15; return r; }
        Check(GetExitCodeProcess(h, out observedExit));
        r.exitCode = observedExit;
        r.live = false;
      }
      return r;
    } finally {
      r.closed = CloseHandle(h);
      Check(r.closed);
    }
  }
}
`;

export const nativeOperations = [];
export const childResources = [];

function nativeProcess(acquisitionPid, bound) {
  const out = psRun(`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${nativeAdapter}
'@
[OwnedNativeProcess]::Run(${Number(acquisitionPid)}, ${bound ? '$true' : '$false'}, ${Number(bound?.pid ?? 0)}, ${psQuote(bound?.birth ?? '')}, ${psQuote(bound?.exe ?? '')}, ${psQuote(bound?.commandLine ?? '')}) | ConvertTo-Json -Compress`);
  const result = JSON.parse(out);
  nativeOperations.push({ action: bound ? 'terminate' : 'inspect', acquisitionPid, expected: bound ?? null, ...result });
  return result;
}

// Independent read-only snapshot, using the same exact handle APIs as the
// action path but a separately acquired handle before recording the identity.
export function queryOsProcess(osPid) {
  const row = nativeProcess(osPid);
  if (row.status === 10 || row.status === 14) return null;
  return row;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

export function osArgvDigest(commandLine) {
  return createHash('sha256').update(commandLine).digest('hex');
}

// Bind a spawned child's exact OS identity before any action is taken on it.
// The child's reported nonce must appear in the kernel command line, which
// binds the CIM row to this exact spawn (exe, argv, birth, pid).
export function bindOsIdentity(osPid, { nonce, expectExe = process.execPath, expectFixturePath = FIXTURE_PATH }) {
  const row = queryOsProcess(osPid);
  if (!row) throw new ProcessAbsentError(osPid);
  const digest = osArgvDigest(row.cl);
  for (const [field, ok] of [
    ['exe', row.exe === expectExe],
    ['argv:fixture-path', row.cl.includes(expectFixturePath)],
    ['argv:child-flag', row.cl.includes('--lease-child')],
    ['argv:nonce', row.cl.includes(nonce)],
  ]) {
    if (!ok) throw new OsIdentityMismatchError({ expected: field }, { exe: row.exe, cl: row.cl }, field);
  }
  return { pid: row.pid, parentPid: row.parentPid, birth: row.birth, birthUnits: row.birthUnits, exe: row.exe, commandLine: row.cl, argvDigest: digest, nonce };
}

// Full-field identity equality; a reused PID with any different field is
// rejected. Comparison happens before any action, never after.
export function validateOsIdentity(recorded, presented) {
  for (const field of ['birth', 'exe', 'argvDigest', 'pid']) {
    if (recorded[field] !== presented[field]) {
      throw new OsIdentityMismatchError(recorded, presented, field);
    }
  }
}

// The acquisition override is a deterministic fixture seam: open a second
// actual owned child while preserving the independently recorded identity.
// The native adapter, not this JS layer, must refuse that handle before action.
export function terminateByIdentity(bound, { acquisitionPid = bound.pid } = {}) {
  const native = nativeProcess(acquisitionPid, bound);
  const { status } = native;
  if (status === 10 || status === 14) {
    const error = new ProcessAbsentError(bound.pid);
    error.native = native;
    throw error;
  }
  if ([11, 12, 13, 16].includes(status)) {
    const error = new OsIdentityMismatchError(bound, native, { 11: 'birth', 12: 'exe', 13: 'argv', 16: 'pid' }[status]);
    error.native = native;
    throw error;
  }
  if (status === 15) throw new Error(`identity-bound kill did not terminate pid ${bound.pid} within bounded wait`);
  if (status !== 0) throw new Error(`identity-guarded termination failed with status ${status}`);
  return { terminated: true, pid: bound.pid, birth: bound.birth, native };
}

// Post-action absence check for the exact original identity. Returns
// { absent: true, pidState } — a live process with a different birth is
// recorded as PID reuse, not as the original still running.
export function verifyAbsence(bound) {
  const row = queryOsProcess(bound.pid);
  if (!row) return { absent: true, pidState: 'no-process' };
  if (row.birth !== bound.birth) return { absent: true, pidState: 'pid-reused-different-birth' };
  return { absent: false, pidState: 'original-identity-still-live' };
}

// ---- Lease database (ownership only, no payloads) ----

export function openLeaseDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 0');
  const jm = db.prepare('PRAGMA journal_mode').get();
  if (String(jm.journal_mode).toLowerCase() !== 'delete') {
    db.close();
    throw new Error(`journal_mode must be delete, got ${JSON.stringify(jm)}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_pid INTEGER NOT NULL,
    owner_nonce TEXT NOT NULL,
    acquired_at TEXT NOT NULL
  )`);
  return db;
}

// BEGIN EXCLUSIVE and record ownership inside the transaction. The holder
// keeps the transaction open for its whole process lifetime — the exclusive
// lock is the lease. A contended BEGIN fails immediately with SQLITE_BUSY
// (timeout 0, no retry).
export function claimLease(db, owner) {
  if (db.isTransaction) {
    throw new Error('claimLease refused: a transaction is already open');
  }
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    if (isBusyError(err)) throw new LeaseBusyError(err);
    throw err;
  }
  try {
    const prev = db.prepare('SELECT owner_pid, owner_nonce FROM lease WHERE id = 1').get();
    if (prev) {
      throw new Error(`lease row already present while BEGIN EXCLUSIVE held: ${JSON.stringify(prev)}`);
    }
    db.prepare(
      'INSERT INTO lease (id, owner_pid, owner_nonce, acquired_at) VALUES (1, ?, ?, ?)'
    ).run(owner.pid, owner.nonce, new Date().toISOString());
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* release path below rethrows err */ }
    throw err;
  }
  return { claimed: true, owner };
}

// Graceful cooperative release: discard the uncommitted ownership row and
// close the database so another real process can acquire.
export function releaseLease(db) {
  if (!db.isTransaction) {
    throw new Error('releaseLease refused: no held lease transaction');
  }
  db.exec('ROLLBACK');
  db.close();
  return { released: true };
}

export function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline exceeded (${ms}ms): ${label}`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// IPC waiter. Subscribes to 'message' before any action is triggered; waits
// are event-driven with a bounded rejection deadline (never sleeps/polling).
export function childIpc(child, { timeoutMs = 20000 } = {}) {
  const queue = [];
  const waiters = [];
  child.on('message', (m) => {
    const w = waiters.shift();
    if (w) w.resolve(m);
    else queue.push(m);
  });
  return {
    queued: () => queue.length,
    next(overrides) {
      const t = overrides?.timeoutMs ?? timeoutMs;
      const p = queue.length > 0
        ? Promise.resolve(queue.shift())
        : new Promise((resolve) => waiters.push({ resolve }));
      return withDeadline(p, t, 'child ipc message');
    },
    async expect(type, overrides) {
      const m = await this.next(overrides);
      if (m?.type !== type) {
        throw new Error(`expected ipc ${type}, got ${JSON.stringify(m)}`);
      }
      return m;
    },
  };
}

// Cleanup uses the original child's IPC channel and captured close event,
// never a historical PID, a reopened process or an unvalidated PID-only kill.
const trackedChildren = new Set();
export async function killTrackedChildren() {
  for (const handle of trackedChildren) {
    const exit = handle.exitEvent();
    if (handle.child.exitCode === null && handle.child.signalCode === null && handle.child.connected) {
      handle.child.send({ type: 'release' });
    }
    await exit;
    await handle.closeEvent();
    trackedChildren.delete(handle);
  }
}

// Fork a real child node process that runs leaseChildMain below. Exit and
// error subscriptions are attached before the child can act on its spec.
// The nonce is generated by the parent and travels in the child's kernel
// command line, binding the CIM identity row to this exact spawn.
export function spawnLeaseChild(specIn, { timeoutMs } = {}) {
  const nonce = `n-${randomUUID()}`;
  const spec = { ...specIn, nonce };
  const child = spawn(process.execPath, [FIXTURE_PATH, '--lease-child', JSON.stringify(spec)], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const resource = {
    pid: child.pid, parentPid: process.pid, exe: process.execPath,
    argv: [FIXTURE_PATH, '--lease-child', JSON.stringify(spec)], nonce,
    dbPath: spec.dbPath, os: null, exit: null, close: null,
  };
  childResources.push(resource);
  child.stderr.setEncoding('utf8');
  const stderrChunks = [];
  child.stderr.on('data', (c) => stderrChunks.push(c));
  const exits = [];
  let exitWaiter = null;
  const onExit = (code, signal) => {
    const rec = { pid: child.pid, code, signal, stderr: stderrChunks.join('') };
    resource.exit = rec;
    exits.push(rec);
    if (exitWaiter) { exitWaiter.resolve(rec); exitWaiter = null; }
  };
  child.once('exit', onExit);
  // Installed at launch, before any release/termination, not an after-action
  // wait. Node's close event includes completion of all child stdio streams.
  const close = new Promise((resolve) => child.once('close', (code, signal) => {
    resource.close = { code, signal, stderrEof: child.stderr.readableEnded };
    resolve(resource.close);
  }));
  const errors = [];
  child.once('error', (err) => errors.push(err));
  const ipc = childIpc(child, { timeoutMs });
  const handle = {
    child,
    pid: child.pid,
    nonce,
    ipc,
    errors,
    resource,
    closeEvent() { return withDeadline(close, 20000, 'child close/stdio EOF'); },
    exitEvent(timeoutMs2 = 20000) {
      if (exits.length > 0) return Promise.resolve(exits[0]);
      return withDeadline(new Promise((resolve) => { exitWaiter = { resolve }; }), timeoutMs2, 'child exit event');
    },
  };
  trackedChildren.add(handle);
  return handle;
}

// Independently bind a spawned child's OS identity from the kernel. This is
// the only accepted identity authority; the child's reported stamp/nonce is
// not trusted as birth.
export function bindChildOsIdentity(handle, overrides = {}) {
  const bound = bindOsIdentity(handle.pid, { ...overrides, nonce: handle.nonce });
  handle.resource.os = bound;
  return bound;
}

// Child entry point. Action modes:
//   create-only: create the database file (schema included) and hard-exit
//                without claiming — crash after creation, before claim.
//   claim:       BEGIN EXCLUSIVE + record ownership, then report 'held' and
//                stay alive until a 'release' message or forced termination.
async function leaseChildMain() {
  const spec = JSON.parse(process.argv[3]);
  const stamp = `${Date.now()}:${process.hrtime.bigint().toString()}`;
  // nonce-only: the stamp is a local instance marker, never birth authority.
  const self = { pid: process.pid, nonce: spec.nonce, stamp };
  if (spec.action === 'create-only') {
    const db = openLeaseDb(spec.dbPath);
    process.send({ type: 'created', identity: self });
    process.exit(70);
  }
  let db;
  try {
    db = openLeaseDb(spec.dbPath);
  } catch (err) {
    if (isBusyError(err)) {
      // Real native SQLITE_BUSY while the incumbent process holds its lock.
      process.send({ type: 'busy', errcode: err.errcode, message: err.message, identity: self });
      process.exit(0);
    }
    process.send({ type: 'child-error', message: err?.stack ?? String(err) });
    process.exit(1);
  }
  try {
    claimLease(db, self);
  } catch (err) {
    db.close();
    process.send({
      type: 'busy',
      errcode: err?.errcode ?? null,
      message: err?.message ?? String(err),
      identity: self,
    });
    process.exit(0);
  }
  process.send({ type: 'held', identity: self });
  process.on('message', (m) => {
    if (m?.type === 'release') {
      releaseLease(db);
      process.send({ type: 'released', identity: self });
      process.exit(0);
    }
  });
}

if (
  process.argv[1] &&
  process.argv[2] === '--lease-child' &&
  (() => {
    try { return realpathSync(process.argv[1]) === realpathSync(FIXTURE_PATH); }
    catch { return false; }
  })()
) {
  leaseChildMain().catch((err) => {
    process.send?.({ type: 'child-error', message: err?.stack ?? String(err) });
    process.exit(1);
  });
}

// ---- Case fixtures (each returns a machine-observable receipt) ----

export const fixtureTempDirs = [];
function tempLeaseDir(prefix = 'lease-fixture-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  fixtureTempDirs.push(dir);
  return dir;
}

function receipt(name, extra) {
  return { case: name, at: new Date().toISOString(), identityAuthority: 'OpenProcess/GetProcessTimes/QueryFullProcessImageName/NtQueryInformationProcess(same-handle)', ...extra };
}

// Positive: A holds BEGIN EXCLUSIVE with kernel-bound identity, real process
// B gets SQLITE_BUSY immediately (busy_timeout=0). Both are OS processes.
export async function caseExclusiveContention({ dir = tempLeaseDir() } = {}) {
  const dbPath = path.join(dir, 'lease.sqlite');
  const a = spawnLeaseChild({ dbPath, action: 'claim' });
  const held = await a.ipc.expect('held');
  const boundA = bindChildOsIdentity(a);
  const b = spawnLeaseChild({ dbPath, action: 'claim' });
  const busy = await b.ipc.expect('busy');
  if (busy.errcode !== BUSY_ERRCODE) {
    throw new Error(`expected SQLITE_BUSY(5) for B, got errcode ${busy.errcode}: ${busy.message}`);
  }
  const bExit = await b.exitEvent();
  if (bExit.code !== 0) throw new Error(`B did not exit cleanly: ${JSON.stringify(bExit)}`);
  const kill = terminateByIdentity(boundA);
  const aExit = await a.exitEvent();
  const absence = verifyAbsence(boundA);
  return receipt('exclusive-contention', {
    ok: true,
    dbPath,
    holder: { ...held.identity, os: boundA },
    rejected: { pid: busy.identity.pid, errcode: busy.errcode, message: busy.message },
    termination: { ...kill, exitEvent: { code: aExit.code, signal: aExit.signal } },
    postSnapshot: absence,
    exits: { b: { code: bExit.code } },
  });
}

// Positive: kernel-bound identity re-validated before the graceful release
// action; then the actual successor B acquires and is bound before closure.
export async function caseGracefulHandoff({ dir = tempLeaseDir() } = {}) {
  const dbPath = path.join(dir, 'lease.sqlite');
  const a = spawnLeaseChild({ dbPath, action: 'claim' });
  const heldA = await a.ipc.expect('held');
  const boundA = bindChildOsIdentity(a);
  // re-validate the full identity from a fresh kernel read before the action
  validateOsIdentity(boundA, bindOsIdentity(boundA.pid, { nonce: a.nonce }));
  a.child.send({ type: 'release' });
  const released = await a.ipc.expect('released');
  const aExit = await a.exitEvent();
  if (aExit.code !== 0) throw new Error(`A did not exit cleanly: ${JSON.stringify(aExit)}`);
  const absenceA = verifyAbsence(boundA);
  if (!absenceA.absent) throw new Error(`released A still live under original identity: ${JSON.stringify(absenceA)}`);
  const b = spawnLeaseChild({ dbPath, action: 'claim' });
  const heldB = await b.ipc.expect('held');
  const boundB = bindChildOsIdentity(b);
  terminateByIdentity(boundB);
  const bExit = await b.exitEvent();
  return receipt('graceful-handoff', {
    ok: true,
    dbPath,
    first: { ...heldA.identity, os: boundA },
    released: released.identity.pid,
    firstAbsenceAfterRelease: absenceA,
    successor: { ...heldB.identity, os: boundB },
    exits: { a: { code: aExit.code }, b: { code: bExit.code, signal: bExit.signal } },
  });
}

// Positive: identity-bound forced termination of the holder (kernel-verified
// birth/exe/argv immediately before the native-handle kill, no release
// call), then a real successor acquires through hot-journal rollback.
export async function caseFatalReleaseHandoff({ dir = tempLeaseDir() } = {}) {
  const dbPath = path.join(dir, 'lease.sqlite');
  const a = spawnLeaseChild({ dbPath, action: 'claim' });
  const heldA = await a.ipc.expect('held');
  const boundA = bindChildOsIdentity(a);
  const kill = terminateByIdentity(boundA);
  const aExit = await a.exitEvent();
  const absence = verifyAbsence(boundA);
  if (!absence.absent) throw new Error(`terminated A still live under original identity: ${JSON.stringify(absence)}`);
  const b = spawnLeaseChild({ dbPath, action: 'claim' });
  const heldB = await b.ipc.expect('held');
  const boundB = bindChildOsIdentity(b);
  terminateByIdentity(boundB);
  const bExit = await b.exitEvent();
  return receipt('fatal-release-handoff', {
    ok: true,
    dbPath,
    killed: { ...heldA.identity, os: boundA },
    termination: { ...kill, exitEvent: { code: aExit.code, signal: aExit.signal } },
    postSnapshot: absence,
    successor: { ...heldB.identity, os: boundB },
    successorExit: { code: bExit.code, signal: bExit.signal },
  });
}

// Negative: wrong birth / reused-PID shape / wrong exe / wrong argv nonce are
// all rejected BEFORE any action, and a refused termination leaves the live
// child untouched (liveness re-proved from the kernel afterwards).
export async function caseOsIdentityMismatch({ dir = tempLeaseDir() } = {}) {
  const dbPath = path.join(dir, 'lease.sqlite');
  const a = spawnLeaseChild({ dbPath, action: 'claim' });
  const heldA = await a.ipc.expect('held');
  const boundA = bindChildOsIdentity(a);
  const rejections = [];
  // wrong birth (reused-PID shape): same PID, different kernel creation time
  let refused = null;
  try {
    terminateByIdentity({ ...boundA, birth: (BigInt(boundA.birth) + 1n).toString() });
  } catch (err) { refused = { name: err.name, code: err.code, field: err.field }; }
  if (refused?.code !== 'OS_IDENTITY_MISMATCH') throw new Error(`wrong birth was not refused: ${JSON.stringify(refused)}`);
  rejections.push({ action: 'terminate', wrong: 'birth', refusal: refused });
  // wrong exe: binding a child whose executable differs from expectation
  refused = null;
  try {
    bindOsIdentity(a.pid, { nonce: a.nonce, expectExe: 'C:\\definitely\\not\\this.exe' });
  } catch (err) { refused = { name: err.name, code: err.code, field: err.field }; }
  if (refused?.code !== 'OS_IDENTITY_MISMATCH') throw new Error(`wrong exe was not refused: ${JSON.stringify(refused)}`);
  rejections.push({ action: 'bind', wrong: 'exe', refusal: refused });
  // wrong argv nonce: the kernel command line does not carry this nonce
  refused = null;
  try {
    bindOsIdentity(a.pid, { nonce: 'n-not-the-spawned-child' });
  } catch (err) { refused = { name: err.name, code: err.code, field: err.field }; }
  if (refused?.code !== 'OS_IDENTITY_MISMATCH') throw new Error(`wrong argv nonce was not refused: ${JSON.stringify(refused)}`);
  rejections.push({ action: 'bind', wrong: 'argv-nonce', refusal: refused });
  // full-field validate: tampered argvDigest rejected before action
  refused = null;
  try {
    validateOsIdentity(boundA, { ...boundA, argvDigest: '0'.repeat(64) });
  } catch (err) { refused = { name: err.name, code: err.code, field: err.field }; }
  if (refused?.code !== 'OS_IDENTITY_MISMATCH') throw new Error(`wrong argvDigest was not refused: ${JSON.stringify(refused)}`);
  rejections.push({ action: 'validate', wrong: 'argvDigest', refusal: refused });
  // Exercise both guards in the termination adapter, not just the read-only
  // binder. A mismatch must close its native handle without TerminateProcess.
  for (const [field, value] of [['exe', 'C:\\definitely\\not\\this.exe'], ['commandLine', `${boundA.commandLine} wrong-argv`]]) {
    refused = null;
    try {
      terminateByIdentity({ ...boundA, [field]: value });
    } catch (err) {
      refused = { code: err.code, field: err.field, native: err.native };
    }
    if (refused?.code !== 'OS_IDENTITY_MISMATCH' || refused.native?.terminated !== false || refused.native?.closed !== true) {
      throw new Error(`termination ${field} guard did not refuse and close: ${JSON.stringify(refused)}`);
    }
    rejections.push({ action: 'terminate', wrong: field, refusal: refused });
  }
  // liveness re-proof from the kernel: every refusal left the child alive
  const stillLive = bindOsIdentity(a.pid, { nonce: a.nonce });
  validateOsIdentity(boundA, stillLive);
  // only now the correct identity-bound termination, then absence
  const kill = terminateByIdentity(boundA);
  const aExit = await a.exitEvent();
  const absence = verifyAbsence(boundA);
  return receipt('os-identity-mismatch', {
    ok: true,
    dbPath,
    bound: boundA,
    rejections,
    stillLiveAfterRejections: { pid: stillLive.pid, birth: stillLive.birth },
    termination: { ...kill, exitEvent: { code: aExit.code, signal: aExit.signal } },
    postSnapshot: absence,
  });
}

// Negative: no blind PID kill. A termination attempt whose bound identity
// does not match a *live different* process is refused, and the live process
// is untouched; a termination attempt on an already-absent PID records
// absence instead of inventing a kill.
export async function caseNoBlindPidKill({ dir = tempLeaseDir() } = {}) {
  const dbPath = path.join(dir, 'lease.sqlite');
  const a = spawnLeaseChild({ dbPath, action: 'claim' });
  await a.ipc.expect('held');
  const boundA = bindChildOsIdentity(a);
  terminateByIdentity(boundA);
  await a.exitEvent();
  const absenceA = verifyAbsence(boundA);
  // attempt to terminate the dead PID again: absence recorded, no kill
  let absentRefusal = null;
  try {
    terminateByIdentity(boundA);
  } catch (err) { absentRefusal = { name: err.name, code: err.code }; }
  if (absentRefusal?.code !== 'OS_PROCESS_ABSENT') {
    throw new Error(`absent PID kill was not recorded as absence: ${JSON.stringify(absentRefusal)}`);
  }
  // wrong-identity attempt against a live different child (wrong birth/exe
  // pair on a live PID) must refuse and leave that child unharmed
  const b = spawnLeaseChild({ dbPath, action: 'claim' });
  const heldB = await b.ipc.expect('held');
  const boundB = bindChildOsIdentity(b);
  let wrongRefusal = null;
  try {
    terminateByIdentity({ ...boundB, birth: boundA.birth, commandLine: boundA.commandLine, argvDigest: boundA.argvDigest });
  } catch (err) { wrongRefusal = { name: err.name, code: err.code, field: err.field }; }
  if (wrongRefusal?.code !== 'OS_IDENTITY_MISMATCH') {
    throw new Error(`wrong-identity kill of live B was not refused: ${JSON.stringify(wrongRefusal)}`);
  }
  const bStill = bindOsIdentity(b.pid, { nonce: b.nonce });
  validateOsIdentity(boundB, bStill);
  terminateByIdentity(boundB);
  await b.exitEvent();
  return receipt('no-blind-pid-kill', {
    ok: true,
    dbPath,
    deadPidRetrminationAttempt: { recorded: absentRefusal, absence: absenceA },
    liveWrongIdentityAttempt: { refusal: wrongRefusal, liveUntouched: { pid: bStill.pid, birth: bStill.birth } },
    holderB: { ...heldB.identity, os: boundB },
  });
}

// Negative: crash after the database file is created but before any claim;
// the creator's absence is verified from the kernel, then a successor claims.
export async function caseCrashBeforeClaim({ dir = tempLeaseDir() } = {}) {
  const dbPath = path.join(dir, 'lease.sqlite');
  const a = spawnLeaseChild({ dbPath, action: 'create-only' });
  const created = await a.ipc.expect('created');
  const aExit = await a.exitEvent();
  if (!existsSync(dbPath)) throw new Error('database file was not created');
  const creatorRow = queryOsProcess(a.pid);
  const creatorAbsence = creatorRow
    ? { absent: false, pidState: 'still-live', birth: creatorRow.birth }
    : { absent: true, pidState: 'no-process' };
  if (!creatorAbsence.absent) throw new Error(`crashed creator still live: ${JSON.stringify(creatorAbsence)}`);
  const b = spawnLeaseChild({ dbPath, action: 'claim' });
  const heldB = await b.ipc.expect('held');
  const boundB = bindChildOsIdentity(b);
  terminateByIdentity(boundB);
  const bExit = await b.exitEvent();
  return receipt('crash-before-claim', {
    ok: true,
    dbPath,
    crashedCreator: { identity: created.identity, exitCode: aExit.code, exitSignal: aExit.signal, osCheck: creatorAbsence },
    fileExistedAfterCrash: true,
    successor: { ...heldB.identity, os: boundB },
    successorExit: { code: bExit.code, signal: bExit.signal },
  });
}

// Negative: a corrupt lease fixture is rejected on open and left byte-for-byte
// untouched — no delete, no recreate, no takeover.
export async function caseCorruptFixture({ dir = tempLeaseDir() } = {}) {
  const dbPath = path.join(dir, 'lease.sqlite');
  const garbage = Buffer.from('this lease fixture is not a sqlite database at all — garbage bytes');
  writeFileSync(dbPath, garbage);
  const before = readFileSync(dbPath);
  let rejected = null;
  try {
    const db = openLeaseDb(dbPath);
    db.close();
  } catch (err) {
    rejected = { code: err.code, message: err.message };
  }
  if (!rejected || !/not a database/i.test(rejected.message)) {
    throw new Error(`corrupt fixture was not rejected: ${JSON.stringify(rejected)}`);
  }
  const after = readFileSync(dbPath);
  if (!before.equals(after)) throw new Error('corrupt fixture file was modified');
  return receipt('corrupt-fixture', {
    ok: true,
    dbPath,
    rejection: rejected,
    bytesPreserved: before.equals(after),
    byteLength: after.length,
  });
}

// Negative: while a real process holds the database open, the operating
// system itself blocks file deletion — file-delete takeover is impossible.
export async function caseNoDeleteTakeover({ dir = tempLeaseDir() } = {}) {
  const dbPath = path.join(dir, 'lease.sqlite');
  const a = spawnLeaseChild({ dbPath, action: 'claim' });
  const held = await a.ipc.expect('held');
  const boundA = bindChildOsIdentity(a);
  let blocked = null;
  try {
    rmSync(dbPath);
  } catch (err) {
    blocked = { code: err.code, message: err.message };
  }
  const stillHeld = existsSync(dbPath);
  if (!blocked) throw new Error('lease database file was deletable while held');
  const b = spawnLeaseChild({ dbPath, action: 'claim' });
  const busy = await b.ipc.expect('busy');
  terminateByIdentity(boundA);
  await a.exitEvent();
  await b.exitEvent();
  return receipt('no-delete-takeover', {
    ok: true,
    dbPath,
    holder: { ...held.identity, os: boundA },
    unlinkBlocked: blocked,
    fileStillPresent: stillHeld,
    postUnlinkAttemptBusy: { errcode: busy.errcode, message: busy.message },
  });
}

// Controlled substitution of a second actual owned child at acquisition, not
// observed real PID reuse. Both children must survive the refused action.
export async function caseHandleAcquisitionSubstitution({ dir = tempLeaseDir() } = {}) {
  const dbPath = path.join(dir, 'lease.sqlite');
  const a = spawnLeaseChild({ dbPath, action: 'claim' });
  const b = spawnLeaseChild({ dbPath: path.join(dir, 'other.sqlite'), action: 'claim' });
  let boundA;
  let boundB;
  try {
    await a.ipc.expect('held');
    await b.ipc.expect('held');
    boundA = bindChildOsIdentity(a);
    boundB = bindChildOsIdentity(b);
    let refusal;
    try {
      terminateByIdentity(boundA, { acquisitionPid: boundB.pid });
    } catch (err) {
      refusal = { code: err.code, field: err.field, native: err.native };
    }
    if (refusal?.code !== 'OS_IDENTITY_MISMATCH') {
      throw new Error(`acquisition substitution was not refused: ${JSON.stringify(refusal)}`);
    }
    const stillA = bindChildOsIdentity(a);
    const stillB = bindChildOsIdentity(b);
    validateOsIdentity(boundA, stillA);
    validateOsIdentity(boundB, stillB);
    const terminationA = terminateByIdentity(boundA);
    const terminationB = terminateByIdentity(boundB);
    const exits = { a: await a.exitEvent(), b: await b.exitEvent() };
    return receipt('handle-acquisition-substitution', {
      ok: true, dbPath, controlledSubstitution: true, observedRealPidReuse: false,
      holder: { os: boundA }, substituted: { os: boundB }, refusal,
      untouchedAfterRefusal: [stillA, stillB], terminationA, terminationB, exits,
    });
  } finally {
    for (const [child, bound] of [[a, boundA], [b, boundB]]) {
      if (bound && child.child.exitCode === null && child.child.signalCode === null) {
        const live = queryOsProcess(bound.pid);
        if (live) terminateByIdentity(bound);
      }
      await child.exitEvent();
    }
  }
}

export const ALL_CASES = Object.fromEntries(
  Object.entries({
    'exclusive-contention': caseExclusiveContention,
    'graceful-handoff': caseGracefulHandoff,
    'fatal-release-handoff': caseFatalReleaseHandoff,
    'os-identity-mismatch': caseOsIdentityMismatch,
    'no-blind-pid-kill': caseNoBlindPidKill,
    'crash-before-claim': caseCrashBeforeClaim,
    'corrupt-fixture': caseCorruptFixture,
    'no-delete-takeover': caseNoDeleteTakeover,
    'handle-acquisition-substitution': caseHandleAcquisitionSubstitution,
  }).map(([name, fn]) => [name, async (...a) => {
    try {
      return await fn(...a);
    } finally {
      await killTrackedChildren();
    }
  }]),
);

// Temporary directories are owned by the fixture layer: callers collect them
// here for exact, identity-bound cleanup after receipts are captured.
export function ownedTempDirs(result) {
  return result?.dbPath ? [path.dirname(result.dbPath)] : [];
}

export function cleanupOwnedDirs(dirs) {
  const cleaned = [];
  const failed = [];
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
      cleaned.push(d);
    } catch (err) {
      failed.push({ dir: d, code: err.code, message: err.message });
    }
  }
  return { cleaned, failed };
}
