// HalfBeat — local HTTP + WebSocket server. Everything stays on 127.0.0.1; the UI is
// a plain page, not a framework build, so `npm start` has no second toolchain.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function startServer({ port = 7777, session, cfg }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/session') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(session.buildSession()));
      return;
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(session.state()));
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.join(WEB, rel);
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) if (client.readyState === 1) client.send(data);
  };

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'state', state: session.state() }));
    if (session.lastReport) ws.send(JSON.stringify({ type: 'report', report: session.lastReport }));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        switch (msg.type) {
          case 'consent': session.consent(); session.run(); break;
          case 'begin': session.beginCapture(); break;
          case 'answer': session.answerNow(); break;
          case 'endAnswer': session.endAnswer(); break;
          case 'finish': session.finish(); break;
          case 'abort': session.abort().then(() => process.exit(0)); break;
          default: break;
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'log', line: `error: ${err.message}` }));
      }
    });
  });

  session.on('state', (state) => broadcast({ type: 'state', state }));
  session.on('sample', (sample) => broadcast({ type: 'sample', sample }));
  session.on('baseline', (baseline) => broadcast({ type: 'baseline', baseline }));
  session.on('log', (line) => broadcast({ type: 'log', line }));
  session.on('error', (e) => broadcast({ type: 'log', line: `SDK error ${e.code}: ${e.message}` }));
  session.on('report', (report) => {
    session.lastReport = report;
    broadcast({ type: 'report', report });
    if (cfg.out) {
      fs.mkdirSync(path.dirname(cfg.out), { recursive: true });
      fs.writeFileSync(cfg.out, JSON.stringify(report, null, 1));
      broadcast({ type: 'log', line: `session written to ${cfg.out}` });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`HalfBeat UI  →  http://127.0.0.1:${port}`);
    if (session.state().synthetic) console.log('source: MOCK (synthetic signals — not a real measurement)');
  });
  return { server, wss, close: () => { wss.close(); server.close(); } };
}
