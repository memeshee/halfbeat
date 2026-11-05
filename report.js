// HalfBeat — one timeline renderer, used by the live session, the report and the
// static replay page. Keeping it in one file is why replay can run on GitHub Pages
// with no server and no SDK.

const COL = {
  pulse: '#38e1b0',
  band: 'rgba(56, 225, 176, 0.10)',
  bandEdge: 'rgba(56, 225, 176, 0.18)',
  spike: '#ff7a5c',
  talk: 'rgba(245, 196, 81, 0.55)',
  grid: '#141c24',
  label: '#55636f',
  axis: '#2b3946',
  ink: '#e8eef5',
};

const PAD = { l: 42, r: 12, t: 14, b: 20 };
const MIN_CONF = 40;

function pulseSeries(samples) {
  const seen = new Set();
  const out = [];
  for (const s of samples) {
    if (typeof s.pulse !== 'number' || s.pulse <= 0) continue;
    if ((s.pulseConf ?? 0) < MIN_CONF) continue;
    const key = s.pulseTs ?? `${s.t}:${s.pulse}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ t: s.t, v: s.pulse });
  }
  return out;
}

/** Draw the pulse lane with the baseline band, talking lane and round boundaries. */
export function drawTimeline(canvas, { samples = [], baseline = null, rounds = [], windowMs = 0, title = '' }) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 880;
  const cssH = canvas.clientHeight || 240;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const w = cssW - PAD.l - PAD.r;
  const h = cssH - PAD.t - PAD.b;
  const series = pulseSeries(samples);

  const tMax = samples.length ? samples[samples.length - 1].t : 1000;
  const tMin = windowMs && tMax > windowMs ? tMax - windowMs : 0;
  const span = Math.max(1000, tMax - tMin);
  const x = (t) => PAD.l + ((t - tMin) / span) * w;

  // pulse y-scale: baseline band + observed range, with a floor so a flat signal is not amplified
  const vals = series.map((p) => p.v);
  const base = baseline?.pulseMedian ?? (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 70);
  const lo = Math.min(...(vals.length ? vals : [base - 10]), base - 8) - 4;
  const hi = Math.max(...(vals.length ? vals : [base + 10]), base + 8) + 4;
  const y = (v) => PAD.t + h - ((v - lo) / Math.max(1e-6, hi - lo)) * h;

  // baseline band
  if (baseline?.pulseMedian != null) {
    const bandTop = y(base + (baseline.pulseBand ?? 4));
    const bandBot = y(base - (baseline.pulseBand ?? 4));
    ctx.fillStyle = COL.band;
    ctx.fillRect(PAD.l, bandTop, w, bandBot - bandTop);
    ctx.strokeStyle = COL.bandEdge;
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.l, y(base)); ctx.lineTo(PAD.l + w, y(base));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COL.label;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`baseline ${Math.round(base)}`, PAD.l + 4, y(base) - 4);
  }

  // y axis ticks
  ctx.fillStyle = COL.label;
  ctx.font = '10px ui-monospace, monospace';
  const yStep = hi - lo > 60 ? 20 : 10;
  for (let v = Math.ceil(lo / yStep) * yStep; v <= hi; v += yStep) {
    ctx.fillText(String(v), 8, y(v) + 3);
    ctx.strokeStyle = COL.grid;
    ctx.beginPath(); ctx.moveTo(PAD.l, y(v)); ctx.lineTo(PAD.l + w, y(v)); ctx.stroke();
  }

  // talking lane (bottom strip)
  const talkTop = PAD.t + h - 6;
  for (const s of samples) {
    if (s.t < tMin || s.talking !== true) continue;
    ctx.fillStyle = COL.talk;
    ctx.fillRect(x(s.t), talkTop, Math.max(1.2, w / span * 700), 4);
  }
  ctx.fillStyle = COL.label;
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText('talking', PAD.l + 4, talkTop + 14);

  // round boundaries
  for (const r of rounds) {
    if (r.answerStart != null && r.answerStart >= tMin) {
      const xx = x(r.answerStart);
      ctx.strokeStyle = COL.axis;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(xx, PAD.t); ctx.lineTo(xx, PAD.t + h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COL.label;
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(`Q${r.index + 1}`, xx + 3, PAD.t + 10);
    }
    if (r.recoverEnd != null && r.recoverEnd >= tMin) {
      const xx = x(r.recoverEnd);
      ctx.strokeStyle = '#1b2530';
      ctx.beginPath(); ctx.moveTo(xx, PAD.t); ctx.lineTo(xx, PAD.t + h); ctx.stroke();
    }
  }

  // pulse line
  if (series.length) {
    ctx.strokeStyle = COL.pulse;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    series.forEach((p, i) => {
      const xx = x(p.t), yy = y(p.v);
      if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    });
    ctx.stroke();
    // points
    ctx.fillStyle = COL.pulse;
    for (const p of series) {
      ctx.beginPath(); ctx.arc(x(p.t), y(p.v), 1.8, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    ctx.fillStyle = COL.label;
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText('waiting for the first 12-second pulse window…', PAD.l + 8, PAD.t + h / 2);
  }

  // peaks + recovery markers
  for (const r of rounds) {
    const a = r.analysis;
    if (!a?.sufficient || a.peakAt == null || a.peakAt < tMin) continue;
    const px = x(a.peakAt), py = y(a.peak);
    ctx.fillStyle = COL.spike;
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
    if (a.timeToBandSec != null) {
      const bx = x(a.peakAt + a.timeToBandSec * 1000);
      ctx.strokeStyle = COL.spike;
      ctx.globalAlpha = 0.65;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(bx, y(a.peak)); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = COL.spike;
      ctx.beginPath(); ctx.arc(bx, y(a.peak), 2.4, 0, Math.PI * 2); ctx.fill();
    }
  }

  // x axis
  ctx.strokeStyle = COL.axis;
  ctx.beginPath(); ctx.moveTo(PAD.l, PAD.t + h); ctx.lineTo(PAD.l + w, PAD.t + h); ctx.stroke();
  ctx.fillStyle = COL.label;
  ctx.font = '10px ui-monospace, monospace';
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const tt = tMin + (span * i) / steps;
    const label = `${Math.round(tt / 1000)}s`;
    const lw = ctx.measureText(label).width;
    const lx = i === 0 ? PAD.l : i === steps ? PAD.l + w - lw : x(tt) - lw / 2;
    ctx.fillText(label, lx, PAD.t + h + 14);
  }
  if (title) {
    ctx.fillStyle = COL.label;
    ctx.fillText(title, PAD.l + w - ctx.measureText(title).width, PAD.t + 10);
  }
}

const pct = (v) => (v == null ? '—' : `${v}`);
const num = (v, suffix = '') => (v == null ? '—' : `${v}${suffix}`);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Fill the report screen (or the replay page) from a session object. */
export function renderReport(session, refs) {
  const { headline, meta, table, cards, canvas, legend } = refs;
  if (headline) headline.textContent = session.headline ?? '—';

  if (meta) {
    meta.innerHTML = '';
    const bits = [
      ['source', session.synthetic ? 'synthetic mock (not a real measurement)' : session.source === 'file' ? `recorded clip` : 'live camera'],
      ['questions', String(session.rounds?.length ?? 0)],
      ['pulse resolution', `${session.baseline?.resolutionSec ?? 12}s window`],
      ['baseline', session.baseline?.pulseMedian != null ? `${session.baseline.pulseMedian} bpm ±${session.baseline.pulseBand}` : 'not established'],
      ['sdk telemetry', session.config?.telemetry ? 'ON' : 'off'],
      ['dates', `${(session.startedAt ?? '').slice(0, 16).replace('T', ' ')} → ${(session.endedAt ?? '').slice(11, 16)}`],
    ];
    for (const [k, v] of bits) {
      const s = el('span', null);
      s.append(el('span', null, `${k}: `), el('strong', null, v));
      meta.append(s);
    }
  }

  if (table) {
    const tb = table.querySelector('tbody');
    tb.innerHTML = '';
    const rounds = session.rounds ?? [];
    if (!rounds.length) {
      const tr = el('tr');
      const td = el('td', 'dash', 'No rounds were completed in this session.');
      td.colSpan = 6;
      tr.append(td); tb.append(tr);
    }
    for (const r of rounds) {
      const a = r.analysis ?? {};
      const scored = !!a.sufficient;
      const tr = el('tr');
      tr.append(el('td', null, r.question));

      // signal verdict first: a refusal is the most important thing on the row
      const q = a.quality?.status ?? (session.baseline?.established === false ? 'insufficient' : 'unknown');
      const qCell = el('td', q === 'stable' ? 'fast' : 'dash', q);
      qCell.title = (a.quality?.reasons ?? a.reason ? [a.reason, ...(a.quality?.reasons ?? [])].filter(Boolean).join('; ') : '');
      tr.append(qCell);

      tr.append(el('td', null, scored ? String(Math.round(a.peak)) : '—'));
      tr.append(el('td', null, scored ? `+${Math.round(a.delta)}` : '—'));
      let backText, backCls;
      if (!scored) { backText = 'not scored'; backCls = 'dash'; }
      else if (!a.rose) { backText = 'no rise'; backCls = 'dash'; }
      else if (a.timeToBandSec == null) { backText = 'never'; backCls = 'slow'; }
      else { backText = `${a.timeToBandSec}s`; backCls = a.timeToBandSec > 30 ? 'slow' : 'fast'; }
      tr.append(el('td', backCls, backText));
      tr.append(el('td', null, scored && a.halfLifeSec != null ? `${a.halfLifeSec}s` : '—'));
      tb.append(tr);

      if (!scored && (a.reason || a.quality?.reasons?.length)) {
        const why = el('tr');
        const td = el('td', 'fineprint', `— ${a.reason ?? a.quality.reasons.join('; ')}`);
        td.colSpan = 6;
        why.append(td); tb.append(why);
      }
    }
  }

  if (cards) {
    cards.innerHTML = '';
    for (const r of session.rounds ?? []) {
      const c = el('div', 'round-card');
      c.append(el('div', 'q', `Q${r.index + 1} · ${r.question}`));
      const a = r.analysis ?? {};
      for (const [k, v] of [
        ['signal', a.quality?.status ?? 'unknown'],
        ['readings kept', num(a.readings ?? a.quality?.readings)],
        ['peak', a.sufficient ? (a.peak == null ? '—' : String(Math.round(a.peak))) : '—'],
        ['above baseline', !a.sufficient || a.delta == null ? '—' : `+${Math.round(a.delta)} bpm`],
        ['back down', !a.sufficient ? 'not scored' : a.timeToBandSec == null ? (a.rose ? 'never (in window)' : 'no rise') : `${a.timeToBandSec}s`],
        ['half-life', a.sufficient && a.halfLifeSec != null ? `${a.halfLifeSec}s` : '—'],
      ]) {
        const s = el('div', 'stat');
        s.append(el('span', null, k), el('b', null, String(v)));
        c.append(s);
      }
      if (a.caveat) c.append(el('p', 'fineprint tiny', a.caveat));
      cards.append(c);
    }
  }

  if (canvas) {
    drawTimeline(canvas, {
      samples: session.samples ?? [],
      baseline: session.baseline,
      rounds: session.rounds ?? [],
    });
  }
  if (legend) {
    legend.textContent = session.synthetic
      ? 'Synthetic mock signals — this session demonstrates the analysis, not a measurement of a person.'
      : 'Green line: pulse (12-second average). Shaded band: your own settle-in baseline. Orange dots: the peak of each answer window, with the run down to “back inside baseline”. Yellow ticks: talking detected.';
  }
}
