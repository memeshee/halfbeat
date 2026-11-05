// HalfBeat — turn a decoded SmartSpectra Metrics protobuf into one flat sample.
import { decodeMetrics } from '@smartspectra/node-sdk/messages';

const EXPRESSION_NAMES = {
  0: 'unspecified', 1: 'angry', 2: 'contempt', 3: 'disgust', 4: 'fear',
  5: 'happy', 6: 'neutral', 7: 'sad', 8: 'surprise',
};

const last = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null);

/**
 * @param {Buffer|Uint8Array} buf protobuf payload from the SDK's `metrics` event
 * @param {number} tMs ms since session start (our clock, not the SDK's µs stamps)
 */
export function sampleFromBuffer(buf, tMs) {
  const m = decodeMetrics(buf);
  const cardio = m.cardio || null;
  const face = m.face || null;
  const breathing = m.breathing || null;

  const pulse = last(cardio?.pulseRate);
  const hrv = last(cardio?.hrv);
  const talk = last(face?.talking);
  const blink = last(face?.blinking);
  const expr = last(face?.expression);
  const br = last(breathing?.rate);

  const scores = expr?.scores || [];
  let dominant = 'unknown';
  let dominantConf = 0;
  let neutral = 0;
  for (const s of scores) {
    const name = EXPRESSION_NAMES[s.type] ?? `type${s.type}`;
    if (name === 'neutral') neutral = s.confidence;
    if (s.confidence > dominantConf) { dominantConf = s.confidence; dominant = name; }
  }

  return {
    t: Math.round(tMs),
    pulse: pulse ? round(pulse.value, 1) : null,
    pulseConf: pulse ? round(pulse.confidence, 0) : null,
    pulseStable: pulse ? !!pulse.stable : null,
    pulseTs: typeof pulse?.timestamp === 'number' ? pulse.timestamp : (pulse?.timestamp ? Number(pulse.timestamp) : null),
    hrvRmssd: hrv ? round(hrv.rmssd, 1) : null,
    hrvConf: hrv ? round(hrv.confidence, 0) : null,
    breathing: br ? round(br.value, 1) : null,
    breathingConf: br ? round(br.confidence, 0) : null,
    talking: talk ? !!talk.detected : null,
    blinking: blink ? !!blink.detected : null,
    expression: dominant,
    expressionConf: round(dominantConf, 2),
    neutral: round(neutral, 2),
  };
}

function round(v, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

export const EMPTY_SAMPLE = {
  t: 0, pulse: null, pulseConf: null, pulseStable: null,
  hrvRmssd: null, hrvConf: null, breathing: null, breathingConf: null,
  talking: null, blinking: null, expression: 'unknown', expressionConf: 0, neutral: 0,
};
