// HalfBeat — live client. Talks to the local server over WebSocket, renders the
// instrument panel and the report. No framework, no build step.
import { drawTimeline, renderReport } from './report.js';

const $ = (sel) => document.querySelector(sel);
const screens = {
  consent: $('#screen-consent'),
  check: $('#screen-check'),
  live: $('#screen-live'),
  report: $('#screen-report'),
};

let ws = null;
let state = null;
let samples = [];
let baseline = null;
let lastSample = null;
let lastSampleAt = 0;

const logBox = $('#log');
const DEBUG = new URLSearchParams(location.search).has('debug');
function log(line) {
  if (DEBUG) logBox.classList.add('show');
  const d = document.createElement('div');
  d.textContent = line;
  logBox.append(d);
  logBox.scrollTop = logBox.scrollHeight;
}

// Served from GitHub Pages there is no server to talk to. Rather than sit on "connecting…"
// forever, render the bundled session — a real capture written by the app, not a mock.
const STATIC_HOST = !/^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(location.hostname);

async function loadStatic() {
  try {
    const res = await fetch('sample-session.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const chip = $('#chip-source');
    chip.textContent = 'static replay';
    chip.className = 'chip clip';
    $('#chip-camera').textContent = 'no camera';
    onReport(data);
    // nothing here can start a session or talk to a server
    $('#btn-again').textContent = 'Run it on your machine →';
    $('#btn-again').onclick = () => { location.href = 'https://github.com/memeshee/halfbeat'; };
    $('#btn-stop').classList.add('hidden');
    $('#compare-block').classList.add('hidden');
  } catch (err) {
    $('#chip-source').textContent = 'no session to show';
    log(`static replay failed: ${err.message}`);
  }
}

function connect() {
  if (STATIC_HOST) return loadStatic();
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => log('connected to the local session');
  ws.onclose = () => { log('disconnected'); setTimeout(connect, 1200); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') onState(msg.state);
    else if (msg.type === 'sample') onSample(msg.sample);
    else if (msg.type === 'baseline') { baseline = msg.baseline; renderVitals(); }
    else if (msg.type === 'log') log(msg.line);
    else if (msg.type === 'report') onReport(msg.report);
  };
}

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('active', k === name);
}

function onState(s) {
  state = s;
  if (s.baseline) baseline = s.baseline;

  const srcChip = $('#chip-source');
  srcChip.textContent = s.synthetic ? 'mock signals' : s.source === 'file' ? 'recorded clip' : 'live camera';
  srcChip.className = `chip ${s.synthetic ? 'mock' : s.source === 'file' ? 'clip' : 'live'}`;
  $('#chip-telemetry').textContent = s.telemetry ? 'on' : 'off';
  const camChip = $('#chip-camera');
  if (camChip) {
    const on = s.consented && s.phase !== 'report' && !s.synthetic;
    camChip.textContent = s.synthetic ? 'no camera · mock' : on ? 'camera capturing' : 'camera off';
    camChip.className = `chip ${on ? 'on' : 'off'}`;
  }

  if (s.phase === 'consent') show('consent');
  else if (s.phase === 'check') { show('check'); renderCheck(s); }
  else if (['baseline', 'question', 'answer', 'recover'].includes(s.phase)) { show('live'); renderLive(s); }
  else if (s.phase === 'report') { /* handled by onReport */ }
}

function renderCheck(s) {
  const v = s.validation ?? {};
  const code = v.code ?? 0;
  const faceEl = $('#check-face');
  const lightEl = $('#check-light');
  const sigEl = $('#check-signal');
  const set = (node, text, cls) => { node.textContent = text; node.className = `v ${cls}`; };
  if (code === 0) { set(faceEl, 'face found', 'ok'); set(lightEl, 'ok', 'ok'); }
  else if (code === 1) { set(faceEl, 'no face', 'bad'); set(lightEl, '—', ''); }
  else if (code === 5 || code === 6) { set(faceEl, 'face found', 'ok'); set(lightEl, code === 5 ? 'too dark' : 'too bright', 'bad'); }
  else { set(faceEl, v.hint ?? 'checking', 'warn'); set(lightEl, '—', ''); }
  const fresh = lastSample && Date.now() - lastSampleAt < 4000;
  set(sigEl, fresh ? 'signals arriving' : 'waiting…', fresh ? 'ok' : 'warn');
  $('#check-hint').textContent = s.synthetic
    ? 'Mock source: no camera is being used. The framing check is simulated.'
    : (v.hint && v.hint !== 'ok' ? v.hint : 'Hold still for a second while the SDK locks on.');
}

