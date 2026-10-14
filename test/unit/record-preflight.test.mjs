import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectFiles } from '../../scripts/record-preflight.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('record preflight accepts the portable controller fixture and rejects added private content', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'todo-record-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'test'));
  await copyFile(join(root, 'package.json'), join(directory, 'package.json'));
  const name = 'test/controller.test.mjs';
  await copyFile(join(root, name), join(directory, name));

  const [record] = await inspectFiles(directory, [name], 'W');
  assert.equal(record.path, name);
  assert.equal(record.syntheticRejectionFixture, undefined);

  const privatePath = ['C', ':', '/', 'Users', '/', 'unexpected', '/', 'settings.json'].join('');
  await appendFile(join(directory, name), `\n// ${privatePath}\n`);
  await assert.rejects(inspectFiles(directory, [name], 'W'), /machine-absolute-path/);
});
