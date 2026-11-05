#!/usr/bin/env node
// HalfBeat — evaluation harness. Runs a fixed set of clips through the *real* SDK on
// the recorded-input path and writes docs/EVAL.md. The point is to publish the
// numbers that make the product's claim checkable, including the clip it fails on.
//
//   node scripts/eval.mjs clips/*.mp4          (needs a SmartSpectra API key)
//
// Never published as a user-facing measurement: this table is about the pipeline,
// not about the people in the clips.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveApiKey } from '../src/config.mjs';

const clips = process.argv.slice(2);
if (!clips.length) {
  console.error('usage: node scripts/eval.mjs <clip> [clip…]');
  process.exit(2);
}
const { key, from } = resolveApiKey();
if (!key) {
  console.error('No API key (expected in ~/.presage_api_key or SMARTSPECTRA_API_KEY).');
  process.exit(2);
}
console.log(`key from ${from}`);

const rows = [];
for (const clip of clips) {
  const name = path.basename(clip);
  const out = path.join(os.tmpdir(), `halfbeat-eval-${Date.now()}-${rows.length}.json`);
  // 90 s ceiling per clip: enough for pulse (12 s windows) and a 60 s HRV window.
  // The first pulse window needs ~30 s of warm-up in recorded mode (measured): a shorter
  // baseline returns zero readings and the integrity gate — correctly — refuses to score.
  const args = ['src/index.mjs', '--source', 'file', '--file', clip, '--headless',
    '--baseline', '45', '--answer', '25', '--recover', '25', '--rounds', '1',
    '--max-seconds', '105', '--out', out];
  process.stdout.write(`\n▶ ${name}\n`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(124); }, 260000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  if (code !== 0 || !fs.existsSync(out)) {
    rows.push({ name, status: `failed (exit ${code})` });
    continue;
  }
  const s = JSON.parse(fs.readFileSync(out, 'utf8'));
  const pulses = s.samples.filter((x) => typeof x.pulse === 'number' && (x.pulseConf ?? 0) >= 40);
  const uniq = new Map(pulses.map((p) => [p.pulseTs ?? p.t, p]));
  const vals = [...uniq.values()].map((p) => p.pulse);
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const sd = vals.length > 1 ? Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (vals.length - 1)) : null;
  const analysis = s.rounds?.[0]?.analysis ?? {};
  rows.push({
    name,
    status: 'ok',
    samples: s.samples.length,
    pulseReadings: vals.length,
    meanPulse: mean == null ? null : Math.round(mean * 10) / 10,
    sd: sd == null ? null : Math.round(sd * 10) / 10,
    conf: vals.length ? Math.round(uniq.size ? [...uniq.values()].reduce((a, p) => a + (p.pulseConf ?? 0), 0) / uniq.size : 0) : null,
    faceShare: s.samples.length ? Math.round((s.samples.filter((x) => x.talking !== null).length / s.samples.length) * 100) : null,
    peak: analysis.peak ?? null,
    timeToBand: analysis.timeToBandSec ?? null,
    halfLife: analysis.halfLifeSec ?? null,
    sufficient: !!analysis.sufficient,
  });
  fs.unlinkSync(out);
}

const fmt = (v, suffix = '') => (v == null ? '—' : `${v}${suffix}`);
const lines = [
  '# Pipeline evaluation — recorded input',
  '',
  `Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC by \`scripts/eval.mjs\`.`,
  '',
  'These runs use the SDK\'s recorded-video input path (`useFile()`), paced at the clip\'s native',
  'frame rate. They measure **the pipeline**, not the people in the footage: the question is whether',
  'the app produces usable, stable, honestly-caveated numbers from a file, and where it does not.',
  '',
  '| clip | samples | pulse readings | mean bpm | sd | mean confidence | face present | peak | back down | half-life | verdict |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => r.status === 'ok'
    ? `| ${r.name} | ${r.samples} | ${r.pulseReadings} | ${fmt(r.meanPulse)} | ${fmt(r.sd)} | ${fmt(r.conf)} | ${fmt(r.faceShare, '%')} | ${fmt(r.peak ? Math.round(r.peak) : null)} | ${fmt(r.timeToBand, 's')} | ${fmt(r.halfLife, 's')} | ${r.sufficient ? 'analysed' : 'insufficient signal'} |`
    : `| ${r.name} | — | — | — | — | — | — | — | — | — | ${r.status} |`),
  '',
  '## What this table is for',
  '',
  '- A clip with **zero pulse readings** is the useful negative result: it says the pipeline refuses to',
  '  invent a number when the footage is unusable, which is the behaviour the product depends on.',
  '- The spread (`sd`) is the honest noise floor of a 12-second-average pulse on recorded input; a',
  '  recovery half-life below that noise floor is not a result, it is a rounding artefact.',
  '- Every number here is intra-clip. Nothing is benchmarked against a population.',
  '',
];

const target = path.join('docs', 'EVAL.md');
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync(target, lines.join('\n'));
console.log(`\nwrote ${target}`);
