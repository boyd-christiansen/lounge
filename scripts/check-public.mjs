// Check only the current branch's reachable history: local private branches
// intentionally remain on this machine and must never be pushed or merged.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const privatePath = /(?:^|\/)(?:\.env(?:\..*)?|private\.env|auth\.json|credentials(?:\.json)?|.*\.(?:sqlite(?:-.*)?|db(?:-.*)?|pem|p12|pfx|key))$/i;
const privateText = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}/,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{25,}/,
  /(?:\/Users\/|\/home\/)[a-zA-Z][a-zA-Z0-9._-]*\//,
];
const failures = new Set();
function inspect(path, bytes) {
  if (privatePath.test(path) || path.startsWith('data/') && path !== 'data/.gitkeep') failures.add(`${path}: private runtime file`);
  if (bytes.includes(0)) return; // raster assets and other binary files
  if (privateText.some(pattern => pattern.test(bytes.toString('utf8')))) failures.add(`${path}: credential or private home path pattern`);
}
for (const path of git(['ls-files', '-z']).split('\0').filter(Boolean)) inspect(path, readFileSync(path));
if (!process.argv.includes('--working-tree')) {
  const seen = new Set();
  for (const line of git(['rev-list', '--objects', 'HEAD']).split('\n')) {
    const match = line.match(/^([a-f0-9]+) (.+)$/); if (!match) continue;
    const [, oid, path] = match;
    if (seen.has(oid) || git(['cat-file', '-t', oid]).trim() !== 'blob') continue;
    seen.add(oid); inspect(path, execFileSync('git', ['cat-file', 'blob', oid], { maxBuffer: 32 * 1024 * 1024 }));
  }
}
if (failures.size) { console.error([...failures].join('\n')); process.exitCode = 1; }
else console.log('Public source check passed: no private runtime files, credential patterns or private home paths in the checked tree/history.');
