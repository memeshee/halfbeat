// HalfBeat — recovery analysis. Pure functions over the sample stream so the same code
// runs in the live session, the report, the replay page and the eval harness.
//
// Two honest constraints this file is built around:
//   1. SmartSpectra's pulse rate is a 12-second average, so every number below has a
//      resolution of roughly one pulse window. The resolution is reported beside the
//      number instead of implying second-level precision.
//   2. Camera pulse is easy to corrupt. src/integrity.mjs gates the readings; this file
//      refuses to score a window that does not survive those gates, because a recovery
//      number computed on noise is worse than no number at all.

import { assess, explain, plausibleStep, MIN_BASELINE_READINGS, MIN_PULSE_CONF } from './integrity.mjs';

export const PULSE_WINDOW_S = 12;   // documented averaging window for pulse rate
export { MIN_PULSE_CONF };

/** Retained for callers that only want the gated readings. */
export { acceptedReadings as usablePulse } from './integrity.mjs';

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const mad = (xs, centre) => {
  if (!xs.length || centre == null) return null;
  return median(xs.map((x) => Math.abs(x - centre)));
};

/**
 * Personal calm baseline from the settle-in phase. Intra-person only: every number in
 * the report is compared to this band, never to a population norm.
 */
export function buildBaseline(samples) {
  const quality = assess(samples, { minReadings: MIN_BASELINE_READINGS });
  const values = samples
    .filter((s) => typeof s.pulse === 'number' && s.pulse > 0 && (s.pulseConf ?? 0) >= MIN_PULSE_CONF)
    .map((s) => s.pulse);
  const centre = values.length ? median(values) : null;
  const spread = mad(values, centre) ?? 0;
  const band = Math.max(4, Math.round((1.5 * spread + 1) * 10) / 10); // ±band = "back at baseline"
  return {
    established: quality.status === 'stable',
    status: quality.status,
    reasons: quality.reasons,
    pulseMedian: centre == null || quality.status !== 'stable' ? null : Math.round(centre * 10) / 10,
    pulseBand: band,
    readings: quality.readings,
    maxJump: quality.maxJump,
    windowSec: samples.length ? Math.round((samples[samples.length - 1].t - samples[0].t) / 1000) : 0,
    resolutionSec: PULSE_WINDOW_S,
  };
}

/** The gated pulse series inside a window, in order, one row per SDK measurement. */
function gatedSeries(samples) {
  const out = [];
  let prevKey = null;
  for (const s of samples) {
    if (typeof s.pulse !== 'number' || s.pulse <= 0) continue;
    if ((s.pulseConf ?? 0) < MIN_PULSE_CONF) continue;
    const key = s.pulseTs ?? `${s.t}:${s.pulse}`;
    if (key === prevKey) continue;
    prevKey = key;
    const prev = out[out.length - 1];
    if (!plausibleStep(prev, s)) continue;   // physiologically impossible step
    out.push(s);
  }
  return out;
}

/**
 * One round: the answer window plus the recovery window after it.
 * Returns either a scored result or a refusal carrying the reason.
 */
