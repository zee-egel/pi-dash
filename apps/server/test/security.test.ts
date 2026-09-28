import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server.js';
import { parseConfig, appsSchema, appSchema } from '../src/config.js';
import { verifyPassword } from '../src/auth.js';
import { actionSchema, containerId } from '../src/docker.js';
import { deploymentCommands } from '../src/deployments.js';
import { parseCpu, parseMemory, parseNetwork } from '../src/metrics.js';
const salt = '1234567890abcdef1234567890abcdef';
const password = 'a-long-local-test-password';
const hash = `scrypt:${salt}:${scryptSync(password, salt, 64, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }).toString('hex')}`;
const env = { SESSION_SECRET: 'x'.repeat(64), ADMIN_PASSWORD_HASH: hash, PUBLIC_ORIGIN: 'http://localhost:3000', COOKIE_SECURE: 'false' };

test('scrypt verifies passwords and rejects a wrong password', async () => {
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
});
test('startup configuration rejects missing secrets and insecure remote cookies', () => {
  assert.throws(() => parseConfig({}));
  assert.throws(() => parseConfig({ ...env, PUBLIC_ORIGIN: 'http://pi.example.com' }));
  assert.throws(() => parseConfig({ ...env, PUBLIC_ORIGIN: 'http://localhost:3000/path' }));
  assert.equal(parseConfig(env).PORT, 3000);
});
test('deployment config and command plan reject browser-like arbitrary execution inputs', () => {
  const app = { id: 'demo', name: 'Demo', directory: '/srv/demo', branch: 'main' };
  assert.equal(appsSchema.parse({ apps: [app] }).apps.length, 1);
  for (const bad of [{ command: 'whoami' }, { branch: '--upload-pack=evil' }, { branch: 'main;touch /tmp/pwn' }, { composeFile: '../secrets.yml' }, { composeFile: '/tmp/evil.yml' }, { directory: 'relative' }, { id: 'bad/id' }]) assert.equal(appSchema.safeParse({ ...app, ...bad }).success, false);
  assert.equal(appsSchema.safeParse({ apps: [app, app] }).success, false);
  const plan = deploymentCommands(appSchema.parse({ ...app, build: true }));
  assert.deepEqual(plan.map(step => step.command), ['git', 'git', 'docker', 'docker', 'docker']);
  assert.deepEqual(plan[1].args, ['merge', '--ff-only', 'refs/remotes/origin/main']);
  assert.deepEqual(plan[4].args, ['compose', '--project-name', 'demo', '--file', 'docker-compose.yml', 'up', '-d', '--wait', '--wait-timeout', '120']);
});
test('container actions are an exact allowlist with canonical IDs', () => {
  for (const action of ['start', 'stop', 'restart']) assert.equal(actionSchema.safeParse({ action }).success, true);
  for (const action of ['exec', 'remove', 'kill', 'restart;whoami']) assert.equal(actionSchema.safeParse({ action }).success, false);
  assert.equal(actionSchema.safeParse({ action: 'start', command: 'whoami' }).success, false);
  assert.equal(containerId.safeParse('../containers/all').success, false);
  assert.equal(containerId.safeParse('a'.repeat(64)).success, true);
});
test('every API is authenticated; sessions, CSRF, origin, logout, and rate limits work', async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'pi-control-test-'));
  const server = await buildServer(parseConfig({ ...env, DATA_DIR: data }), [], { monitor: false, logger: false });
  try {
    const id = 'a'.repeat(64);
    for (const [method, url] of [['GET', '/api/snapshot'], ['GET', '/api/settings'], ['GET', '/api/system'], ['GET', '/api/events'], ['GET', `/api/containers/${id}`], ['GET', `/api/containers/${id}/logs`], ['POST', `/api/containers/${id}/action`], ['POST', '/api/deployments/demo'], ['POST', '/api/refresh'], ['POST', '/api/images/prune']] as const) {
      const response = await server.inject({ method, url, headers: { origin: env.PUBLIC_ORIGIN } }); assert.equal(response.statusCode, 401, url);
    }
    for (const url of ['/api%2fsnapshot', '/%61pi/snapshot', '/api/../api/snapshot', '//api/snapshot']) {
      const response = await server.inject({ url });
      assert.ok(!response.body.includes('"containers"'), `Encoded route leaked snapshot: ${url}`);
    }
    assert.equal((await server.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password } })).statusCode, 403);
    const login = await server.inject({ method: 'POST', url: '/api/login', headers: { origin: env.PUBLIC_ORIGIN }, payload: { username: 'admin', password } });
    assert.equal(login.statusCode, 200); const cookie = login.headers['set-cookie']!.toString().split(';')[0];
    assert.match(login.headers['set-cookie']!.toString(), /HttpOnly/); assert.match(login.headers['set-cookie']!.toString(), /SameSite=Strict/i);
    const csrf = login.json<{ csrf: string }>().csrf;
    const headers = { cookie, origin: env.PUBLIC_ORIGIN, 'x-csrf-token': csrf };
    assert.equal((await server.inject({ url: '/api/snapshot', headers })).statusCode, 200);
    assert.equal((await server.inject({ method: 'POST', url: '/api/logout', headers: { cookie, origin: env.PUBLIC_ORIGIN }, payload: {} })).statusCode, 403);
    assert.equal((await server.inject({ method: 'POST', url: '/api/logout', headers: { ...headers, origin: 'https://evil.example' }, payload: {} })).statusCode, 403);
    assert.equal((await server.inject({ method: 'POST', url: `/api/containers/${id}/action`, headers, payload: { action: 'exec', command: 'id' } })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/api/deployments/unknown', headers, payload: { confirm: true } })).statusCode, 404);
    assert.equal((await server.inject({ method: 'POST', url: '/api/deployments/unknown', headers, payload: { confirm: true, directory: '/tmp' } })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/api/images/prune', headers, payload: {} })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/api/logout', headers, payload: {} })).statusCode, 200);
    assert.equal((await server.inject({ url: '/api/session', headers })).statusCode, 401);
    for (let i = 0; i < 6; i++) {
      const response = await server.inject({ method: 'POST', url: '/api/login', headers: { origin: env.PUBLIC_ORIGIN }, payload: { username: 'bad', password: 'bad' } });
      if (i === 5) assert.equal(response.statusCode, 429);
    }
  } finally { await server.close(); await rm(data, { recursive: true, force: true }); }
});
test('Linux metric parsers use host counters and exclude duplicated bridge traffic', () => {
  assert.deepEqual(parseCpu('cpu  100 0 20 800 30 1 2 0 15 0\n'), { total: 953, idle: 830 });
  assert.deepEqual(parseMemory('MemTotal: 1000 kB\nMemAvailable: 400 kB\n'), { memoryTotal: 1024000, memoryUsed: 614400 });
  assert.throws(() => parseMemory(''));
  const counters = (rx: number, tx: number) => `${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`;
  assert.deepEqual(parseNetwork(`header\nheader\neth0: ${counters(100, 50)}\nlo: ${counters(800, 800)}\nveth123: ${counters(900, 900)}\n`), { rx: 100, tx: 50 });
});
