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

function connect() {
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
    $('#pulse-conf-num').textContent = s.pulseConf == null ? '—' : String(s.pulseConf);
  }
  $('#v-br').textContent = s?.breathing == null ? '—' : `${s.breathing}/min`;
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
  $('#phase-count').textContent = s.phaseDurationSec ? `${remaining}s left` : '—';

  $('#question').textContent = s.question ?? 'Settle in. Sit still and breathe normally.';
  const hint = $('#stage-hint');
  if (s.phase === 'baseline') {
    hint.textContent = 'This is the calm baseline every later number is measured against. Sit still, do not talk.';
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
}

$('#btn-consent').addEventListener('click', () => send({ type: 'consent' }));
$('#btn-begin').addEventListener('click', () => send({ type: 'begin' }));
$('#btn-answer').addEventListener('click', () => send({ type: 'answer' }));
$('#btn-endanswer').addEventListener('click', () => send({ type: 'endAnswer' }));
$('#btn-finish').addEventListener('click', () => send({ type: 'finish' }));

function send(msg) {
  if (!ws || ws.readyState !== 1) return log('not connected yet');
  ws.send(JSON.stringify(msg));
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && state?.phase === 'question') send({ type: 'answer' });
});
window.addEventListener('resize', () => { if (state) drawLive(); });

connect();
