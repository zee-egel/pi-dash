import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import { DockerService } from '../src/docker.js';
import { buildServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import type { Snapshot, ContainerDetail } from '../../../shared/types.js';

test('real Docker: discovery, safe detail projection, actions, SSE and multiplexed logs', { skip: process.env.RUN_DOCKER_TEST !== '1', timeout: 60_000 }, async () => {
  const socketPath = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
  const docker = new Docker({ socketPath });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-docker-test-'));
  const salt = randomBytes(16).toString('hex'); const password = randomBytes(24).toString('hex');
  const secret = 'secret-value-must-never-leak-in-details';
  const config = parseConfig({ SESSION_SECRET: randomBytes(32).toString('hex'), ADMIN_PASSWORD_HASH: `scrypt:${salt}:${scryptSync(password, salt, 64, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }).toString('hex')}`, PUBLIC_ORIGIN: 'http://localhost:3000', COOKIE_SECURE: 'false', DATA_DIR: directory, DOCKER_SOCKET: socketPath });
  const server = await buildServer(config, [], { monitor: false, logger: false });
  // This opt-in test only mutates its own explicitly created disposable container.
  const container = await docker.createContainer({ Image: process.env.TEST_IMAGE ?? 'node:22-alpine', name: `pi-control-test-${randomBytes(5).toString('hex')}`, Env: [`TEST_SECRET=${secret}`], Cmd: ['node', '-e', 'console.log("control-center-log-check");console.error("stderr-check");setInterval(()=>{},1000)'], HostConfig: { NetworkMode: 'none', Memory: 128 * 1024 * 1024 } });
  try {
    const login = await server.inject({ method: 'POST', url: '/api/login', headers: { origin: config.PUBLIC_ORIGIN }, payload: { username: 'admin', password } });
    assert.equal(login.statusCode, 200);
    const headers = { cookie: login.headers['set-cookie']!.toString().split(';')[0], origin: config.PUBLIC_ORIGIN, 'x-csrf-token': login.json<{ csrf: string }>().csrf };
    const action = async (value: string) => {
      const response = await server.inject({ method: 'POST', url: `/api/containers/${container.id}/action`, headers, payload: { action: value } });
      assert.equal(response.statusCode, 200, response.body);
    };
    await action('start');
    const snapshotResponse = await server.inject({ url: '/api/snapshot', headers });
    const snapshot = snapshotResponse.json<Snapshot>();
    if (snapshot.errors.docker) await new DockerService(socketPath).list();
    assert.equal(snapshot.containers.find(item => item.id === container.id)?.state, 'running');
    const detailResponse = await server.inject({ url: `/api/containers/${container.id}`, headers });
    const detail = detailResponse.json<ContainerDetail>();
    assert.ok(detail.environmentNames.includes('TEST_SECRET'));
    assert.ok(!detailResponse.body.includes(secret));
    assert.ok(!detailResponse.body.includes('HostConfig'));
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    for (const endpoint of ['/api/events', `/api/containers/${container.id}/logs?tail=20`]) {
      const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), 10_000);
      try {
        const response = await fetch(base + endpoint, { headers: { cookie: headers.cookie }, signal: abort.signal });
        assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
        const reader = response.body!.getReader(); let received = '';
        const expected = endpoint === '/api/events' ? 'event: snapshot' : 'stderr-check';
        while (!received.includes(expected)) { const chunk = await reader.read(); if (chunk.done) break; received += new TextDecoder().decode(chunk.value); }
        assert.ok(received.includes(expected), received);
        if (endpoint !== '/api/events') assert.ok(received.includes('control-center-log-check'));
      } finally { clearTimeout(timeout); abort.abort(); }
    }
    await action('restart'); await action('stop');
    assert.equal((await container.inspect()).State.Running, false);
  } finally { await container.remove({ force: true }); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
