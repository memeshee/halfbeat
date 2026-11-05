// HalfBeat — local HTTP + WebSocket server. Everything stays on 127.0.0.1; the UI is
// a plain page, not a framework build, so `npm start` has no second toolchain.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { compareSessions } from './recovery.mjs';

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

export function startServer({ port = 7777, session, cfg, onAbort = null }) {
  const server = http.createServer((req, res) => {
    // A request target of `//`, `///` or `http://[` makes `new URL` throw, and a throw inside a
    // request listener is uncaught: one <img src="http://127.0.0.1:PORT//"> on any page you visit
    // would kill a running session. Guard the parse instead of trusting the target.
    let url;
    try {
      url = new URL(req.url, `http://127.0.0.1:${port}`);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
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
    // Saved sessions are ordinary files in one directory. Listing them is what makes
    // "run the same questions again and watch the number move" a product feature rather
    // than a claim in a README.
    if (url.pathname === '/api/sessions') {
      const dir = cfg.sessionsDir ?? 'sessions';
      let files = [];
      try {
        files = fs.readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          // never offer this session as its own comparison
          .filter((f) => f !== session.ownFile)
          .map((f) => {
            const full = path.join(dir, f);
            const st = fs.statSync(full);
            let headline = null;
            let rounds = null;
            try {
              const j = JSON.parse(fs.readFileSync(full, 'utf8'));
              headline = j.headline ?? null;
              rounds = (j.rounds ?? []).length;
            } catch { /* unreadable, still list it */ }
            return { name: f, mtime: st.mtimeMs, endedAt: new Date(st.mtimeMs).toISOString(), headline, rounds };
          })
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 20);
      } catch { /* no directory yet */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(files));
      return;
    }
    if (url.pathname === '/api/compare') {
      const wanted = url.searchParams.get('prev');
      const dir = cfg.sessionsDir ?? 'sessions';
      const safe = path.basename(wanted ?? '');
      const full = path.join(dir, safe);
      if (!safe || !fs.existsSync(full)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown session' }));
        return;
      }
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { /* fall through */ }
      const rows = prev ? compareSessions(prev, session.buildSession()) : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ prev: safe, rows }));
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.join(WEB, rel);
    if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });

  // Browsers do not apply the same-origin policy to WebSockets, so without this check any page
  // a user visits can open ws://127.0.0.1:PORT/ws, receive every sample, and send consent/abort.
  // A same-origin page always sends an Origin header; a non-browser client sends none.
  const localOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const u = new URL(origin);
      return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    } catch { return false; }
  };
  const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => localOrigin(req) });
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) if (client.readyState === 1) client.send(data);
  };

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'state', state: session.state() }));
    if (session.lastReport) ws.send(JSON.stringify({ type: 'report', report: session.lastReport }));
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        switch (msg.type) {
          case 'consent': session.consent(); session.run(); break;
          case 'begin': session.beginCapture(); break;
          case 'answer': session.answerNow(); break;
          case 'endAnswer': session.endAnswer(); break;
          case 'finish': session.finish(); break;
          // Flush what exists before dying: an abort used to exit with no artefact at all.
          case 'abort': await session.abort(); if (onAbort) await onAbort(); else process.exit(0); break;
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
      session.ownFile = path.basename(cfg.out);
      broadcast({ type: 'log', line: `session written to ${cfg.out}` });
    }
  });

  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE'
      ? `port ${port} is already in use — stop the other HalfBeat, or pass --port ${port + 1}`
      : `server error: ${err.message}`);
    process.exit(2);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`HalfBeat UI  →  http://127.0.0.1:${port}`);
    if (session.state().synthetic) console.log('source: MOCK (synthetic signals — not a real measurement)');
  });
  return { server, wss, close: () => { wss.close(); server.close(); } };
}
