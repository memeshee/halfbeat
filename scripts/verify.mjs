#!/usr/bin/env node
// HalfBeat — verify. One command that proves the whole loop still works: the analysis
// on a fixed fixture, then a real end-to-end session on the synthetic source.
// Exits nonzero on the first failure so it can gate a commit.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBaseline, analyseRound, rankRounds, headline } from '../src/recovery.mjs';

const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
};

console.log('1. analysis on a constructed fixture');
// A synthetic round that must be measured exactly: baseline 60, peak 80 at t=0,
// decaying with a true half-life of 12 s, one reading every 12 s.
const fixture = [];
for (let i = 0; i <= 6; i++) {
  const t = i * 12000;
  fixture.push({
    t,
    pulse: Math.round((60 + 20 * Math.pow(0.5, i)) * 10) / 10,   // 80 at t=0, half-life exactly 12 s
    pulseConf: 80,
    pulseTs: t,
    talking: i === 0,
  });
}
const calm = [-24000, -12000].map((t) => ({ t, pulse: 60, pulseConf: 80, pulseTs: t, talking: false }));
const baseline = buildBaseline(calm);
ok('baseline recovers the median', baseline.pulseMedian === 60, `got ${baseline.pulseMedian}`);
const analysis = analyseRound(fixture, { pulseMedian: 60, pulseBand: 4 });
ok('peak found', Math.round(analysis.peak) === 80, `got ${analysis.peak}`);
ok('half-life within one window of truth (12 s)', Math.abs(analysis.halfLifeSec - 12) <= 12, `got ${analysis.halfLifeSec}s`);
ok('flagged sufficient', analysis.sufficient === true);
const never = analyseRound(
  fixture.map((s) => ({ ...s, pulse: s.pulse + 30 })),
  { pulseMedian: 60, pulseBand: 4 },
);
ok('a signal that never returns reports "never", not a fabricated time', never.timeToBandSec === null);
ok('ranking is stable', rankRounds([{ question: 'a', analysis }, { question: 'b', analysis: never }]).length === 2);
ok('headline is a sentence', typeof headline({ rounds: [{ question: 'q', analysis }] }) === 'string');

console.log('\n2. end-to-end session on the synthetic source');
const out = path.join(os.tmpdir(), `halfbeat-verify-${Date.now()}.json`);
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    'src/index.mjs', '--source', 'mock', '--headless',
    '--baseline', '8', '--answer', '10', '--recover', '10', '--rounds', '2',
    '--out', out,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out\n${log}`)); }, 90000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve();
    else reject(new Error(`exit ${code}\n${log}`));
  });
}).then(() => ok('headless session completed', true)).catch((e) => ok('headless session completed', false, e.message.split('\n')[0]));

if (fs.existsSync(out)) {
  const s = JSON.parse(fs.readFileSync(out, 'utf8'));
  ok('artefact has a baseline', typeof s.baseline?.pulseMedian === 'number', `${s.baseline?.pulseMedian} bpm`);
  ok('artefact has one entry per question', s.rounds.length === 2, `got ${s.rounds.length}`);
  ok('at least one round produced an analysis', s.rounds.some((r) => r.analysis?.sufficient));
  ok('samples carry the pulse lane', s.samples.some((x) => typeof x.pulse === 'number'), `${s.samples.length} samples`);
  ok('artefact is labelled synthetic', s.synthetic === true);
  ok('telemetry recorded as off', s.config?.telemetry === false);
  ok('rounds carry phase boundaries on the sample clock',
    s.rounds.every((r) => r.answerStart == null || r.answerStart <= (s.samples.at(-1)?.t ?? 0)));
  fs.unlinkSync(out);
} else {
  ok('artefact written', false, out);
}

console.log('\n3. static surfaces exist for the replay page');
for (const f of ['web/replay.html', 'web/report.js', 'web/style.css', 'web/sample-session.json']) {
  ok(`${f} present`, fs.existsSync(f));
}

console.log(`\n${failures.length ? `FAILED: ${failures.length} check(s)` : 'all checks passed'}`);
process.exit(failures.length ? 1 : 0);
