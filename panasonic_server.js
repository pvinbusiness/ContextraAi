/**
 * Panasonic TV Remote — Local Proxy Server
 *
 * Runs on your home network so any family member can open the remote in their
 * browser without hitting browser CORS restrictions.
 *
 * Usage:
 *   node panasonic_server.js
 *
 * Then open:
 *   http://localhost:8080          (this device)
 *   http://<your-pc-ip>:8080       (any device on home WiFi)
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const HTML = path.join(__dirname, 'panasonic_remote.html');

// ── Helpers ────────────────────────────────────────────────────────────────

function buildSoap(command) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<s:Body>' +
    '<u:X_SendKey xmlns:u="urn:panasonic-com:service:p00NetworkControl:1">' +
    `<X_KeyEvent>${command}</X_KeyEvent>` +
    '</u:X_SendKey>' +
    '</s:Body>' +
    '</s:Envelope>'
  );
}

function tvRequest(ip, pathStr, method, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body, 'utf8') : null;

    const opts = {
      hostname: ip,
      port: 55000,
      path: pathStr,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sendCommand(ip, command) {
  const soap = buildSoap(command);
  return tvRequest(ip, '/nrc/control_0', 'POST', soap, {
    'Content-Type': 'text/xml; charset=utf-8',
    'SOAPAction': '"urn:panasonic-com:service:p00NetworkControl:1#X_SendKey"',
  });
}

function pingTV(ip) {
  return tvRequest(ip, '/nrc/sdd_0.xml', 'GET', null, {}).then(
    (r) => r.status < 500,
    () => false
  );
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = req.url.split('?')[0];

  // CORS pre-flight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ── API: send key command ──────────────────────────────────────────────
  if (url === '/api/send' && method === 'POST') {
    try {
      const { ip, command } = JSON.parse(await readBody(req));
      if (!ip || !command) return json(res, 400, { ok: false, error: 'Missing ip or command' });
      await sendCommand(ip, command);
      console.log(`[send] ${ip} → ${command}`);
      json(res, 200, { ok: true });
    } catch (err) {
      console.error('[send] error:', err.message);
      json(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── API: ping TV ───────────────────────────────────────────────────────
  if (url === '/api/ping' && method === 'POST') {
    try {
      const { ip } = JSON.parse(await readBody(req));
      if (!ip) return json(res, 400, { ok: false, error: 'Missing ip' });
      const ok = await pingTV(ip);
      console.log(`[ping] ${ip} → ${ok ? 'online' : 'offline'}`);
      json(res, 200, { ok });
    } catch (err) {
      json(res, 200, { ok: false });
    }
    return;
  }

  // ── Serve HTML remote ──────────────────────────────────────────────────
  if (url === '/' || url === '/index.html') {
    fs.readFile(HTML, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('panasonic_remote.html not found — make sure both files are in the same folder');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ── Start ──────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  const line = '─'.repeat(50);
  console.log(`\n🎮  Panasonic VIERA Remote — Local Server`);
  console.log(line);
  console.log(`✅  Listening on port ${PORT}\n`);
  console.log(`📱  Open on THIS device:`);
  console.log(`    http://localhost:${PORT}\n`);
  if (ips.length) {
    console.log(`📡  Share with family (same WiFi):`);
    ips.forEach((ip) => console.log(`    http://${ip}:${PORT}`));
  }
  console.log(`\n💡  Keep this window open while using the remote.`);
  console.log(`    Press Ctrl+C to stop.\n`);
  console.log(line);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌  Port ${PORT} is already in use.`);
    console.error(`    Try: PORT=8081 node panasonic_server.js\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
