// Migrated native host harness entry point (npm run test:host).
//
// 1. resolve --senpi-root (explicit failure, never a fallback root),
// 2. assert the recorded SDK version and every native source hash (the
//    manifest defaults to config/native-source-manifest.json; --manifest
//    selects a private manifest with the identical strict checks),
// 3. run the migrated native host tests with node:test,
// 4. re-hash the same sources and fail when anything changed,
// 5. print a bounded JSON summary and remove its own fixture root.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSenpiRoot, assertSenpiVersion } from '../src/senpi-root.mjs';
import { hashManifest, compareToDeclared, summarizeIdentity } from '../src/source-hashes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

function fail(message, detail = {}) {
  console.error(`test:host failed: ${message}`);
  console.log('HOST_RESULT_BEGIN');
  console.log(JSON.stringify({ schema: 'omo-herdr-todo/host-run/1', ok: false, error: message, ...detail }, null, 2));
  console.log('HOST_RESULT_END');
  process.exitCode = 1;
}

const senpiRootArg = value('--senpi-root');
const manifestArg = value('--manifest');
if (!senpiRootArg) {
  fail('A --senpi-root path is required. usage: npm run test:host -- --senpi-root <path-to-@code-yeongyu/senpi> [--manifest <native-source-manifest.json>]');
} else {
  let info;
  try {
    info = resolveSenpiRoot(senpiRootArg);
  } catch (error) {
    fail(`[${error.code ?? 'UNKNOWN'}] ${error.message}`, { senpiRoot: senpiRootArg });
  }
  if (info) {
    // --manifest points at a private native-source-manifest (e.g. the freshly
    // recorded identity of the installed SDK). Every guard is unchanged: the
    // recorded sdkVersion, every file sha256 before the run and the same set
    // after; a failed guard rejects before any host fixture is created.
    const manifestPath = manifestArg ? resolve(manifestArg) : join(root, 'config/native-source-manifest.json');
    let manifest;
    if (!existsSync(manifestPath)) {
      fail(`manifest file does not exist: ${manifestPath}`, { manifest: manifestPath });
    } else {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch (error) {
        fail(`manifest is not valid JSON (${manifestPath}): ${error.message}`, { manifest: manifestPath });
      }
      // The manifest boundary rejects every invalid shape before the SDK
      // version gate, hash checks or any host fixture: a null/false/scalar
      // root, an empty sdkVersion or files array, and files that are not
      // objects with a nonempty relative path and a 64-hex sha256 digest.
      // This strictness is the consumed manifest contract; an empty or
      // unchecked hash can never pass.
      const invalidReason = m => {
        if (!m || typeof m !== 'object' || Array.isArray(m)) {
          return 'manifest must be a JSON object with sdkVersion and files';
        }
        if (typeof m.sdkVersion !== 'string' || m.sdkVersion.trim() === '') {
          return 'manifest must declare a nonempty sdkVersion string';
        }
        if (!Array.isArray(m.files) || m.files.length === 0) {
          return 'manifest must declare a nonempty files array';
        }
        for (const [index, file] of m.files.entries()) {
          const label = `files[${index}]`;
          if (!file || typeof file !== 'object' || Array.isArray(file)) return `${label} must be an object`;
          if (typeof file.path !== 'string' || file.path.trim() === '') {
            return `${label}.path must be a nonempty string`;
          }
          // Canonical SDK-relative slash paths only: any backslash (including
          // a single one), absolute/drive/UNC form or a traversal or dot
          // segment must be rejected here, before hashManifest joins it onto
          // the SDK root and reads outside it.
          if (file.path.includes('\\') || file.path.startsWith('/') || /^[a-zA-Z]:/.test(file.path) ||
              file.path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
            return `${label}.path must be a canonical relative slash path inside the SDK root (no absolute/drive/UNC/backslash form or traversal/dot segments)`;
          }
          if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
            return `${label}.sha256 must be a 64-character lowercase hex digest`;
          }
        }
        return undefined;
      };
      const reason = invalidReason(manifest);
      if (reason) {
        fail(`${reason}: ${manifestPath}`, { manifest: manifestPath });
        manifest = undefined;
      }
    }
    if (manifest) {
      // The version gate is terminal: fail() only records the rejection, so
      // the hashing, fixture allocation and host spawn below must be skipped
      // when the recorded sdkVersion does not match the actual SDK.
      let versionOk = true;
      try {
        assertSenpiVersion(info, manifest.sdkVersion);
      } catch (error) {
        fail(`[${error.code}] ${error.message}`, { senpiRoot: info.root });
        versionOk = false;
      }
      if (versionOk) {
      const relativePaths = manifest.files.map(file => file.path);
      const declared = Object.fromEntries(manifest.files.map(file => [file.path, file.sha256]));
      const before = await hashManifest(info.root, relativePaths);
      const mismatches = compareToDeclared(before, declared);
      if (mismatches.length > 0) {
        fail(`native source identity mismatch for ${mismatches.length} file(s)`, { mismatches });
      } else {
        const fixtureRoot = join(root, '.tmp-e1', `host-${process.pid}`);
        mkdirSync(fixtureRoot, { recursive: true });
        const run = spawnSync(process.execPath, [
          '--test', '--test-isolation=none', '--test-reporter=tap', '--test-timeout=120000',
          join(root, 'test/host/native-host.test.mjs'),
          join(root, 'test/host/display-bridge-host.test.mjs'),
        ], {
          cwd: root,
          encoding: 'utf8',
          timeout: 300000,
          maxBuffer: 128 * 1024 * 1024,
          env: {
            ...process.env,
            OMO_HERDR_SENPI_ROOT: info.root,
            OMO_HERDR_NATIVE_MANIFEST: manifestPath,
            OMO_HERDR_FIXTURE_ROOT: fixtureRoot,
          },
        });
        const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
        process.stdout.write(run.stdout ?? '');
        process.stderr.write(run.stderr ?? '');
        const counts = {};
        for (const name of ['tests', 'pass', 'fail', 'skipped', 'todo']) {
          const match = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(output);
          counts[name] = match ? Number(match[1]) : null;
        }
        const cases = [...output.matchAll(/^(?:not )?ok \d+ - (.+)$/gm)].map(match => match[1].trim());
        const after = await hashManifest(info.root, relativePaths);
        const identity = summarizeIdentity(before, after);
        const ok = run.status === 0 && (counts.fail ?? 1) === 0 && identity.allUnchanged;
        if (existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
        try { rmdirSync(join(root, '.tmp-e1')); } catch { /* the parent stays when other owned fixtures are live */ }
        console.log('HOST_RESULT_BEGIN');
        console.log(JSON.stringify({
          schema: 'omo-herdr-todo/host-run/1',
          ok,
          senpiRoot: info.root,
          sdkVersion: info.version,
          manifest: manifestPath,
          exitCode: run.status,
          counts,
          cases,
          identity,
          fixtureRootRemoved: !existsSync(fixtureRoot),
        }, null, 2));
        console.log('HOST_RESULT_END');
        if (!ok) process.exitCode = 1;
      }
      }
    }
  }
}
