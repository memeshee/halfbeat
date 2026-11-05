// HalfBeat — signal integrity. This module exists because the first real run lied.
//
// Recorded footage of a gesturing, talking subject produced a plausible-looking series
// that leapt from 55 bpm to 91 bpm in three seconds and kept climbing. The analysis
// layer happily reported "peak +36 bpm, never came back down" — a confident
// physiological claim assembled entirely out of camera noise. A pulse cannot move that
// fast, so anything that does is an artefact, and an artefact must never reach the
// report as a finding.
//
// Everything here is deliberately conservative: it would rather refuse to score a
// session than score it on noise.

export const MIN_PULSE_CONF = 40;          // SDK: confidence >= 40 => "stable", +/-3 bpm
export const MAX_PLAUSIBLE_JUMP = 8;       // bpm floor for a short gap between readings
export const MAX_BPM_PER_SEC = 3.5;        // measured artefacts ran ~12 bpm/s; physiology stays under 4

/**
 * Is the step between two readings physiologically possible? The answer depends on how far
 * apart they are: 10 bpm over 12 seconds is ordinary, 36 bpm over 3 seconds is a camera
 * artefact. A flat step limit failed the constructed fixture (a real 10 bpm decay step was
 * rejected) while still letting slow drifts through, so the limit is a rate with a floor.
 */
export function plausibleStep(prev, next) {
  if (!prev || !next) return true;
  const dtSec = Math.max(0.05, Math.abs((next.t ?? 0) - (prev.t ?? 0)) / 1000);
  const allowance = Math.max(MAX_PLAUSIBLE_JUMP, MAX_BPM_PER_SEC * dtSec);
  return Math.abs(next.pulse - prev.pulse) <= allowance;
}
export const MIN_BASELINE_READINGS = 5;    // below this there is no baseline, only noise
export const MIN_ROUND_READINGS = 4;       // below this a round cannot be scored

/**
 * Readings that survive every gate: a value, the SDK's own confidence floor, one row per
 * SDK measurement (the rolling array is re-emitted on every tick, so most rows repeat),
 * and a physiological step limit.
 */
export function acceptedReadings(samples) {
  const seen = new Set();
  const out = [];
  const rejected = { lowConfidence: 0, duplicate: 0, implausible: 0 };
  for (const s of samples) {
    if (typeof s.pulse !== 'number' || s.pulse <= 0) continue;
    if ((s.pulseConf ?? 0) < MIN_PULSE_CONF) { rejected.lowConfidence++; continue; }
    const key = s.pulseTs ?? `${s.t}:${s.pulse}`;
    if (seen.has(key)) { rejected.duplicate++; continue; }
    seen.add(key);
    const prev = out[out.length - 1];
    if (!plausibleStep(prev, s)) { rejected.implausible++; continue; }
    out.push(s);
  }
  return { readings: out, rejected };
}

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * Verdict on a window of samples.
 *   stable       — enough readings, no implausible steps, tight spread; safe to score
 *   unstable     — readings exist but the series jumps around; report the refusal, not a number
 *   insufficient — not enough readings at all
 */
export function assess(samples, { minReadings = MIN_ROUND_READINGS } = {}) {
  const { readings, rejected } = acceptedReadings(samples);
  const values = readings.map((r) => r.pulse);
  const deltas = values.slice(1).map((v, i) => Math.abs(v - values[i]));
  const spread = values.length ? Math.round((Math.max(...values) - Math.min(...values)) * 10) / 10 : null;
  const reasons = [];
  let status = 'stable';
  if (values.length < minReadings) {
    status = 'insufficient';
    reasons.push(`only ${values.length} usable pulse reading${values.length === 1 ? '' : 's'} (need ${minReadings})`);
  } else if (spread != null && spread > 25) {
    status = 'unstable';
    reasons.push(`readings spanned ${spread} bpm inside one window`);
  }
  if (rejected.implausible) reasons.push(`${rejected.implausible} reading(s) dropped as physiologically impossible`);
  if (rejected.lowConfidence) reasons.push(`${rejected.lowConfidence} reading(s) below the SDK confidence floor`);
  return {
    status,
    readings: values.length,
    spread,
    maxJump: deltas.length ? Math.round(Math.max(...deltas) * 10) / 10 : null,
    medianJump: deltas.length ? Math.round(median(deltas) * 10) / 10 : null,
    rejected,
    reasons,
  };
}

/** A one-line human explanation for the report, when a window cannot be scored. */
export function explain(assessment) {
  if (assessment.status === 'stable') return null;
  if (assessment.status === 'insufficient') {
    return `not scored — ${assessment.reasons[0] ?? 'not enough clean pulse readings'}`;
  }
  return `not scored — the pulse series was unstable (${assessment.reasons[0] ?? 'readings jumped'}); reporting a recovery number here would be inventing one`;
}
