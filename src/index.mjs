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

// Resolve the artefact path once, up front: the server's report handler and this file's
// handler both fire, and the server needs to know which file is *this* session so it never
// offers it back as a comparison.
if (!cfg.out) cfg.out = path.join('sessions', `session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

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

// One exit path for every way a session can end early: stop button, SIGINT, SIGTERM.
// It flushes what exists to its own file — never over cfg.out, which belongs to a finished run.
async function flushAndExit(reason) {
  try { await session.abort(); } catch { /* keep going: the flush matters more */ }
  try { serverHandle?.close(); } catch { /* already closed */ }
  const draft = session.buildSession();
  if (draft.samples.length) {
    const out = path.join(cfg.sessionsDir ?? 'sessions', `aborted-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(draft, null, 1));
    console.log(`\nstopped (${reason}); partial session → ${out}`);
  } else {
    console.log(`\nstopped (${reason}); nothing was captured, nothing saved`);
  }
  try { await source.stop(); } catch { /* the device may already be gone */ }
  process.exit(0);
}

// "Run it again" without a restart: the artefact path rotates, so a second session in the
// same process can never overwrite the first one's file.
function nextOutPath() {
  return path.join(cfg.sessionsDir ?? 'sessions', `session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}
async function restartSession() {
  session.reset();
  cfg.out = nextOutPath();
  session.ownFile = path.basename(cfg.out);
  try {
    await source.start(key);
  } catch (err) {
    console.error(`could not restart capture: ${err.message}`);
  }
  console.log(`\nnew session → ${cfg.out}`);
  return session.state();
}

let serverHandle = null;
if (!cfg.headless) {
  serverHandle = startServer({ port: cfg.port, session, cfg, onAbort: () => flushAndExit('stop button'), onRestart: restartSession });
  if (cfg.open && process.env.DISPLAY) {
    spawn('xdg-open', [`http://127.0.0.1:${cfg.port}`], { stdio: 'ignore', detached: true }).unref();
  }
}

session.on('report', async (report) => {
  const out = cfg.out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(`\n${report.headline}`);
  console.log(`session → ${out}`);
  // The report is written: capture has no further purpose. Stop the camera in every mode, not
  // just headless — the consent screen says the light goes out, and PRIVACY.md says capture stops
  // when the session ends. The server stays up so the report page still renders.
  try { await source.stop(); } catch { /* already stopped */ }
  if (cfg.headless) process.exit(0);
});

session.run ? null : null; // (clock starts on consent)

await source.start(key);

process.on('SIGINT', () => { flushAndExit('Ctrl+C'); });
// A plain `kill`, a systemd stop, or a supervisor restart used to discard the session entirely.
process.on('SIGTERM', () => { flushAndExit('SIGTERM'); });
process.on('uncaughtException', (err) => {
  console.error(`\nunexpected error: ${err.message}`);
  flushAndExit('crash');
});

console.log(`HalfBeat · source=${cfg.source}${cfg.source === 'file' ? ` (${path.basename(cfg.file)})` : ''} · key from ${from}`);
if (!cfg.headless) {
  console.log('Open the UI, grant consent, and the session runs itself from there.');
} else {
  session.consent();
  session.run();
}
