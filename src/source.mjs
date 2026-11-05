// HalfBeat — input sources. One interface, three backings: live camera, a video
// file, or a synthetic mock. Only the camera and file paths touch the SmartSpectra
// SDK; the mock exists so the UI and the analysis can be developed and tested with
// no camera and no API key, and it is always labelled as synthetic in the UI.
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { SmartSpectraSDK, CameraSelection, cardioMetrics, breathingMetrics, faceMetrics, edaMetrics, ProcessingStatus } from '@smartspectra/node-sdk';
import { sampleFromBuffer } from './signals.mjs';

export const VALIDATION_HINTS = {
  0: 'ok',
  1: 'no face found — sit in front of the camera',
  2: 'more than one face in frame',
  3: 'face is off-centre',
  4: 'face is the wrong size in frame',
  5: 'too dark — add light on your face',
  6: 'too bright — reduce glare',
  7: 'chest not visible — lean back so your upper body is in frame',
  10: 'camera is still tuning',
  11: 'frame rate too low',
  12: 'too much motion — hold still',
  13: 'face too close',
  14: 'face too far',
  15: 'face too high in frame',
  16: 'face too low in frame',
  17: 'face not forward',
};

export class Source extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.sdk = null;
    this.t0 = 0;
    this.mode = 'baseline'; // set by the session: baseline | answer | recover
    this.mockTimer = null;
    this.mockState = { pulse: 66, br: 14, expr: 'neutral' };
  }

  get isSynthetic() {
    return this.cfg.source === 'mock';
  }

  start(apiKey) {
    this.t0 = performance.now();
    if (this.cfg.source === 'mock') return this.#startMock();
    return this.#startSdk(apiKey);
  }

  #now() {
    return performance.now() - this.t0;
  }

  /** ms since capture began — public so the session can stamp phase boundaries on the same clock. */
  nowMs() {
    return this.#now();
  }

  #startSdk(apiKey) {
    if (!apiKey) throw new Error('No SmartSpectra API key. Put it in ~/.presage_api_key or pass --key.');
    this.sdk = new SmartSpectraSDK({
      apiKey,
      requestedMetrics: [...cardioMetrics, ...breathingMetrics, ...faceMetrics, ...edaMetrics],
      enableTelemetry: !!this.cfg.telemetry,
    });

    this.sdk.on('metrics', (buf) => {
      let s;
      try {
        s = sampleFromBuffer(buf, this.#now());
      } catch (err) {
        this.emit('log', `metrics decode failed: ${err.message}`);
        return;
      }
      s.synthetic = false;
      this.emit('sample', s);
    });
    this.sdk.on('validationStatus', (code) => {
      this.emit('validation', { code, hint: VALIDATION_HINTS[code] ?? `code ${code}` });
    });
    this.sdk.on('processingStatus', (status) => {
      this.emit('status', { status, label: statusName(status) });
    });
    this.sdk.on('error', (code, message, retryable) => {
      this.emit('error', { code, message, retryable });
    });

    if (this.cfg.source === 'file') {
      if (!fs.existsSync(this.cfg.file)) throw new Error(`Clip not found: ${this.cfg.file}`);
      // Pace frames at the clip's native rate so wall-clock phases and the SDK's
      // media timeline stay aligned (the analysis in recovery.mjs assumes ~1:1).
      const fps = detectFps(this.cfg.file);
      // exact pacing, not a rounded frame period: 29.97 fps is 33.37 ms, and rounding to
      // 33 ms drifts a second over a 60-second clip, which would skew the media timeline
      const opts = { interframeDelayMs: Math.round((1000 / (fps || 30)) * 100) / 100 };
      if (this.cfg.maxSeconds) opts.maxDurationMs = this.cfg.maxSeconds * 1000;
      this.emit('log', `file source: ${this.cfg.file} (${fps || 'unknown'} fps, pacing ${opts.interframeDelayMs} ms/frame)`);
      this.sdk.useFile(this.cfg.file, opts);
    } else {
      const sel = this.cfg.cameraId ? CameraSelection.byId(this.cfg.cameraId) : CameraSelection.default;
      this.sdk.useCamera(sel, { width: this.cfg.width, height: this.cfg.height });
    }
    this.sdk.start();
    return this;
  }

  #startMock() {
    this.emit('log', 'MOCK source — synthetic signals, not a real measurement');
    const tickMs = 1000;
    let heldPulse = this.mockState.pulse;
    let pulseTs = 0;
    let nextPulseAt = 0;
    this.mockTimer = setInterval(() => {
      const t = this.#now();
      if (t >= nextPulseAt) {
        nextPulseAt = t + 3000;
        heldPulse = this.#mockPulse(t, heldPulse);
        pulseTs = Math.round(t);
      }
      this.emit('sample', {
        t: Math.round(t),
        pulse: Math.round(heldPulse * 10) / 10,
        pulseConf: 78 + Math.round(6 * Math.sin(t / 9000)),
        pulseStable: true,
        pulseTs,
        hrvRmssd: 42 + Math.round(6 * Math.sin(t / 11000)),
        hrvConf: 66,
        breathing: Math.round(this.#mockBreathing() * 10) / 10,
        breathingConf: 70,
        talking: this.mode === 'answer',
        blinking: Math.random() < 0.06,
        expression: this.mode === 'answer' ? (Math.random() < 0.25 ? 'fear' : 'neutral') : 'neutral',
        expressionConf: 0.62,
        neutral: this.mode === 'answer' ? 0.55 : 0.88,
        synthetic: true,
      });
    }, tickMs);
    this.emit('validation', { code: 0, hint: 'mock: face ok' });
    return this;
  }

  #mockPulse(t, prev) {
    const baseline = 66;
    const noise = (Math.random() - 0.5) * 2.5;
    if (this.mode === 'recover') return Math.max(48, Math.min(120, baseline + (prev - baseline) * 0.5 + noise));
    const target = this.mode === 'answer' ? baseline + 19 : baseline;
    // ramp over roughly ten seconds, the way a body does it, so the integrity gate is not
    // fighting the fake signal it was written to catch
    return Math.max(48, Math.min(120, prev + (target - prev) * 0.22 + noise));
  }

  #mockBreathing() {
    return this.mode === 'answer' ? 19 + Math.random() * 2 : 13 + Math.random();
  }

  async stop() {
    if (this.mockTimer) clearInterval(this.mockTimer);
    this.mockTimer = null;
    if (!this.sdk) return;
    try { await this.sdk.stopAsync(); } catch { /* already down */ }
    try { await this.sdk.destroy(); } catch { /* already down */ }
    this.sdk = null;
  }
}

function statusName(s) {
  const name = Object.keys(ProcessingStatus).find((k) => ProcessingStatus[k] === s);
  return name ? name.toLowerCase() : String(s);
}

function detectFps(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', '0', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    const [n, d] = out.trim().split('/').map(Number);
    const fps = d ? n / d : n;
    return fps ? Math.round(fps * 100) / 100 : null;
  } catch {
    return null;
  }
}
