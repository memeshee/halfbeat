# How HalfBeat works

## The one design constraint everything follows

SmartSpectra's pulse rate is a **12-second average** with a confidence score; HRV needs a full
**60-second** window; breathing rate needs **30 seconds**. That is not a limitation to work around —
it decides what kind of product you can honestly build on this SDK.

It rules out reflex games and “your heart rate right now” dashboards. It leaves exactly one
interesting interaction: **a slow signal is a recovery signal.** So HalfBeat measures the return,
not the peak: how long after a hard question does the body come back inside its own calm band, and
what does that curve look like across questions and across runs.

## Pipeline

```
[camera]  ─┐
[file]    ─┼─► Source (src/source.mjs)
[mock]    ─┘        │
                    ├─ useCamera(CameraSelection)      live frames
                    ├─ useFile(path, {interframeDelayMs}) recorded frames, paced to real time
                    └─ setInterval synth               mock, always labelled
                    ▼
        SmartSpectraSDK  ── 'metrics' (protobuf) ──► signals.mjs  ──► one flat sample per tick
                    │                                                   {t, pulse, pulseConf, pulseTs,
                    │                                                    breathing, hrv, talking,
                    │                                                    expression, …}
                    ▼
        session.mjs  phases: consent → check → baseline → (question → answer → recover)×N → report
                    │        stamps every phase boundary on the *sample* clock
                    ▼
        recovery.mjs   buildBaseline → analyseRound → rankRounds (pure, unit-checked)
                    ▼
        session JSON ──► server.mjs (127.0.0.1 http + ws) ──► web/ (live UI, report, replay)
```

## Decisions worth defending

**One clock.** Phase boundaries are stamped with `source.nowMs()`, the same clock that stamps each
sample, so a round's samples and its boundaries can never drift apart. This is why the timeline lines
up with the question cards in the report.

**Dedupe before statistics.** The SDK re-emits its rolling measurement array on every metrics tick, so
at 1 Hz most samples repeat the same 12-second pulse value. `usablePulse()` dedupes on the SDK's own
measurement timestamp; without that, a least-squares fit is dominated by repeated points and reports a
half-life that is really just the tick rate.

**Two recovery numbers, not one.** `timeToBand` is discrete and robust: seconds from the round's peak
until pulse stays inside baseline ± band for the rest of the window. `halfLife` is a fit of
`ln(pulse − baseline)` after the peak and is a trend, not a constant. When the signal never returns we
print **never** and the residual, instead of extrapolating a number the data does not contain.

**The baseline is intra-person.** Every figure is compared to a band learned in the first 45 seconds of
this session, on this camera, in this light. No population norm, no percentile, nothing that would
turn a normal body into a score.

**Mock is loud.** The synthetic source exists so the UI and analysis can be built and tested without a
camera or a key. It is labelled in the header chip, in the report metadata, in the legend under the
timeline, and in the artefact (`"synthetic": true`). `scripts/verify.mjs` asserts that label.

**Replay is a first-class path.** `web/replay.html` renders any session JSON with no server, no camera
and no SDK, which is what makes a static demo page possible and what makes the report inspectable by
anyone who has the file.

## Recorded-input mode

`--source file <clip>` runs a video file through the SDK's own `useFile()` path, paced at the clip's
frame rate so wall-clock phases match the SDK's media timeline. It exists for two reasons, both
stated in the README and in the post: it is how the evaluation harness produces the numbers in
`docs/EVAL.md` on repeated, shareable input, and it is how the demo was recorded. The live camera
path is the same code with a different source, and one flag switches it.
