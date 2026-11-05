#!/usr/bin/env node
// HalfBeat — egress measurement. A privacy claim that is not measured is a promise, so
// this script watches every outbound TCP connection the app's process tree opens while a
// session runs, and writes docs/EGRESS.md.
//
//   node scripts/egress.mjs --source file --file ../_assets/clean_face_22s.mp4 --seconds 60
//
// Exit code is 0 either way; the point is the table, not a pass/fail verdict. What we
// care about: which remote endpoints appear, and whether any of them receive video.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const seconds = Number(argv[argv.indexOf('--seconds') + 1]) || 60;
const childArgs = ['src/index.mjs', ...argv.filter((a) => a !== '--seconds' && a !== String(seconds))];

const seen = new Map();      // remote addr -> first seen ms
const samples = [];

function descendants(rootPid) {
  const pids = new Set([rootPid]);
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
    const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    let added = true;
    while (added) {
      added = false;
      for (const [p, pp] of rows) {
        if (pids.has(pp) && !pids.has(p)) { pids.add(p); added = true; }
      }
    }
  } catch { /* ps missing: fall back to the root pid only */ }
  return pids;
}

/** Outbound TCP peers owned by this app's process tree — and nobody else's.
 *  The first version of this function matched every row of `ss -tnp` that had a `users:`
 *  field, which quietly attributed the whole desktop's traffic (Telegram, Cloudflare,
 *  CloudFront) to the app. A privacy measurement that counts other programs' sockets is
 *  worse than no measurement. */
function sockets(pids) {
  try {
    const out = execFileSync('ss', ['-tnp'], { encoding: 'utf8' });
    const rows = [];
    for (const line of out.split('\n')) {
      const owners = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
      if (!owners.some((p) => pids.has(p))) continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) continue;
      const peer = cols[4];
      if (!/:\d+$/.test(peer)) continue;
      if (peer.startsWith('127.0.0.1') || peer.startsWith('[::1]') || peer.startsWith('0.0.0.0')) continue;
      rows.push(peer);
    }
    return rows;
  } catch {
    return [];
  }
}

const child = spawn(process.execPath, childArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
const started = Date.now();
const pid = child.pid;

const timer = setInterval(() => {
  const tree = descendants(pid);
  for (const peer of sockets(tree)) {
    if (!seen.has(peer)) {
      seen.set(peer, Date.now() - started);
      try {
        const rev = execFileSync('getent', ['hosts', peer.split(':')[0]], { encoding: 'utf8' }).trim();
        samples.push({ peer, reverse: rev.split(/\s+/).slice(1).join(' ') || '—', at: Math.round((Date.now() - started) / 1000) });
      } catch {
        samples.push({ peer, reverse: '—', at: Math.round((Date.now() - started) / 1000) });
      }
    }
  }
}, 500);

const killer = setTimeout(() => { try { child.kill('SIGINT'); } catch { /* gone */ } }, seconds * 1000);

await new Promise((resolve) => child.on('exit', resolve));
clearInterval(timer);
clearTimeout(killer);

const rows = [...seen.entries()].map(([peer, at]) => {
  const host = peer.split(':')[0];
  const known = samples.find((s) => s.peer === peer);
  return { peer, host, reverse: known?.reverse ?? '—', at: Math.round(at / 1000) };
});

const lines = [
  '# Measured network egress',
  '',
  `Run ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC · args: \`${childArgs.join(' ')}\` · sampled every 500 ms with \`ss -tnp\`.`,
  '',
  rows.length
    ? '| # | remote endpoint | reverse DNS | first seen |'
    : 'No outbound TCP connection was observed from the app process tree during this run.',
  ...(rows.length ? ['|---|---|---|---|', ...rows.map((r, i) => `| ${i + 1} | \`${r.peer}\` | ${r.reverse} | ${r.at}s |`)] : []),
  '',
  '## What this does and does not prove',
  '',
  '- It proves which remote TCP endpoints accepted a connection from this process while a session ran.',
  '- It does not prove *what* was sent. The app disables the SDK\'s aggregate telemetry',
  '  (`enableTelemetry: false`) and never calls `requestInsight()`, so no vitals or frames are',
  '  handed anywhere by this code — but the SDK is a closed native binary, and the honest statement is',
  '  the connection list above, not a claim about the bytes.',
  '- Runtime metric computation is on-device: no frames are uploaded to compute pulse.',
  '',
];

fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync(path.join('docs', 'EGRESS.md'), lines.join('\n'));
console.log(`\n${rows.length} remote endpoint(s) observed → docs/EGRESS.md`);
process.exit(0);
