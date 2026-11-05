// HalfBeat — the session state machine. Owns time, phases, rounds and the artefact.
// Camera consent is a phase, not a checkbox: nothing captures until consent() flips it.
import { EventEmitter } from 'node:events';
import { buildBaseline, analyseRound, rankRounds, headline, compareSessions } from './recovery.mjs';
import { assess, MIN_BASELINE_READINGS } from './integrity.mjs';

export const PHASES = ['consent', 'check', 'baseline', 'question', 'answer', 'recover', 'report'];

export class Session extends EventEmitter {
  constructor(cfg, source) {
    super();
    this.cfg = cfg;
    this.source = source;
    this.phase = 'consent';
    this.roundIndex = -1;
    this.startedAt = null;
    this.phaseStartedAt = null;
    this.samples = [];          // every sample, tagged with phase + round
    this.rounds = [];           // per-round slice + analysis
    this.current = null;        // latest sample for the UI
    this.validation = { code: 0, hint: 'waiting' };
    this.statusLabel = 'idle';
    this.consented = false;
    this.finished = false;
    this.tick = null;

    source.on('sample', (s) => this.#onSample(s));
    source.on('validation', (v) => { this.validation = v; this.#emitState(); });
    source.on('status', (s) => { this.statusLabel = s.label; this.#emitState(); });
    source.on('error', (e) => {
      // A "not in a valid state" error arrives from the native layer when the file source
      // hits EOF or the SDK is shutting down; after the report exists it means nothing.
      if (this.finished && /valid state/i.test(e.message ?? '')) return;
      this.emit('error', e);
      this.emit('log', `SDK error ${e.code}: ${e.message}${e.retryable ? ' (retryable)' : ''}`);
    });
    source.on('log', (l) => this.emit('log', l));
  }

  /** Explicit camera consent. Refuses to move on without it. */
  consent() {
    if (this.phase !== 'consent') return this.state();
    this.consented = true;
    this.startedAt = new Date().toISOString();
    this.#setPhase('check');
    return this.state();
  }

  /** Called when the operator says the framing looks right. */
  beginCapture() {
    if (this.phase !== 'check') return this.state();
    if (!this.consented) throw new Error('consent required');
    this.#setPhase('baseline');
    this.source.mode = 'baseline';
    return this.state();
  }

  /** Advance from a question card into the answer window. */
  answerNow() {
    if (this.phase !== 'question') return this.state();
    this.#setPhase('answer');
    this.source.mode = 'answer';
    return this.state();
  }

  /** Skip the remaining answer window and go straight to recovery. */
  endAnswer() {
    if (this.phase !== 'answer') return this.state();
    this.#enterRecovery();
    return this.state();
  }

  finish() {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    this.finished = true;
    const session = this.buildSession();
    this.#setPhase('report');
    this.emit('report', session);
    return session;
  }

  async abort() {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    await this.source.stop();
  }

  /** Start the internal clock (called once, after consent). */
  run() {
    if (this.tick) return;
    this.tick = setInterval(() => this.#advance(), 250);
    this.#emitState();
  }

  #onSample(s) {
    if (!this.consented || this.phase === 'consent') return;
    const tagged = { ...s, phase: this.phase, round: this.roundIndex };
    this.samples.push(tagged);
    this.current = tagged;
    if (this.roundIndex >= 0 && this.rounds[this.roundIndex] && ['answer', 'recover'].includes(this.phase)) {
      this.rounds[this.roundIndex].samples.push(s);
    }
    this.emit('sample', tagged);
  }

  #setPhase(phase) {
    this.phase = phase;
    this.phaseStartedAt = performance.now();
    if (phase === 'baseline') {
      this.baselineSamples = [];
    }
    if (phase === 'question') {
      this.roundIndex += 1;
      this.rounds.push({
        index: this.roundIndex,
        question: this.cfg.questions[this.roundIndex],
        answerStart: null,
        answerEnd: null,
        recoverEnd: null,
        samples: [],
        analysis: null,
      });
    }
    if (phase === 'answer') {
      const r = this.rounds[this.roundIndex];
      if (r) r.answerStart = this.relNow();
    }
    if (phase === 'recover') {
      const r = this.rounds[this.roundIndex];
      if (r && r.answerEnd == null) r.answerEnd = this.relNow();
    }
    this.#emitState();
  }

  #enterRecovery() {
    const r = this.rounds[this.roundIndex];
    if (r) r.answerEnd = this.relNow();
    this.#setPhase('recover');
    this.source.mode = 'recover';
  }

  /** ms since capture started — the same clock the samples carry. */
  relNow() {
    return this.source?.nowMs ? Math.round(this.source.nowMs()) : (this.current?.t ?? 0);
  }

  #elapsedSec() {
    return this.phaseStartedAt == null ? 0 : (performance.now() - this.phaseStartedAt) / 1000;
  }

  #advance() {
    const elapsed = this.#elapsedSec();
    if (this.phase === 'baseline') {
      const window = this.samples.filter((s) => s.phase === 'baseline');
      const quality = assess(window, { minReadings: MIN_BASELINE_READINGS });
      this.baselineProgress = { readings: quality.readings, need: MIN_BASELINE_READINGS, status: quality.status };
      // A baseline is only worth having if it is made of enough clean readings. The first
      // real run built one out of two noisy ones and then reported a +36 bpm "recovery".
      const ready = quality.status === 'stable' && elapsed >= this.cfg.baselineSec;
      const hardStop = elapsed >= this.cfg.baselineSec * 2;
      if (ready || hardStop) {
        this.baseline = buildBaseline(window);
        this.emit('baseline', this.baseline);
        this.#setPhase('question');
      } else {
        this.#emitState();
      }
      return;
    }
    if (this.phase === 'answer' && elapsed >= this.cfg.answerSec) {
      this.#enterRecovery();
      return;
    }
    if (this.phase === 'recover' && elapsed >= this.cfg.recoverSec) {
      const r = this.rounds[this.roundIndex];
      if (r) {
        r.recoverEnd = this.relNow();
        r.analysis = analyseRound(r.samples, this.baseline);
      }
      if (this.roundIndex + 1 >= this.cfg.rounds) this.finish();
      else this.#setPhase('question');
      return;
    }
    // keep the UI's countdown honest
    this.#emitState();
  }

  state() {
    return {
      phase: this.phase,
      phaseElapsedSec: Math.round(this.#elapsedSec() * 10) / 10,
      phaseDurationSec: this.#durationFor(this.phase),
      roundIndex: this.roundIndex,
      rounds: this.cfg.rounds,
      question: this.rounds[this.roundIndex]?.question ?? null,
      questions: this.cfg.questions,
      consented: this.consented,
      validation: this.validation,
      status: this.statusLabel,
      synthetic: this.source.isSynthetic,
      baseline: this.baseline ?? null,
      baselineProgress: this.baselineProgress ?? null,
      current: this.current,
      latestRound: this.rounds[this.roundIndex]?.analysis ?? null,
      source: this.cfg.source,
      telemetry: !!this.cfg.telemetry,
    };
  }

  #durationFor(phase) {
    if (phase === 'baseline') return this.cfg.baselineSec;
    if (phase === 'answer') return this.cfg.answerSec;
    if (phase === 'recover') return this.cfg.recoverSec;
    return 0;
  }

  #emitState() {
    this.emit('state', this.state());
  }

