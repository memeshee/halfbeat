# Pipeline evaluation — recorded input

Generated 2026-11-05 22:07:21 UTC by `scripts/eval.mjs`.

These runs use the SDK's recorded-video input path (`useFile()`), paced at the clip's native
frame rate. They measure **the pipeline**, not the people in the footage: the question is whether
the app produces usable, stable, honestly-caveated numbers from a file, and where it does not.

| clip | samples | pulse readings | mean bpm | sd | mean confidence | face present | peak | back down | half-life | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| pex_a_loop.mp4 | 102 | 41 | 60.3 | 1.4 | 68 | 59% | 62 | 0s | — | analysed |
| yokosuka.mp4 | 106 | 48 | 78.4 | 8.3 | 71 | 54% | — | — | — | insufficient signal |

## What this table is for

- A clip with **zero pulse readings** is the useful negative result: it says the pipeline refuses to
  invent a number when the footage is unusable, which is the behaviour the product depends on.
- The spread (`sd`) is the honest noise floor of a 12-second-average pulse on recorded input; a
  recovery half-life below that noise floor is not a result, it is a rounding artefact.
- Every number here is intra-clip. Nothing is benchmarked against a population.
