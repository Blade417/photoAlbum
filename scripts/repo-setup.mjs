import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const role = process.argv[2];
if (!['usage', 'template'].includes(role)) throw new Error('Usage: npm run repo:setup -- usage|template');
const url = git('remote', 'get-url', '--push', 'origin');
const github = /^(?:git@github\.com:|https:\/\/github\.com\/)/i.test(url);
if ((role === 'template') !== github) throw new Error('Remote does not match the selected repository role.');
if (/^https?:\/\//i.test(url) && new URL(url).username) throw new Error('Remote URLs must not contain credentials.');
git('config', '--local', 'photoalbum.role', role);
git('config', '--local', 'photoalbum.allowedPushUrl', url);
git('config', '--local', 'core.hooksPath', '.githooks');
git('config', '--local', 'remote.pushDefault', 'origin');
git('config', '--local', 'push.default', 'simple');
git('config', '--local', 'branch.main.pushRemote', 'origin');
console.log(`Configured ${role}; pushes are restricted to origin (${url}).`);
