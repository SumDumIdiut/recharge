# Course route solver

Finds the **fastest possible time** through one course, then draws the **trail** it took and emits
the **inputs at their frames** so the run can be played back.

Documented in the vault: `amplifier-vault/Solver/`.

```
map.json ──▶ course.mjs ──▶ world { solids, hazards, start, end }
                                 │
              physics.mjs ───────┤ step(state, input)
                                 ▼
          search.mjs  ──▶  replay { time, inputs[], trail[] }
                                 │
          render.mjs  ──▶  route.svg    the drawn trail
          solve.mjs   ──▶  route.json   the input log, for playback
```

## Quick look

```bash
node tools/course-solver/solve.mjs --demo --out /tmp/recharge-solver/demo --verbose
```

Prints a time, writes `/tmp/recharge-solver/demo.json` (the replay) and `/tmp/recharge-solver/demo.svg` (the
trail), and lists the inputs frame by frame.

## Real map

```bash
node tools/course-solver/solve.mjs --map map.json --course 3 --out /tmp/recharge-solver/route
node tools/course-solver/solve.mjs --map map.json --course 3 --mode brute --verify
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--map` / `--level` / `--demo` | — | where the course comes from |
| `--course <n>` | 0 | course index within the first group |
| `--prim <file>` | — | `{"orangeBlocks":true}` solid-name overrides |
| `--margin <n>` | 2048 | how far around the course to build geometry |
| `--end-size <n>` | 96 | size of the end box around the end gate |
| `--mode uniform\|astar\|brute\|beam` | astar | search (see the vault) |
| `--nodes <n>` | 400000 | expansion budget |
| `--beam <n>` | 600 | states kept per frame in beam mode (not optimal) |
| `--max-frames <n>` | 6000 | beam: how far to look |
| `--qx --qy --qv` | 4 4 1 | state quantisation |
| `--sample <n>` | 1 | trail sample interval |
| `--out <base>` | — | write `<base>.json` and `<base>.svg` |
| `--verbose` / `--every` | — | per-frame input listing / every frame |
| `--verify` | — | re-simulate the inputs and check they reproduce |

Maps from the Hub store geometry in `groups[].objects`, not `tileLayers`; both shapes are read.
Real courses are thousands of units long and the exact modes cannot reach them — use `--mode beam`
and read `amplifier-vault/Solver/Solving a Real Course`.

## Replay

```bash
node tools/course-solver/replay.mjs --demo --replay /tmp/recharge-solver/demo.json --out /tmp/recharge-solver/again
```

## The replay format

```jsonc
{
  "version": 1, "course": 0,
  "dt": 0.0166667, "time": 3.783, "frames": 227,
  "solved": true, "bounded": false,
  "inputs": [0, 0, 2, 2, 18, ...],                  // one bitmask per frame
  "trail": [ { "f": 0, "x": 48, "y": 40, "s": "ground" }, ... ]
}
```

Buttons: `1 left, 2 right, 4 up, 8 down, 16 jump, 32 dash, 64 swap`. Feed `inputs[n]` to the
simulation for frame `n` and the run reproduces exactly — in the solver, in the editor's playtest,
or in the real game.

## Honesty

The time is **optimal under the model**, not under the game. `physics.mjs`'s constants are
plausible, not measured; `PHYSICS.confidence` says so and the solver prints it. See
`amplifier-vault/Roadmap/Physics Model` for the calibration plan.

## Layout

| File | What |
| --- | --- |
| `geom.mjs` | boxes and the solid-cell grid |
| `physics.mjs` | the constants, the buttons, `step`, `simulate` |
| `course.mjs` | a map (or a level spec) → a world |
| `search.mjs` | `solve` (uniform / A\*) and `brute` |
| `replay.mjs` | the replay format, verification, the input listing |
| `render.mjs` | the SVG trail |
| `cli.mjs` | argument parsing and world loading |
| `solve.mjs` | the CLI |
