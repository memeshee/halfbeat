# HalfBeat

**A camera-only interview trainer that scores the one thing nobody scores: how fast you come back
down.** Built with the [Presage SmartSpectra SDK](https://github.com/Presage-Security/SmartSpectra),
which estimates pulse, breathing, facial expression and talking from a plain webcam.

Every speaking coach on the market scores the *level* — “your composure was 71”. HalfBeat scores the
*return*: after each hard question, how long until your pulse was back inside your own calm band, and
what the exponential half-life of that decay was. That number is the product, because it is the one
that changes with practice.

```
npm install
echo 'YOUR_SMARTSPECTRA_KEY' > ~/.presage_api_key
npm start                     # live camera session → http://127.0.0.1:7777
```

No key? `npm run replay` runs the whole app on a synthetic signal source so you can see the interface
and the analysis. It is labelled **MOCK** everywhere and is never used for a reported result.

## What a session does

1. **Consent gate** — the camera is not opened until you press the button. Plain language, no
   pre-ticked anything, and the app states what is and is not stored.
2. **Framing check** — face, light and signal quality from the SDK's own validation codes, with the
   hint text the SDK supplies (`kTooDark`, `kChestNotVisible`, `kExcessiveMotion`, …).
3. **Settle-in (45 s)** — your personal calm baseline: median pulse and a band, measured in this
   room, on this camera, today. Every later number is compared to *your* baseline only.
4. **Rounds** — a real interview question, a 60 s answer out loud, then a 60 s recovery window where
   you stop talking and sit still. The SDK's pulse (12 s average), talking detection and expression
   probabilities all land on one timeline.
5. **Report** — questions ranked by how slowly you came down, peak pulse and delta, time back inside
   the baseline band, and the decay half-life. Run the same question set again and the report
   compares the two runs.

## How the numbers are made (and what they can't do)

| number | how | honest limit |
|---|---|---|
| pulse | SmartSpectra `cardio.pulseRate` (12 s average, confidence gated at ≥40) | resolution is one 12 s window; a “time to come back down” of 24 s means two windows, not 24.0 s of precision |
| failure to recover | seconds from the round's peak until pulse stays inside baseline ±band to the end of the window | if it never returns, we say **never** and show the residual, rather than extrapolating |
| half-life | least-squares fit of `ln(pulse − baseline)` after the peak | useful as a trend across rounds, not as a physiological constant |
| talking | `face.talking.detected` | visual, not audio — no microphone is opened |
| expression | `face.expression` dominant class | used as context, never as the headline claim |
| HRV | `cardio.hrv` (RMSSD) | needs a full 60 s clean window, so it is usually absent in a 60 s round; shown as “— (needs 60s)” rather than faked |

The 12-second pulse window is the reason this app is a *recovery* trainer and not a reaction-time
game. Pretending otherwise would be the easy way to make a demo look better and a product useless.

## Consent and data

- **Camera only.** No microphone, no audio, no screen capture.
- **No video is written.** Frames are decoded by the SDK in memory and discarded; the app stores a
  JSON file of numbers, and only when you pass `--out` (or accept the default `sessions/` path).
- **Nothing is uploaded.** The UI is served from `127.0.0.1` over a local WebSocket. There is no
  server component and no account.
- **SDK telemetry is off by default** in this build: the SDK is constructed with
  `enableTelemetry: false` (see `src/source.mjs`). Pass `--telemetry` if you want the vendor's
  aggregate, non-identifying session diagnostics back on.
- **Egress is measured, not promised.** `scripts/egress.mjs` watches every outbound TCP connection
  the app's process tree opens while a session runs and writes `docs/EGRESS.md`. The app itself never
  calls `requestInsight()` and never uploads a frame; the table is the evidence, including the
  connections the SDK's own licensing and metric authorisation open.
- **Wellness only.** Every figure here is a general-wellness estimate. The SDK is not an FDA-cleared
  device — Presage's cleared product is a separate thing — and nothing in this app is a diagnosis, a
  treatment, or a fitness-for-work assessment.
- **Delete = delete.** The session files are ordinary JSON in `sessions/`; remove the directory and
  the record is gone. There is no other copy.

## Commands

```
npm start                                   live camera
npm run replay                              synthetic source (no camera, no key)
npm run file -- --file clip.mp4             run a recorded video through the SDK

--source camera|file|mock    --port 7777    --out sessions/x.json
--baseline 45 --answer 60 --recover 60      --rounds 6
--headless                                  one JSON line per sample, no UI
--telemetry                                 leave the SDK's aggregate telemetry on
--no-open                                   do not open a browser
```

`web/replay.html` renders any saved session with no server, no camera and no SDK — it is what the
static demo page uses.

## Layout

```
src/index.mjs      process entry, CLI, signal handling
src/source.mjs     camera / file / mock sources behind one interface
src/signals.mjs    protobuf metrics → one flat sample per tick
src/session.mjs    phases, rounds, the session artefact
src/recovery.mjs   baseline, peak, time-to-band, half-life, ranking (pure functions)
src/server.mjs     localhost HTTP + WebSocket
web/               the UI (no build step, no framework); report.js is shared with replay
scripts/verify.mjs end-to-end check, exits nonzero on failure
scripts/eval.mjs   runs the clip set and writes the numbers table in docs/EVAL.md
```

## Requirements

Node ≥ 20 on Linux x64/arm64, macOS arm64 or Windows x64. The SDK ships prebuilt native runtimes per
platform (`npm install` pulls all of them, ~400 MB). Linux needs glibc ≥ 2.35.

## Credits

Vitals are computed by the [Presage SmartSpectra SDK](https://smartspectra.presagetech.com); the
recovery analysis, the UI and the evaluation harness are this repository's work. Licence: MIT.
