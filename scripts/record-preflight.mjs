import { readFile, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scanText, scanSpecifiers } from '../src/public-safety.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
class PreflightFailure extends Error {}
const reject = message => { throw new PreflightFailure(message); };
const targets = {
  W: { repository: 'https://github.com/grim-susemi/omo-herdr-todo', branch: 'feat/concurrent-dashboard', name: 'omo-herdr-todo' },
  D: { repository: 'https://github.com/grim-susemi/omo-herdr-dag', branch: 'feat/concurrent-views-and-metrics', name: 'omo-herdr-dag' },
};
const reviewedFixtures = {
  'W/test/controller.test.mjs': { sha256: '2d82dc8ff067cc10cc26cdacad441be3370ab1c4b16a84abe3169fd19636e1ea', count: 6, violationsSHA256: 'ed2376bc50071607c94c2505ab5d51eca15fbf50ca8ee9d5baae34ec0491d962' },
  'W/test/host/native-host.test.mjs': { sha256: 'b5377a4ac86491a5a5ab0c50f2eb63f45eb7bf4e66586c2df57de1360128b967', count: 3, violationsSHA256: 'f9b21a6482205486fa1b38c78f0370469b166ffc8fdb10d9f637d39bc5c090da' },
  'W/test/unit/child-guard.test.mjs': { sha256: '2ab5691257de0c08b80732b709f0b098b1dd915087bbbb898db15b6d739bfffa', count: 9, violationsSHA256: '629814cfbe446e82526a841f99aa623ca23bce1665c083e0cd13449633427e4d' },
  'W/test/unit/public-safety.test.mjs': { sha256: '81761f0eadcca6bb511bbcaafff95f2646c9115ccd4dc922d5ebd2434ba2d635', count: 14, violationsSHA256: 'a5efaeeeecf8dd9578a8a29bba8369344ea173c3cde2b87a9dff415961fcbba5', specifierCount: 2, specifiersSHA256: '49d2bccfb136a46a01ba4417be6978aa482b2ccbd4f13de776a33d4579b852f2' },
  'D/test/fixed-controller.test.mjs': { sha256: '27516d0bc647dc841282fc6420cb831ce1b1147d05d6603bda64e6288993e274', count: 6, violationsSHA256: 'a3b48b0cf20fd7b5d34ae9262ff9696bb88cfd34e3dc376ca1a16f80cf3070f7' },
};
const referenceAssets = new Set(['docs/screenshots/dag-pane-command-en.png', 'docs/screenshots/dag-pane-command.png',
  'docs/screenshots/workflow-in-progress-en.png', 'docs/screenshots/workflow-in-progress.png']);
const inheritedAssetBaseline = 'd3f9704';
const topLevel = new Set(['.gitignore', '.gitattributes', 'LICENSE', 'README.md', 'README_KO.md', 'README_ZH.md',
  'THIRD-PARTY-NOTICES.md', 'CONTRIBUTING.md', 'VERIFICATION.md', 'RELEASING.md', 'package.json', 'package-lock.json', 'extension.mjs']);
