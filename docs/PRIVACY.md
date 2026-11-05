# Privacy and data handling — HalfBeat

This file is the plain-language answer to “what happens to my face if I run this?”. It describes the
code in this repository, not a policy we might change later.

## What is captured

- **The webcam, while a session is running.** Nothing else. No microphone is opened, so no audio
  exists at any point. “Talking” is inferred from your face on video.
- Capture stops when the session ends, when you close the tab's session, or when the process exits
  (`Ctrl`+`C`, or the window closing). The camera light going out is the signal that it stopped.

## What is processed where

- Frames are handed to the SmartSpectra SDK inside the same Node process, on this machine. The SDK
  computes pulse, breathing rate, HRV, expression, blink and talking **on-device**.
- The browser UI is a local page served from `127.0.0.1` and fed by a WebSocket bound to `127.0.0.1`.
  There is no server component, no account, and no remote endpoint in this application's own code.

## What is stored

- **Nothing, unless you ask.** By default the session writes one JSON file to `sessions/` at the end
  of a run (`--out` overrides the path; `--headless` writes it too).
- The file contains numbers and timestamps only: pulse values with confidence, breathing rate, HRV,
  expression labels with probabilities, talking yes/no, phase boundaries and the derived recovery
  metrics. **No images, no video, no audio, no face landmarks, no face geometry.**
- The file is not encrypted and it is not access-controlled beyond your own user account's file
  permissions. Treat it as personal data, because that is what it is.

## Retention and deletion

- Sessions stay until you delete them. `rm -r sessions/` is the whole deletion mechanism; there is no
  copy anywhere else, no backup, no recycle bin.
- Nothing is retained between runs: the baseline is recomputed every session, so no profile of you
  accumulates inside the app.

## Third parties

- **Presage (the SDK vendor).** The SDK can send a small, aggregate, non-identifying per-session
  diagnostic summary (source kind, rough system/duration information — no video, no vitals values, no
  user identifiers) over an authenticated channel while a session is active. **This build disables it
  by default**: `new SmartSpectraSDK({ enableTelemetry: false })` in `src/source.mjs`. `--telemetry`
  turns it back on. The vendor's description of exactly what that covers is at
  <https://smartspectra.presagetech.com/docs/telemetry-and-privacy>.
- **API key check.** Starting a session authenticates once with your SmartSpectra API key, and metric
  requests are authorised against the vendor's service. That request carries no video or vital values.
- **No LLM, no analytics, no fonts, no CDNs.** The UI loads nothing from the network, including on the
  replay page, which is why it also works offline.
- **The language-model channel is never requested.** The app contains no `requestInsight()` call. That
  is a statement about our code; the bytes on the wire are a statement about the SDK. Rather than
  assert either, `scripts/egress.mjs` watches every outbound TCP connection the app's process tree
  opens during a session and writes `docs/EGRESS.md` — the endpoints the SDK's own metric
  authorisation and licensing open show up there, in public, next to this claim. Runtime pulse
  computation is on-device; no frame is uploaded to compute it.

## What this app is not

- Not a medical device. Not a diagnosis, a treatment, a screening test or a fitness-for-work
  assessment. The vendor's SDK is explicitly wellness-only in this form.
- Not a monitoring tool for someone else. It measures the person sitting in front of the camera, who
  consented on the gate screen. Running it on a colleague, an interviewee or anyone who has not
  agreed is a misuse of the software and of that person's data.
- Not a lie detector, a personality test, or a hiring signal. A pulse rising during a hard question is
  a normal thing bodies do.

## If you share a session file

The JSON is small enough to paste. It still contains a physiological recording of one person's
session. Share it deliberately, or trim it to the `rounds` array, which carries the derived metrics
without the raw samples.
