// Local read-only HTTP status. ponytail: process detection is unavailable;
// wire the native provider before reporting a boolean streaming status.
const http = require('node:http');

let server = null;
let queue = Promise.resolve();
function serialize(action) {
  const result = queue.then(action);
  queue = result.catch(() => {});
  return result;
}
function getStatus() {
  const address = server?.address();
  return {
    running: !!address, port: address?.port ?? null,
    streaming: null, detectionAvailable: false,
  };
}
function respond(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (code, body) => { res.writeHead(code); res.end(JSON.stringify(body)); };
  const port = getStatus().port;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) || req.headers.origin) {
    return send(403, { error: 'local clients only' });
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(405, { error: 'method not allowed' });
  }
  if (!req.url.startsWith('/') || req.url.startsWith('//')) return send(400, { error: 'invalid path' });
  let pathname;
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; }
  catch { return send(400, { error: 'invalid path' }); }
  if (pathname === '/api/status') return send(200, getStatus());
  if (pathname === '/api/streaming') {
    return send(200, { streaming: null, detectionAvailable: false, reason: 'native process detection unavailable' });
  }
  send(404, { error: 'not found' });
}
async function start(port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Invalid port');
  return serialize(async () => {
    if (server) return getStatus();
    const candidate = http.createServer(respond);
    candidate.requestTimeout = 5000;
    candidate.headersTimeout = 5000;
    await new Promise((resolve, reject) => {
      const fail = error => { candidate.removeListener('listening', ready); reject(error); };
      const ready = () => { candidate.removeListener('error', fail); resolve(); };
      candidate.once('error', fail);
      candidate.once('listening', ready);
      candidate.listen(port, '127.0.0.1');
    });
    server = candidate;
    candidate.on('error', error => console.error('[streamer]', error.message));
    return getStatus();
  });
}
function stop() {
  return serialize(async () => {
    if (server) {
      const current = server;
      await new Promise((resolve, reject) => {
        current.close(error => error ? reject(error) : resolve());
        current.closeAllConnections();
      });
      server = null;
    }
    return getStatus();
  });
}
module.exports = { start, stop, getStatus };
