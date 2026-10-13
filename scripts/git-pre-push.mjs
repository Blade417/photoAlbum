import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const fail = message => { console.error(`Push blocked: ${message}`); process.exit(1); };
let role, allowed;
try {
  role = git('config', '--local', '--get', 'photoalbum.role');
  allowed = git('config', '--local', '--get', 'photoalbum.allowedPushUrl');
} catch { fail('Run npm run repo:setup -- usage|template first.'); }
const [remote, url] = process.argv.slice(2);
if (!['usage', 'template'].includes(role) || remote !== 'origin' || url !== allowed) fail('Destination differs from this checkout\'s configured origin.');
const github = /^(?:git@github\.com:|https:\/\/github\.com\/)/i.test(url);
if ((role === 'template') !== github) fail('Destination does not match the repository role.');
const forbidden = path => {
  if (path === '.env.example' || path === 'public/media/.gitkeep') return false;
  return /(^|\/)(?:\.env(?:\..*)?|\.history|backup|backups|logs|data|local|private|node_modules|dist|test-results|playwright-report)(?:\/|$)/i.test(path)
    || /^public\/(?:media\/|media-previews\/|album-content\.json$|media-manifest\.json$)/i.test(path)
    || /\.(?:db(?:-.*)?|sqlite3?(?:-.*)?|log|bak|backup|dump|sql|pem|key|p12|pfx|bundle)$/i.test(path);
};
const secrets = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})\b|https?:\/\/[^\s/:@]+:[^\s/@]+@|(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[=:]\s*["'][^"'\r\n]{6,}["']/i;
const zero = /^0+$/;
for (const line of readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)) {
  const [, localSha, remoteRef, remoteSha] = line.split(/\s+/);
  if (!remoteRef.startsWith('refs/heads/')) fail('Only branch pushes are allowed; internal snapshot refs and tags require separate review.');
  if (zero.test(localSha)) continue;
  let commits;
  try { commits = git('rev-list', localSha, ...(zero.test(remoteSha) ? ['--not', '--remotes=origin'] : [`^${remoteSha}`])).split('\n').filter(Boolean); }
  catch { fail('Cannot inspect the remote base; fetch origin before pushing.'); }
  for (const commit of commits) {
    const names = git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-m', '--diff-filter=ACMRT', commit).split('\n').filter(Boolean);
    const bad = names.find(forbidden);
    if (bad) fail(`Private/generated file in outgoing commit ${commit.slice(0, 8)}: ${bad}`);
    const patch = git('show', '--format=', '--no-ext-diff', '--unified=0', '-m', commit, '--');
    const additions = patch.split('\n').filter(row => row.startsWith('+') && !row.startsWith('+++')).join('\n');
    if (secrets.test(additions)) fail(`Possible credential in outgoing commit ${commit.slice(0, 8)}. Review locally; do not print its value.`);
  }
}
console.log(`Push checks passed (${role}, origin).`);
