import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_MODULES, assertSenpiVersion, resolveSenpiRoot } from '../../src/senpi-root.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = join(root, '.tmp-e1', `unit-senpi-${process.pid}`);
const casesRoot = join(fixtureRoot, 'cases');
const sentinel = join(fixtureRoot, 'outside-sentinel.txt');

before(() => {
  mkdirSync(casesRoot, { recursive: true });
  writeFileSync(sentinel, 'outside fixture sentinel\n');
});

after(() => {
  if (existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
});

function expectCode(code, run) {
  try {
    run();
  } catch (error) {
    assert.equal(error.name, 'SenpiRootError', `expected a SenpiRootError, saw ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `expected ${code}, saw ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected SenpiRootError with code ${code}`);
}

function makeFakeSdk(name, version, { modules = true } = {}) {
  const dir = join(casesRoot, `${name.replace(/[^a-z0-9]+/gi, '-')}-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
  if (modules) {
    for (const relative of Object.values(REQUIRED_MODULES)) {
      const path = join(dir, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'export const fixture = true;\n');
    }
  }
  return dir;
}

test('a missing --senpi-root argument fails clearly instead of falling back', () => {
  expectCode('MISSING_ARGUMENT', () => resolveSenpiRoot(undefined));
  expectCode('MISSING_ARGUMENT', () => resolveSenpiRoot(''));
  expectCode('MISSING_ARGUMENT', () => resolveSenpiRoot('   '));
});

test('a nonexistent or non-SDK root fails with the exact reason and path', () => {
  const missing = join(casesRoot, 'does-not-exist');
  const missingError = expectCode('MISSING_ROOT', () => resolveSenpiRoot(missing));
  assert.equal(missingError.detail.root, resolve(missing));
  assert.ok(missingError.message.includes(resolve(missing)), 'the error must name the requested root, never a fallback');

  const empty = join(casesRoot, 'empty-dir');
  mkdirSync(empty, { recursive: true });
  expectCode('MISSING_MANIFEST', () => resolveSenpiRoot(empty));

  const badJson = join(casesRoot, 'bad-json');
  mkdirSync(badJson, { recursive: true });
  writeFileSync(join(badJson, 'package.json'), '{ not json');
  expectCode('INVALID_MANIFEST', () => resolveSenpiRoot(badJson));

  const other = makeFakeSdk('some-other-package', '1.0.0', { modules: false });
  const notSdk = expectCode('NOT_SDK', () => resolveSenpiRoot(other));
  assert.equal(notSdk.detail.name, 'some-other-package');
});

test('an SDK root without its native modules fails instead of half-loading', () => {
  const incomplete = makeFakeSdk('@code-yeongyu/senpi', '0.0.1', { modules: false });
  const error = expectCode('MISSING_MODULE', () => resolveSenpiRoot(incomplete));
  assert.equal(error.detail.missing.length, Object.values(REQUIRED_MODULES).length);
});

test('a complete SDK root resolves with its version and a version gate exists', () => {
  const fake = makeFakeSdk('@code-yeongyu/senpi', '9.9.9-fixture');
  const info = resolveSenpiRoot(fake);
  assert.equal(info.version, '9.9.9-fixture');
  assert.equal(info.root, resolve(fake));
  assert.equal(assertSenpiVersion(info, '9.9.9-fixture'), info);
  const error = expectCode('VERSION_MISMATCH', () => assertSenpiVersion(info, '1.2.3'));
  assert.equal(error.detail.actual, '9.9.9-fixture');
});

test('test:host refuses a missing or invalid root with a clear exit code', () => {
  const withoutArgument = spawnSync(process.execPath, [join(root, 'scripts/test-host.mjs')], { cwd: root, encoding: 'utf8', timeout: 60000 });
  assert.equal(withoutArgument.status, 1);
  assert.ok(`${withoutArgument.stdout}${withoutArgument.stderr}`.includes('A --senpi-root path is required'));

  const badRoot = spawnSync(process.execPath, [join(root, 'scripts/test-host.mjs'), '--senpi-root', join(casesRoot, 'does-not-exist')], { cwd: root, encoding: 'utf8', timeout: 60000 });
  assert.equal(badRoot.status, 1);
  assert.ok(`${badRoot.stdout}${badRoot.stderr}`.includes('MISSING_ROOT'));
});

test('test:host rejects an invalid manifest shape before any fixture or test', () => {
  const fakeSdk = makeFakeSdk('@code-yeongyu/senpi', '0.0.1-manifest-fixture');
  const invalidManifests = {
    'null.json': 'null',
    'false.json': 'false',
    'scalar.json': '42',
    'empty-version.json': JSON.stringify({ sdkVersion: '', files: [{ path: 'package.json', sha256: '0'.repeat(64) }] }),
    'empty-files.json': JSON.stringify({ sdkVersion: '0.0.1-manifest-fixture', files: [] }),
    'missing-files.json': JSON.stringify({ sdkVersion: '0.0.1-manifest-fixture' }),
    'bad-hash.json': JSON.stringify({ sdkVersion: '0.0.1-manifest-fixture', files: [{ path: 'package.json', sha256: '' }] }),
    'bad-path.json': JSON.stringify({ sdkVersion: '0.0.1-manifest-fixture', files: [{ path: '', sha256: '0'.repeat(64) }] }),
    'bad-entry.json': JSON.stringify({ sdkVersion: '0.0.1-manifest-fixture', files: [42] }),
  };
  for (const [name, bytes] of Object.entries(invalidManifests)) {
    writeFileSync(join(casesRoot, name), `${bytes}\n`);
    const run = spawnSync(process.execPath, [join(root, 'scripts/test-host.mjs'), '--senpi-root', fakeSdk, '--manifest', join(casesRoot, name)], { cwd: root, encoding: 'utf8', timeout: 60000 });
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 1, `${name} must fail with exit 1, saw ${run.status}`);
    assert.ok(!/^ok \d+ - /m.test(output), `${name} must run no TAP case`);
    assert.ok(output.includes('"ok": false'), `${name} must emit a failed host-run envelope`);
    assert.ok(output.includes('manifest'), `${name} failure must name the manifest`);
  }
  const hostFixtures = existsSync(join(root, '.tmp-e1'))
    ? readdirSync(join(root, '.tmp-e1')).filter(entry => entry.startsWith('host-')) : [];
  assert.deepEqual(hostFixtures, [], 'no host fixture root may be created for rejected manifests');
});

test('test:host rejects outside-root manifest paths before hashing and hashes canonical ones', () => {
  const fakeSdk = makeFakeSdk('@code-yeongyu/senpi', '0.0.1-manifest-fixture');
  const entry = path => ({ sdkVersion: '0.0.1-manifest-fixture', files: [{ path, sha256: '0'.repeat(64) }] });
  const outsideRootCases = {
    'traversal-verifier.json': JSON.stringify(entry('../../../../../../orca/projects/omo-herdr-todo-wt/restart-recovery-wave1/.omo/evidence/omo-herdr-dashboard-restart-recovery/task-1/host/null-independent/fixtures/null.json')),
    'traversal-parent.json': JSON.stringify(entry('../outside.json')),
    'traversal-nested.json': JSON.stringify(entry('a/../../outside.json')),
    'single-backslash.json': JSON.stringify(entry('..\\package.json')),
    'absolute-drive.json': JSON.stringify(entry('C:/Windows/notepad.exe')),
    'unc.json': JSON.stringify(entry('\\\\server/share/package.json')),
    'dot-segment.json': JSON.stringify(entry('a/./package.json')),
  };
  for (const [name, bytes] of Object.entries(outsideRootCases)) {
    writeFileSync(join(casesRoot, name), `${bytes}\n`);
    const run = spawnSync(process.execPath, [join(root, 'scripts/test-host.mjs'), '--senpi-root', fakeSdk, '--manifest', join(casesRoot, name)], { cwd: root, encoding: 'utf8', timeout: 60000 });
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 1, `${name} must fail with exit 1, saw ${run.status}`);
    assert.ok(output.includes('canonical relative slash path'), `${name} must be rejected by the path boundary`);
    assert.ok(!output.includes('native source identity mismatch'), `${name} must be rejected before any file is hashed`);
  }
  // Green: a canonical relative path passes the boundary and reaches hashing,
  // failing only on the intentionally wrong declared digest.
  const wrongHash = JSON.stringify({ sdkVersion: '0.0.1-manifest-fixture', files: [{ path: 'package.json', sha256: 'f'.repeat(64) }] });
  writeFileSync(join(casesRoot, 'wrong-hash.json'), `${wrongHash}\n`);
  const green = spawnSync(process.execPath, [join(root, 'scripts/test-host.mjs'), '--senpi-root', fakeSdk, '--manifest', join(casesRoot, 'wrong-hash.json')], { cwd: root, encoding: 'utf8', timeout: 60000 });
  const greenOutput = `${green.stdout}${green.stderr}`;
  assert.equal(green.status, 1);
  assert.ok(greenOutput.includes('native source identity mismatch'), 'a canonical path must pass the boundary into hashing');
  assert.ok(!greenOutput.includes('canonical relative slash path'), 'a canonical path must not be rejected as outside-root');
  assert.ok(!existsSync(join(root, '.tmp-e1', `host-${green.pid}`)), 'no host fixture for a hash mismatch');
});

test('the host suite fails rather than skipping when the SDK root is absent', () => {
  const environment = { ...process.env };
  delete environment.OMO_HERDR_SENPI_ROOT;
  delete environment.OMO_HERDR_FIXTURE_ROOT;
  const run = spawnSync(process.execPath, ['--test', '--test-isolation=none', join(root, 'test/host/native-host.test.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 120000, env: environment,
  });
  assert.notEqual(run.status, 0, 'a missing SDK root must fail the host suite');
  assert.ok(`${run.stdout}${run.stderr}`.includes('OMO_HERDR_SENPI_ROOT'), 'the failure must name the missing SDK root');
});

test('test:host version gate is terminal: no hashing, TAP cases or fixture on mismatch', () => {
  const fakeSdk = makeFakeSdk('@code-yeongyu/senpi', '9.9.8-fixture');
  const actualDigest = createHash('sha256').update(readFileSync(join(fakeSdk, 'package.json'))).digest('hex');
  // Wrong declared version with a genuinely matching digest: must reject at
  // the version gate alone, never reaching hashing, the host fixture or any
  // TAP case.
  const wrongVersion = JSON.stringify({ sdkVersion: '9.9.9-wrong', files: [{ path: 'package.json', sha256: actualDigest }] });
  writeFileSync(join(casesRoot, 'wrong-version.json'), `${wrongVersion}\n`);
  const run = spawnSync(process.execPath, [join(root, 'scripts/test-host.mjs'), '--senpi-root', fakeSdk, '--manifest', join(casesRoot, 'wrong-version.json')], { cwd: root, encoding: 'utf8', timeout: 60000 });
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 1, `wrong version must fail with exit 1, saw ${run.status}`);
  assert.equal([...output.matchAll(/HOST_RESULT_BEGIN/g)].length, 1, 'exactly one rejection envelope');
  assert.ok(output.includes('VERSION_MISMATCH'), 'the single envelope must carry VERSION_MISMATCH');
  assert.ok(!/^ok \d+ - /m.test(output), 'no TAP case may run');
  assert.ok(!output.includes('native source identity mismatch'), 'hashing must not run for a version mismatch');
  assert.ok(!existsSync(join(root, '.tmp-e1', `host-${run.pid}`)), 'no host fixture may be allocated');
  // Version-matching manifest with a wrong digest still reaches hashing.
  const matchingVersionWrongHash = JSON.stringify({ sdkVersion: '9.9.8-fixture', files: [{ path: 'package.json', sha256: 'f'.repeat(64) }] });
  writeFileSync(join(casesRoot, 'matching-version-wrong-hash.json'), `${matchingVersionWrongHash}\n`);
  const hashRun = spawnSync(process.execPath, [join(root, 'scripts/test-host.mjs'), '--senpi-root', fakeSdk, '--manifest', join(casesRoot, 'matching-version-wrong-hash.json')], { cwd: root, encoding: 'utf8', timeout: 60000 });
  const hashOutput = `${hashRun.stdout}${hashRun.stderr}`;
  assert.equal(hashRun.status, 1);
  assert.ok(hashOutput.includes('native source identity mismatch'), 'a version-matching manifest must reach hashing');
  assert.ok(!hashOutput.includes('VERSION_MISMATCH'), 'a matching version must not trip the version gate');
});

test('fixture refusals leave the outside sentinel intact', () => {
  assert.equal(readFileSync(sentinel, 'utf8'), 'outside fixture sentinel\n');
});