  buildSession() {
    return {
      app: 'halfbeat',
      version: 1,
      sdk: '@smartspectra/node-sdk',
      source: this.cfg.source,
      synthetic: this.source.isSynthetic,
      clip: this.cfg.source === 'file' ? this.cfg.file : null,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      config: {
        baselineSec: this.cfg.baselineSec,
        answerSec: this.cfg.answerSec,
        recoverSec: this.cfg.recoverSec,
        rounds: this.cfg.rounds,
        telemetry: !!this.cfg.telemetry,
      },
      baseline: this.baseline ?? null,
      rounds: this.rounds.map((r) => ({
        index: r.index,
        question: r.question,
        answerStart: r.answerStart,
        answerEnd: r.answerEnd,
        recoverEnd: r.recoverEnd,
        analysis: r.analysis,
      })),
      ranking: rankRounds(this.rounds).map((r) => ({
        question: r.question,
        timeToBandSec: r.analysis.timeToBandSec,
        halfLifeSec: r.analysis.halfLifeSec,
        peak: r.analysis.peak,
        delta: r.analysis.delta,
      })),
      // the headline needs the baseline too: "no baseline" and "no rise" are different
      // outcomes and the first one must never be reported as a physiological finding
      headline: headline({ rounds: this.rounds, baseline: this.baseline ?? null }),
      sampleCount: this.samples.length,
      samples: downsample(this.samples),
    };
  }
}

/** Keep roughly 1 Hz plus every row where the pulse measurement changed — the SDK emits
 *  metrics per frame (measured: 22 Hz), which would bloat an artefact to megabytes while
 *  adding no information the report can use. */
export function downsample(samples, intervalMs = 1000) {
  const out = [];
  let lastKeptT = -Infinity;
  let lastPulseTs = null;
  for (const s of samples) {
    const pulseChanged = s.pulseTs != null && s.pulseTs !== lastPulseTs;
    if (pulseChanged || s.t - lastKeptT >= intervalMs) {
      out.push(s);
      lastKeptT = s.t;
      if (pulseChanged) lastPulseTs = s.pulseTs;
    }
  }
  return out;
}

export { compareSessions };