function onSample(s) {
  lastSample = s;
  lastSampleAt = Date.now();
  samples.push(s);
  if (samples.length > 4000) samples = samples.slice(-3000);
  renderVitals();
  if (state && ['baseline', 'question', 'answer', 'recover'].includes(state.phase)) drawLive();
}

function renderVitals() {
  const s = lastSample;
  const pulseEl = $('#pulse-value');
  if (!s || s.pulse == null) {
    pulseEl.textContent = '—';
    $('#pulse-age').textContent = 'waiting for a 12s window';
    $('#pulse-conf').style.width = '0%';
    $('#pulse-conf-num').textContent = '—';
  } else {
    pulseEl.textContent = Math.round(s.pulse);
    const ageS = Math.max(0, Math.round((Date.now() - lastSampleAt) / 1000));
    const base = baseline?.pulseMedian;
    pulseEl.classList.toggle('spike', base != null && s.pulse > base + (baseline?.pulseBand ?? 4));
    $('#pulse-age').textContent = ageS < 2 ? 'updated just now · 12s average' : `updated ${ageS}s ago · 12s average`;
    $('#pulse-conf').style.width = `${Math.min(100, s.pulseConf ?? 0)}%`;
    // a label, not a score: the SDK's own stability threshold (confidence >= 40) is
    // the only meaningful boundary here, and "78/100" invites reading it as a grade
    $('#pulse-conf-num').textContent = s.pulseStable ? 'stable (±3 bpm)' : 'collecting…';
    document.querySelector('.pulse-block').classList.toggle('stale', Date.now() - lastSampleAt > 8000);
  }
  // The SDK's model card is explicit: breathing rate "does not work when: talking".
  // So the answer window reports why it is absent instead of printing a number the
  // documentation says cannot be trusted there.
  const brEl = $('#v-br');
  const inAnswer = state?.phase === 'answer';
  brEl.textContent = inAnswer ? '— (invalid while talking)'
    : s?.breathing == null ? '— (needs 30s)' : `${s.breathing}/min`;
  brEl.className = `v ${inAnswer ? 'off' : ''}`;
  $('#v-hrv').textContent = s?.hrvRmssd == null ? '— (needs 60s)' : `${s.hrvRmssd} ms`;
  const talk = $('#v-talk');
  talk.textContent = s?.talking == null ? '—' : s.talking ? 'yes' : 'no';
  talk.className = `v ${s?.talking ? 'on' : 'off'}`;
  $('#v-expr').textContent = s?.expression ?? '—';
  $('#v-baseline').textContent = baseline?.pulseMedian == null ? 'learning…' : `${Math.round(baseline.pulseMedian)} ±${baseline.pulseBand}`;
}

function renderLive(s) {
  const names = { baseline: 'settle in', question: 'question', answer: 'answering', recover: 'coming back down' };
  $('#phase-name').textContent = `${names[s.phase] ?? s.phase}${s.rounds ? ` · ${Math.min(s.roundIndex + 1, s.rounds)}/${s.rounds}` : ''}`;
  const remaining = Math.max(0, Math.round((s.phaseDurationSec ?? 0) - (s.phaseElapsedSec ?? 0)));
  if (s.phase === 'baseline' && remaining <= 0 && s.baselineProgress && s.baselineProgress.readings < s.baselineProgress.need) {
    $('#phase-count').textContent = 'waiting for a clean signal…';
  } else if (s.phase === 'baseline' && s.baselineProgress?.readings >= s.baselineProgress?.need && remaining > 0) {
    $('#phase-count').textContent = `baseline ready · ${remaining}s left`;
  } else {
    $('#phase-count').textContent = s.phaseDurationSec ? `${remaining}s left` : '—';
  }

  $('#question').textContent = s.question ?? 'Settle in. Sit still and breathe normally.';
  const hint = $('#stage-hint');
  if (s.phase === 'baseline') {
    const p = s.baselineProgress;
    hint.textContent = p
      ? `Learning your calm baseline — ${p.readings}/${p.need} clean pulse readings. Sit still, do not talk. A session with too few readings is not scored.`
      : 'This is the calm baseline every later number is measured against. Sit still, do not talk.';
  } else if (s.phase === 'question') {
    hint.textContent = 'Read the question. Press “Answer now” and answer out loud — the app only needs the sound of you talking, not the words.';
  } else if (s.phase === 'answer') {
    hint.textContent = 'Answer out loud, as you would in the room. Tape your own pace.';
  } else if (s.phase === 'recover') {
    hint.textContent = 'Stop talking. Sit still and let the app watch how fast you come back down.';
  }

  $('#btn-answer').classList.toggle('hidden', s.phase !== 'question');
  $('#btn-endanswer').classList.toggle('hidden', s.phase !== 'answer');
  $('#btn-finish').classList.toggle('hidden', s.roundIndex < 0 || s.phase === 'report');
  $('#btn-stop').classList.toggle('hidden', s.phase === 'consent' || s.phase === 'report');
  drawLive();
}