export function analyseRound(roundSamples, baseline) {
  const quality = assess(roundSamples);
  const base = baseline?.pulseMedian;
  const band = baseline?.pulseBand ?? 4;

  if (!baseline?.established || base == null) {
    return { sufficient: false, quality, reason: 'no baseline was established, so there is nothing to compare against' };
  }
  if (quality.status !== 'stable') {
    return { sufficient: false, quality, reason: explain(quality) ?? 'signal quality insufficient' };
  }

  const usable = gatedSeries(roundSamples);
  let peak = -Infinity;
  let peakAt = null;
  for (const s of usable) if (s.pulse > peak) { peak = s.pulse; peakAt = s.t; }
  const delta = Math.round((peak - base) * 10) / 10;

  // Time to come back inside the baseline band, measured from the peak.
  let backAt = null;
  const after = usable.filter((s) => s.t >= peakAt);
  for (let i = 0; i < after.length; i++) {
    if (after[i].pulse <= base + band) {
      const rest = after.slice(i);
      if (rest.every((s) => s.pulse <= base + band)) { backAt = after[i].t; break; }
    }
  }
  // Sub-reading precision is an illusion: if the peak is followed immediately by an in-band
  // reading, the decay happened faster than one pulse window can resolve, and "0 s" would
  // read as an instant recovery. Say it cannot be timed instead.
  const readingGap = usable.length > 1
    ? Math.min(...usable.slice(1).map((s, i) => Math.abs(s.t - usable[i].t)))
    : 2000;
  const tooFastToTime = backAt != null && (backAt - peakAt) < Math.max(1000, readingGap);
  const timeToBandSec = backAt == null || tooFastToTime ? null : Math.round((backAt - peakAt) / 1000);

  // Exponential fit on the decay: ln(excess) vs time, after the peak.
  const decay = after.map((s) => ({ dt: (s.t - peakAt) / 1000, ex: s.pulse - base })).filter((p) => p.ex > 0.5);
  let halfLifeSec = null;
  if (decay.length >= 3) {
    const n = decay.length;
    const mx = decay.reduce((a, p) => a + p.dt, 0) / n;
    const my = decay.reduce((a, p) => a + Math.log(p.ex), 0) / n;
    let num = 0, den = 0;
    for (const p of decay) { num += (p.dt - mx) * (Math.log(p.ex) - my); den += (p.dt - mx) ** 2; }
    const slope = den ? num / den : 0;   // per second, negative while recovering
    if (slope < -1e-4) halfLifeSec = Math.round((Math.log(2) / -slope) * 10) / 10;
  }

  // A window where nothing rose above the baseline band has no recovery to measure.
  // Printing "never came back down" there would be a false alarm dressed as a finding.
  const rose = delta > band;
  const talkSamples = roundSamples.filter((s) => s.talking === true).length;
  return {
    sufficient: true,
    quality,
    baseline: base,
    band,
    peak: Math.round(peak * 10) / 10,
    peakAt,
    delta,
    rose,
    timeToBandSec,
    halfLifeSec,
    readings: usable.length,
    resolutionSec: PULSE_WINDOW_S,
    talkingShare: roundSamples.length ? Math.round((talkSamples / roundSamples.length) * 100) / 100 : null,
    caveat: !rose
      ? 'no rise above the baseline band in this window — nothing to recover from'
      : tooFastToTime ? 'came back inside the band inside one reading — faster than the 12-second pulse window can time'
      : timeToBandSec == null ? 'still above baseline at the end of the window' : null,
  };
}

/** Rank the questions by how slowly the body came back down. */
export function rankRounds(rounds) {
  return [...rounds]
    .filter((r) => r.analysis?.sufficient && r.analysis?.rose)
    .sort((a, b) => {
      const av = a.analysis.timeToBandSec ?? 1e6;
      const bv = b.analysis.timeToBandSec ?? 1e6;
      return bv - av; // slowest recovery first
    });
}

/** Compare two sessions of the same question set. */
export function compareSessions(prev, next) {
  if (!prev || !next) return null;
  const byQuestion = (s) => new Map(s.rounds.map((r) => [r.question, r.analysis]));
  const a = byQuestion(prev);
  const b = byQuestion(next);
  const rows = [];
  for (const [q, cur] of b) {
    const old = a.get(q);
    if (!old?.sufficient || !cur?.sufficient) continue;
    rows.push({
      question: q,
      prevHalfLife: old.halfLifeSec,
      nextHalfLife: cur.halfLifeSec,
      halfLifeDelta: cur.halfLifeSec != null && old.halfLifeSec != null ? Math.round((cur.halfLifeSec - old.halfLifeSec) * 10) / 10 : null,
      prevPeak: old.peak,
      nextPeak: cur.peak,
      peakDelta: Math.round((cur.peak - old.peak) * 10) / 10,
    });
  }
  return rows.length ? rows : null;
}

/** The one-line headline the report leads with — honest about what could not be measured. */
export function headline(session) {
  const rounds = session.rounds ?? [];
  const scored = rounds.filter((r) => r.analysis?.sufficient);
  const rose = scored.filter((r) => r.analysis.rose);

  if (!session.baseline?.established) {
    const why = session.baseline?.reasons?.[0] ?? 'not enough clean pulse readings';
    return `No baseline this session — ${why}. Nothing is scored rather than scored on noise.`;
  }
  if (!scored.length) {
    const why = rounds.find((r) => r.analysis?.reason)?.analysis.reason ?? 'the pulse series never stabilised';
    return `No round could be scored — ${why}.`;
  }
  if (!rose.length) {
    return 'Baseline held through every question — nothing rose, so there was no recovery to measure this time.';
  }
  const worst = rankRounds(rounds)[0];
  const hl = worst.analysis.halfLifeSec;
  if (worst.analysis.timeToBandSec == null) {
    return `Slowest recovery: "${worst.question}" — never back inside baseline in the window, still ${worst.analysis.delta} bpm up${hl == null ? '' : ` (decay half-life ${hl}s)`}.`;
  }
  const hlText = hl == null ? '' : ` half-life ${hl}s,`;
  return `Slowest recovery: "${worst.question}" — ${worst.analysis.timeToBandSec}s to come back down,${hlText} peak +${worst.analysis.delta} bpm.`;
}
