# Benchmark week

This directory is the artifacts hub for the **week-long taste calibration**
that precedes any agent implementation work. The output of this week
becomes the v1 default `polish.config.ts` shipped in `src/core/defaults.ts`.

See the project plan for the day-by-day workflow. Briefly:

1. **Day 1 — pick references.** Save 3 reference videos to `references/`:
   `feature-ref.mp4`, `walkthrough-ref.mp4`, `hero-ref.gif`.
2. **Day 2-3 — capture raw footage** of 3 demo scenarios into `raw/`.
3. **Day 4-6 — hand-author polish in Remotion.** Iterate per principle.
4. **Day 7 morning — run the 10 benchmarks** (see below) per video. Document.
5. **Day 7 afternoon — run the friend test.** 5-10 designer/dev friends, no context.
6. **Day 7 evening — extract findings**, replace `src/core/defaults.ts` numbers.

## The 10 benchmarks

For each of the 3 hand-authored videos, run all 10 tests. Each pass/fail
result points to specific config parameters to tune.

(Full benchmark spec lives in the project plan; this directory is for the
artifacts. The benchmark runner is intentionally manual — there is no
substitute for human eyes for a taste calibration.)

## Layout

```
benchmark/
├── references/    # 3 reference videos to MATCH the aesthetic of (gitignored)
├── raw/           # 3 raw playwright captures, no polish (gitignored)
├── polished/      # 3 hand-authored polished outputs (committed)
├── findings.md    # the extracted parameter calibrations + rationale
└── README.md      # this file
```

References and raw frames are gitignored to keep the repo lean. The polished
outputs and `findings.md` are the durable artifacts.
