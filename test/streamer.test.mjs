import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../src/main/streamer.js');

async function request(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, method }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

let blocker;
try {
  assert.deepEqual(S.getStatus(), { running: false, port: null, streaming: null, detectionAvailable: false });
  for (const invalid of [-1, 65536, 1.5, '24164', null, NaN]) {
    await assert.rejects(async () => S.start(invalid), /port/i);
  }
  const [a, b] = await Promise.all([S.start(0), S.start(0)]);
  assert.deepEqual(a, b, 'concurrent start shares one listener');
  assert.ok(a.running && a.port > 0, 'start resolves only after bind');
  const status = await request(a.port, '/api/status');
  assert.equal(status.code, 200);
  assert.deepEqual(status.body, a);
  assert.equal(status.headers['access-control-allow-origin'], undefined);
  const streaming = await request(a.port, '/api/streaming');
  assert.equal(streaming.body.streaming, null, 'unknown must not claim false');
  assert.equal(streaming.body.detectionAvailable, false);
  assert.equal((await request(a.port, '/missing')).code, 404);
  assert.equal((await request(a.port, '/api/status', {}, 'POST')).code, 405);
  assert.equal((await request(a.port, '/api/status', { Host: 'evil.example' })).code, 403);
  assert.equal((await request(a.port, '/api/status', { Origin: 'https://evil.example' })).code, 403);
  assert.equal((await request(a.port, 'http://evil.example/api/status')).code, 400);
  const stopped = await S.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.port, null);
  await S.stop();
  // Rebind the same port: stop resolves only after releasing the listener.
  await S.start(a.port);
  await S.stop();
  blocker = http.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  await assert.rejects(S.start(blocker.address().port), { code: 'EADDRINUSE' });
  assert.equal(S.getStatus().running, false);
  assert.equal(S.getStatus().port, null);
  const [started, stoppedDuringStart] = await Promise.all([S.start(0), S.stop()]);
  assert.equal(started.running, true);
  assert.equal(stoppedDuringStart.running, false, 'stop waits for pending bind');
  await S.start(0);
  await Promise.all([S.stop(), S.stop()]);
  console.log('PASS: streamer lifecycle + loopback + HTTP boundaries');
} finally {
  await S.stop();
  if (blocker?.listening) await new Promise(resolve => blocker.close(resolve));
}
