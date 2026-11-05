// HalfBeat — recovery analysis. Pure functions over the sample stream so the same
// code runs in the live session, the report, the replay page and the eval harness.
//
// The honest constraint this file is built around: SmartSpectra's pulse rate is a
// 12-second average (and HRV needs a full 60-second window), so every number below
// has a resolution of roughly one pulse sample. We report the resolution beside the
// number instead of implying second-level precision.

export const PULSE_WINDOW_S = 12;   // documented averaging window for pulse rate
export const MIN_PULSE_CONF = 40;   // SDK: confidence >= 40 to call pulse "stable" (+/-3 bpm)

/** Samples that actually carry a usable pulse reading.
 *  The SDK re-emits its rolling pulse measurement array on every metrics tick, so
 *  consecutive samples usually repeat the same measurement. Dedupe on the SDK's own
 *  measurement timestamp before any statistics, or 1 Hz repeats dominate the fit. */
export function usablePulse(samples) {
  const seen = new Set();
  const out = [];
  for (const s of samples) {
    if (typeof s.pulse !== 'number' || s.pulse <= 0) continue;
    if ((s.pulseConf ?? 0) < MIN_PULSE_CONF) continue;
    const key = s.pulseTs ?? `${s.t}:${s.pulse}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

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
 * Personal calm baseline from the settle-in phase. Intra-person only: every
 * number in the report is compared to this band, never to a population norm.
 */
export function buildBaseline(samples) {
  const usable = usablePulse(samples);
  const values = usable.map((s) => s.pulse);
  const centre = median(values);
  const spread = mad(values, centre) ?? 0;
  const band = Math.max(4, Math.round((1.5 * spread + 1) * 10) / 10); // ±band = "back at baseline"
  return {
    pulseMedian: centre == null ? null : Math.round(centre * 10) / 10,
    pulseBand: band,
    readings: usable.length,
    windowSec: samples.length ? Math.round((samples[samples.length - 1].t - samples[0].t) / 1000) : 0,
    resolutionSec: PULSE_WINDOW_S,
  };
}

/**
 * One round: the answer window plus the recovery window after it.
 * @returns peak, delta vs baseline, time to re-enter the band, half-life of decay
 */
export function analyseRound(roundSamples, baseline) {
  const usable = usablePulse(roundSamples);
  const base = baseline?.pulseMedian;
  const band = baseline?.pulseBand ?? 4;
  if (!usable.length || base == null) {
    return { sufficient: false, reason: 'no usable pulse readings in this round', readings: usable.length };
  }
  let peak = -Infinity;
  let peakAt = null;
  for (const s of usable) {
    if (s.pulse > peak) { peak = s.pulse; peakAt = s.t; }
  }
  const delta = Math.round((peak - base) * 10) / 10;

  // Time to come back inside the baseline band, measured from the peak.
  let backAt = null;
  const after = usable.filter((s) => s.t >= peakAt);
  for (let i = 0; i < after.length; i++) {
    if (after[i].pulse <= base + band) {
      // require it to stay in band for the rest of the window
      const rest = after.slice(i);
      if (rest.every((s) => s.pulse <= base + band)) { backAt = after[i].t; break; }
    }
  }
  const timeToBandSec = backAt == null ? null : Math.round((backAt - peakAt) / 1000);

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

  const talkSamples = roundSamples.filter((s) => s.talking === true).length;
  return {
    sufficient: true,
    baseline: base,
    band,
    peak: Math.round(peak * 10) / 10,
    peakAt,
    delta,
    timeToBandSec,
    halfLifeSec,
    readings: usable.length,
    resolutionSec: PULSE_WINDOW_S,
    talkingShare: roundSamples.length ? Math.round((talkSamples / roundSamples.length) * 100) / 100 : null,
    caveat: timeToBandSec == null ? 'still above baseline at the end of the window' : null,
  };
}

/** Rank the questions by how slowly the body came back down. */
export function rankRounds(rounds) {
  return [...rounds]
    .filter((r) => r.analysis?.sufficient)
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

/** The one-line headline the report leads with. */
export function headline(session) {
  const ranked = rankRounds(session.rounds);
  if (!ranked.length) return 'Not enough clean pulse data to score this session.';
  const worst = ranked[0];
  const hl = worst.analysis.halfLifeSec;
  if (worst.analysis.timeToBandSec == null) {
    return `You never came back down on "${worst.question}" — still ${worst.analysis.delta} bpm above your baseline when the window closed.`;
  }
  const hlText = hl == null ? '' : ` half-life ${hl}s,`;
  return `Slowest recovery: "${worst.question}" — ${worst.analysis.timeToBandSec}s to come back down,${hlText} peak +${worst.analysis.delta} bpm.`;
}