function drawLive() {
  drawTimeline($('#timeline'), {
    samples,
    baseline,
    rounds: state?.latestRound && state.roundIndex >= 0
      ? [{ index: state.roundIndex, answerStart: null, analysis: state.latestRound }]
      : [],
    windowMs: 180000,
    title: state?.synthetic ? 'MOCK SIGNALS' : state?.source === 'file' ? 'RECORDED CLIP' : 'LIVE',
  });
}

async function loadCompareOptions() {
  const sel = $('#compare-select');
  const block = $('#compare-block');
  if (!sel || !block) return;
  try {
    const rows = await (await fetch('/api/sessions')).json();
    const usable = rows.filter((r) => r.rounds);
    sel.innerHTML = '';
    if (!usable.length) { block.classList.add('hidden'); return; }
    block.classList.remove('hidden');
    for (const r of usable) {
      const o = document.createElement('option');
      o.value = r.name;
      o.textContent = `${r.endedAt.slice(0, 16).replace('T', ' ')} — ${(r.headline ?? '').slice(0, 70)}`;
      sel.append(o);
    }
    sel.onchange = () => renderCompare(sel.value);
    renderCompare(usable[0].name);
  } catch {
    block.classList.add('hidden');
  }
}

async function renderCompare(prevName) {
  const tb = document.querySelector('#compare-table tbody');
  const note = $('#compare-note');
  if (!tb) return;
  tb.innerHTML = '';
  try {
    const data = await (await fetch(`/api/compare?prev=${encodeURIComponent(prevName)}`)).json();
    if (!data.rows?.length) {
      note.textContent = 'No question has a scored recovery in both sessions yet, so there is nothing honest to compare.';
      return;
    }
    note.textContent = `Compared with ${prevName}`;
    for (const r of data.rows) {
      const tr = document.createElement('tr');
      const cells = [
        [r.question, ''],
        [r.prevHalfLife == null ? '—' : `${r.prevHalfLife}s`, ''],
        [r.nextHalfLife == null ? '—' : `${r.nextHalfLife}s`, ''],
        [r.halfLifeDelta == null ? '—' : `${r.halfLifeDelta > 0 ? '+' : ''}${r.halfLifeDelta}s`, r.halfLifeDelta == null ? '' : r.halfLifeDelta > 0 ? 'up' : 'down'],
        [r.prevPeak == null ? '—' : String(Math.round(r.prevPeak)), ''],
        [r.nextPeak == null ? '—' : String(Math.round(r.nextPeak)), ''],
      ];
      for (const [text, cls] of cells) {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        tr.append(td);
      }
      tb.append(tr);
    }
  } catch {
    note.textContent = 'Could not read that session.';
  }
}

function onReport(report) {
  show('report');
  renderReport(report, {
    headline: $('#report-headline'),
    meta: $('#report-meta'),
    table: $('#report-table'),
    cards: $('#report-rounds'),
    canvas: $('#report-timeline'),
    legend: $('#report-legend'),
  });
  log('session report ready');
  loadCompareOptions();
}

$('#btn-consent').addEventListener('click', () => send({ type: 'consent' }));
$('#btn-begin').addEventListener('click', () => send({ type: 'begin' }));
$('#btn-answer').addEventListener('click', () => send({ type: 'answer' }));
$('#btn-endanswer').addEventListener('click', () => send({ type: 'endAnswer' }));
$('#btn-finish').addEventListener('click', () => send({ type: 'finish' }));
$('#btn-stop').addEventListener('click', () => send({ type: 'abort' }));
// A reload alone re-renders the finished report; the session has to go back to the consent
// gate on the server, then the page reloads into a clean run.
$('#btn-again').addEventListener('click', () => {
  send({ type: 'restart' });
  setTimeout(() => location.reload(), 1200);
});

function send(msg) {
  if (!ws || ws.readyState !== 1) return log('not connected yet');
  ws.send(JSON.stringify(msg));
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && state?.phase === 'question') send({ type: 'answer' });
});
window.addEventListener('resize', () => { if (state) drawLive(); });

connect();
