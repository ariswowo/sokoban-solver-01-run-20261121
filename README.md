# Sokoban solver — make.fun bounty `sokoban-solver-01-run-20261121`

Entry for make.fun's “Build the best Sokoban solver, 21 November 2026”
bounty, $100 in USDC. Built by an AI agent for make.fun's bounty.
Homepage: https://make.fun/bounty/sokoban-solver-01-run-20261121

**Status: built and locally verified. NOT submitted** — submission (public
GitHub repo under `ariswowo`, transcript bundle, API-key connect) is a
separate step, see “Still needed to submit” below.

## What it does

`main.ts` (Node 22, standard library only, no network, deterministic) reads
every Sokoban level instance from `$MAKEFUN_INPUT_DIR` (default `/input`)
— each instance a `level.txt` in XSB (`#` wall, ` ` floor, `.` goal,
`$` box, `*` box on goal, `@` player) — and writes the player's moves for
each instance to `$MAKEFUN_OUTPUT_DIR` (default `/output`), in standard
Sokoban notation: lowercase `udlr` = walk, UPPERCASE `UDLR` = push, one
line per instance. It answers the whole set in one run, well inside the
60-second limit.

## How it works

The bounty generator (per the bounty text) lays a 1-wide hallway across the
board with 1–4 rooms off it, each in a 6×6 slot behind a single door,
3–4 boxes/goals per room. A box pushed through a door into the hallway can
never be pushed back, so in an optimal solution every box stays in its room
and the level's push-optimum P\* is the **sum of the rooms' optima**.
The solver exploits exactly that:

1. **Decompose** — find the bridge (door) cells of the floor graph
   (Tarjan) and split the level into hallway + rooms.
2. **Solve each room push-optimally** — A\* over pushes. State = sorted
   box positions + canonical player position (smallest cell of the
   player's reachable region). Heuristic = exact min-cost box→goal
   assignment (Hungarian) on BFS distances ignoring boxes — admissible,
   so A\* returns the push optimum. Pruning: corner / wall-line dead
   squares, 2×2 freeze deadlocks, unreachable-assignment detection.
   A goal state is only accepted if the player can still walk back out
   through the door, so rooms stitch cleanly.
3. **Stitch** — try every visit order of the rooms and keep the one with
   the fewest total moves (pushes are identical for every order: the sum
   of the room optima). Hallway walks are BFS paths that never enter an
   unsolved room.
4. **Fallback** — if a level does not decompose (e.g. a classic level
   with no hallway/rooms), whole-level push A\*, then weighted A\*
   (weights 3, 10) under deterministic node budgets, so an answer is
   still produced instead of nothing.

Determinism: fixed neighbour order, fixed heap tie-breaks, node-count
budgets (a 52 s wall-clock emergency stop exists only so the run can
never overrun the 60 s limit). Two local runs produce identical bytes
(verified in `TESTS.md`).

## Run it

```sh
node main.ts
# or, locally:
mkdir -p out
MAKEFUN_INPUT_DIR=fixtures/practice MAKEFUN_OUTPUT_DIR=out node main.ts
python3 tests/run_tests.py   # independent simulator + P* comparison
```

## Files

| File | What it is |
| --- | --- |
| `main.ts` | The entry (Node 22, stdlib only). This + `README.md` + `LICENSE` are the submission. |
| `LICENSE` | MIT. |
| `TESTS.md` | Local test results. |
| `tests/gen_levels.py` | Generator-style fixture builder (hallway + 6×6 rooms, reverse pulls) + independent brute-force BFS that computes each room's push-optimum. |
| `tests/run_tests.py` | Independent verifier: simulates every output, counts pushes, compares with P\*, checks determinism. |
| `fixtures/` | Test levels (trivial, small, and 5 generator-style practice levels). |

## I/O layouts handled

The kit's exact input/output filenames could not be read from the public
API (the kit download page returned no extractable content via the text
fetcher), so `main.ts` is liberal on both sides: it discovers levels
recursively as `level.txt` / `*.txt` / `*.in` / `*.xsb` / `*.sok` and
`cases.json`-style JSON, and for every instance id writes the same move
string to `<id>/solution.txt`, `<id>/moves.txt`, `<id>/answer.txt`,
`<id>/solution.out`, `<id>.out`, `<id>.txt`, plus `solutions.json` /
`answers.json`. A checker reading any of the usual layouts finds the
answer. **Before submitting, run the kit's `grade-local` against the real
practice set and confirm which layout it reads; if it expects a different
name, add that one file — the solver core does not change.**

## Still needed to submit

1. Create the public GitHub repo under `ariswowo` (repo creation /
   GitHub repo selection was not finished at build time), push this
   directory, set About description/homepage/topics per the bounty
   requirements (`makefun,ai-agents,bounties,code`).
2. Download the official kit and run `node cli/makefun.mjs grade-local`
   on the real practice set; confirm the output layout (see above).
3. Bundle the AI transcripts that built this entry
   (`node cli/makefun.mjs bundle` from inside the unpacked kit) — the
   sessions that wrote this code must be uploaded with the submission.
4. Submit with the user's connected make.fun API key before
   **2026-11-23T03:00:00Z** (Mon 23 Nov 2026 10:00 WIB). At most 10
   submissions per UTC day, 20 total; the most recent before the deadline
   is the final entry. A prize needs a score strictly above make.fun's
   own `plain-astar 1.0.0` house baseline; places 1–10 each pay $10.
