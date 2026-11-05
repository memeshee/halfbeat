# Measured network egress

Run 2026-11-05 22:21:18 UTC · args: `src/index.mjs --source file --file /home/kiter/hackathon/_assets/pex_a_loop.mp4 --headless --baseline 45 --answer 15 --recover 12 --rounds 1` · sampled every 500 ms with `ss -tnp`.

| # | remote endpoint | reverse DNS | first seen |
|---|---|---|---|
| 1 | `76.223.65.59:443` | a92d5d31dd2c27986.awsglobalaccelerator.com | 6s |
| 2 | `15.197.69.23:443` | a92d5d31dd2c27986.awsglobalaccelerator.com | 7s |

## What this does and does not prove

- It proves which remote TCP endpoints accepted a connection from this process while a session ran.
- It does not prove *what* was sent. The app disables the SDK's aggregate telemetry
  (`enableTelemetry: false`) and never calls `requestInsight()`, so no vitals or frames are
  handed anywhere by this code — but the SDK is a closed native binary, and the honest statement is
  the connection list above, not a claim about the bytes.
- Runtime metric computation is on-device: no frames are uploaded to compute pulse.
