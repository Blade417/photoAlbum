import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const hook = fileURLToPath(new URL('./git-pre-push.mjs', import.meta.url));
const setup = fileURLToPath(new URL('./repo-setup.mjs', import.meta.url));
const zero = '0'.repeat(40);
const usageUrl = 'https://example.invalid/private/album.git';
const githubUrl = 'git@github.com:example/album.git';

function repository(t, role = 'usage') {
  const directory = mkdtempSync(join(tmpdir(), 'album-push-check-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const url = role === 'template' ? githubUrl : usageUrl;
  git('remote', 'add', 'origin', url);
  execFileSync(process.execPath, [setup, role], { cwd: directory, stdio: 'pipe' });
  const commit = (path, content) => {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), content);
    git('add', path);
    git('commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const check = (sha, options = {}) => spawnSync(process.execPath, [hook, options.remote ?? 'origin', options.url ?? url], {
    cwd: directory, encoding: 'utf8', input: `refs/heads/main ${sha} ${options.ref ?? 'refs/heads/main'} ${options.base ?? zero}\n`,
  });
  return { directory, git, commit, check, url };
}

test('push guard accepts clean code and example environment files', t => {
  const r = repository(t);
  r.commit('src/app.js', 'export const album = true;');
  const sha = r.commit('.env.example', '# No credentials required.\n');
  assert.equal(r.check(sha).status, 0);
});

test('push guard rejects GitHub and alternate destinations from the usage edition', t => {
  const r = repository(t);
  const sha = r.commit('app.js', 'export {};');
  assert.notEqual(r.check(sha, { url: githubUrl }).status, 0);
  assert.notEqual(r.check(sha, { remote: 'template' }).status, 0);
});

test('push guard rejects private files even when deleted by a later commit', t => {
  for (const path of ['.env.production', 'public/media/memory-001.jpg', 'public/album-content.json', 'local/runtime.sqlite', '.history/app.js']) {
    const r = repository(t);
    r.commit(path, 'private fixture');
    r.git('rm', path);
    r.git('commit', '-m', 'remove fixture');
    const result = r.check(r.git('rev-parse', 'HEAD'));
    assert.notEqual(result.status, 0, path);
    assert.match(result.stderr, /Private\/generated file/);
  }
});

test('push guard checks historical credential additions without printing their value', t => {
  const r = repository(t);
  const fakeToken = ['ghp', 'A'.repeat(40)].join('_');
  r.commit('app.js', JSON.stringify({ access_token: fakeToken }));
  const sha = r.commit('app.js', 'export {};');
  const result = r.check(sha);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Possible credential/);
  assert.ok(!result.stderr.includes(fakeToken));
});

test('new template branches do not rescan history already present on origin', t => {
  const r = repository(t, 'template');
  const old = r.commit('public/album-content.json', '{"memories":{"personal":{}}}');
  r.git('update-ref', 'refs/remotes/origin/main', old);
  const sha = r.commit('app.js', 'export {};');
  assert.equal(r.check(sha, { ref: 'refs/heads/codex/common-fix' }).status, 0);
});

test('push guard rejects internal snapshot refs and missing checkout setup', t => {
  const r = repository(t);
  const sha = r.commit('app.js', 'export {};');
  assert.notEqual(r.check(sha, { ref: 'refs/agents/snapshot' }).status, 0);
  r.git('config', '--unset', 'photoalbum.role');
  assert.notEqual(r.check(sha).status, 0);
});
