#!/usr/bin/env node
// HalfBeat — entry point. Owns the process: config → source → session → UI/server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveApiKey, HELP } from './config.mjs';
import { Source } from './source.mjs';
import { Session } from './session.mjs';
import { startServer } from './server.mjs';

const cfg = parseArgs();
if (cfg.help) { console.log(HELP); process.exit(0); }

const { key, from } = resolveApiKey(cfg.key);
if (cfg.source !== 'mock' && !key) {
  console.error(`
No SmartSpectra API key found.

  1. Create a free trial account:  https://physiology.presagetech.com/auth/register
  2. Copy the API key from the developer portal
  3. echo 'YOUR_KEY' > ~/.presage_api_key     (or export SMARTSPECTRA_API_KEY=...)

To work on the UI without a key:  npm run replay   (synthetic signals, clearly labelled)
`);
  process.exit(2);
}

const source = new Source(cfg);
const session = new Session(cfg, source);

source.on('log', (line) => console.log(`[source] ${line}`));

// Auto-pilot: used by --headless and by the eval harness so a session can run
// end-to-end with nobody clicking.
const auto = cfg.headless;
if (auto) {
  session.on('state', (s) => {
    if (s.phase === 'consent') session.consent();
    else if (s.phase === 'check') session.beginCapture();
    else if (s.phase === 'question') setTimeout(() => session.answerNow(), 1200);
  });
}

session.on('baseline', (b) => {
  console.log(`[baseline] ${b.pulseMedian ?? '—'} bpm  ±${b.pulseBand}  (${b.readings} readings over ${b.windowSec}s)`);
});

let serverHandle = null;
if (!cfg.headless) {
  serverHandle = startServer({ port: cfg.port, session, cfg });
  if (cfg.open && process.env.DISPLAY) {
    spawn('xdg-open', [`http://127.0.0.1:${cfg.port}`], { stdio: 'ignore', detached: true }).unref();
  }
}

session.on('report', (report) => {
  const out = cfg.out ?? path.join('sessions', `session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(`\n${report.headline}`);
  console.log(`session → ${out}`);
  if (cfg.headless) {
    source.stop().then(() => process.exit(0));
  }
});

session.run ? null : null; // (clock starts on consent)

await source.start(key);

process.on('SIGINT', async () => {
  await session.abort();
  serverHandle?.close();
  const draft = session.buildSession();
  if (draft.samples.length) {
    const out = cfg.out ?? path.join('sessions', `aborted-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(draft, null, 1));
    console.log(`\naborted; partial session → ${out}`);
  }
  process.exit(0);
});

console.log(`HalfBeat · source=${cfg.source}${cfg.source === 'file' ? ` (${path.basename(cfg.file)})` : ''} · key from ${from}`);
if (!cfg.headless) {
  console.log('Open the UI, grant consent, and the session runs itself from there.');
} else {
  session.consent();
  session.run();
}