function allowlisted(name, role) {
  if (name.includes('..') || name.includes('\\') || name.startsWith('/')) return false;
  return topLevel.has(name) || role === 'D' && referenceAssets.has(name) ||
    /^(?:bin|src|scripts|test)\/[A-Za-z0-9_./-]+\.mjs$/.test(name) ||
    role === 'W' && name === 'config/native-source-manifest.json' || /^docs\/[A-Za-z0-9_./-]+\.md$/.test(name) ||
    /^\.github\/(?:workflows\/[A-Za-z0-9_.-]+\.ya?ml|ISSUE_TEMPLATE\/[A-Za-z0-9_.-]+\.md)$/.test(name);
}
async function git(directory, ...args) {
  try { return (await execute('git', ['-C', directory, ...args], { env: process.env, maxBuffer: 4 * 1024 * 1024 })).stdout; }
  catch { return reject('Git metadata lookup failed; use a local source checkout.'); }
}
const secretPattern = new RegExp(['s' + 'k-[A-Za-z0-9]{20,}', 'gh' + '[pousr]_[A-Za-z0-9]{20,}', '-----BEGIN [A-Z ]*PRIVATE KEY-----'].join('|'));
export async function inspectFiles(directory, names, role) {
  const base = await realpath(directory), files = [];
  const pkg = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
  for (const name of [...names].sort()) {
    if (!allowlisted(name, role)) reject('Tracked path is outside the reviewed source allowlist.');
    const path = resolve(base, name), info = await lstat(path), actual = await realpath(path);
    if (!info.isFile() || info.isSymbolicLink() || relative(base, actual).startsWith('..' + sep) || actual !== path)
      reject('Allowlist path is not an ordinary file inside the source checkout.');
    const bytes = await readFile(path), digest = sha(bytes), row = { path: name, sha256: digest, size: bytes.length };
    if (role === 'D' && referenceAssets.has(name)) {
      const prior = (await execute('git', ['-C', base, 'show', `${inheritedAssetBaseline}:${name}`], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })).stdout;
      if (sha(prior) !== digest) reject('Inherited reference asset changed; new captured screenshots are forbidden.');
      row.provenance = { baseline: inheritedAssetBaseline, unchanged: true, kind: 'Inherited upstream README reference asset; not a new QA capture' };
    } else {
      const text = bytes.toString('utf8'), violations = scanText(text), fixture = reviewedFixtures[role + '/' + name];
      if (violations.length) {
        if (!fixture || fixture.sha256 !== digest || fixture.count !== violations.length || fixture.violationsSHA256 !== sha(JSON.stringify(violations)))
          reject(`${name}: ${violations[0].rule} at line ${violations[0].line}`);
        row.syntheticRejectionFixture = { violations: violations.length, boundedContentHash: fixture.sha256, violationsSHA256: fixture.violationsSHA256 };
      }
      if (secretPattern.test(text)) reject(`${name}: credential-like literal rejected`);
      if (name.endsWith('.mjs')) {
        const unknown = scanSpecifiers(text).filter(value => !declared.has(value.specifier.split('/').slice(0, value.specifier.startsWith('@') ? 2 : 1).join('/')));
        if (unknown.length && (!fixture || fixture.sha256 !== digest || fixture.specifierCount !== unknown.length || fixture.specifiersSHA256 !== sha(JSON.stringify(unknown))))
          reject(`${name}: undeclared import at line ${unknown[0].line}`);
      }
    }
    files.push(row);
  }
  return files;
}
export async function collectRepository(directory, role) {
  if (!targets[role]) reject('Unknown source role.');
  if ((await git(directory, 'status', '--porcelain', '--untracked-files=all')).trim()) reject('Dirty or untracked files block this preflight.');
  const branch = (await git(directory, 'branch', '--show-current')).trim();
  if (branch !== targets[role].branch) reject(`Unexpected ${role} branch; the reviewed candidate branch is required.`);
  const names = (await git(directory, 'ls-files', '-z')).split('\0').filter(Boolean);
  const files = await inspectFiles(directory, names, role);
  const head = (await git(directory, 'rev-parse', 'HEAD')).trim();
  const lineageRoots = (await git(directory, 'rev-list', '--max-parents=0', 'HEAD')).trim().split('\n');
  const parent = (await git(directory, 'rev-list', '--parents', '-n', '1', 'HEAD')).trim().split(' ')[1] ?? null;
  const recent = (await git(directory, 'log', '-12', '--format=%H%x09%s')).trim().split('\n').map(line => {
    const [commit, ...subject] = line.split('\t'); return { commit, subject: subject.join('\t') };
  });
  return { role, ...targets[role], head, parent, lineageRoots, recent, clean: true, files };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--dag-root')) reject('Usage: npm run record:preflight -- [--dag-root <dag-source-checkout>]');
  const common = (await git(root, 'rev-parse', '--git-common-dir')).trim();
  const candidate = args.length ? resolve(args[1]) : join(dirname(dirname(resolve(root, common))), 'omo-herdr-dag-todo-companion');
  try { await lstat(join(candidate, 'package.json')); } catch { reject('Companion source checkout unavailable; supply --dag-root explicitly.'); }
  const repositories = [await collectRepository(root, 'W'), await collectRepository(candidate, 'D')];
  for (const item of repositories) {
    const directory = item.role === 'W' ? root : candidate;
    if (JSON.parse(await readFile(join(directory, 'package.json'))).name !== item.name) reject('Unexpected source package identity.');
  }
  console.log(JSON.stringify({ schema: 'omo-herdr-todo/public-record-preflight/1', repositories,
    exclusions: ['Private evidence and orchestration records', 'Native SDK copies', 'Session/task logs and identifiers', 'Auth/config profiles and machine-local paths', 'New captured screenshots', 'Untracked or dirty source'],
    syntheticFixtures: 'Only exact reviewed file/content/violation hashes are exempt; every file remains scanned for added private or credential content.',
    externalWriteAuthorized: false, externalWritesPerformed: false, publication: 'Pending separate approval; no push, PR, release, npm publication or primary activation.' }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof PreflightFailure ? error.message : 'Local inspection failed; verify the supplied source roots.'); process.exitCode = 1; });
}
