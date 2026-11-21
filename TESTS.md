# Local test results

Run: `python3 tests/run_tests.py` (Node v24.22.1 locally; grader runs Node 22).
Last run: 2026-11-21. The verifier is independent Python: it simulates
every output move string on the level and counts pushes; P\* comes from
`tests/gen_levels.py` (per-room optimum via `main.ts --room-opt`, exact
weight-1 A\*).

## Generator-style practice set (fixtures/practice, 5 levels)

Built by `tests/gen_levels.py` to mimic the bounty generator: a 1-wide
hallway across the board, 1–4 rooms in 6×6 slots behind a single door,
3–4 boxes/goals per room, 30–80 reverse pulls from the solved state.
(Fixture rooms are kept at optimum ≥ 8/10 pushes instead of the bounty's
≥ 12/14, so fixtures generate in reasonable time; everything else
matches the bounty description. Growth matches the bounty: 1 room × 3
boxes, 1 × 4, 2 × 4, 3 × 4, 4 × 4.)

| Level | Rooms | Boxes | P\* | Solver pushes | Moves | Method | Points\* |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 3 | 9 | 9 | 31 | room-decomposed push-optimal A\* | 1000 |
| 2 | 1 | 4 | 13 | 13 | 46 | room-decomposed push-optimal A\* | 1000 |
| 3 | 2 | 8 | 18 | 18 | 84 | room-decomposed push-optimal A\* | 1000 |
| 4 | 3 | 12 | 28 | 28 | 176 | room-decomposed push-optimal A\* | 1000 |
| 5 | 4 | 16 | 40 | 40 | 188 | room-decomposed push-optimal A\* | 1000 |

**Total: 5/5 solved, every level exactly at P\*, estimated score
1,000,000 / 1,000,000, whole set in ~2.4 s (limit: 60 s).**
Two consecutive runs produce byte-identical outputs (determinism: True).

> Note: `fixtures/practice/expected.json` previously listed P\* as
> 9/13/20/32/44 — those were computed with the pre-fix solver's
> `--room-opt` and were overestimates. The kit's own reference solver
> (`program/generator/subject/solver.mjs::solveByRooms`) gives the true
> optima 9/13/18/28/40 (per-room 9; 13; 8+10; 10+10+8; 10+9+11+10),
> matching this solver exactly; `expected.json` was corrected to them
> on 2026-11-21.

## Official kit practice set (real levels, 2026-11-21)

Kit `sokoban-solver-01-run-20261121-kit` (downloaded from
`GET /c/sokoban-solver-01-run-20261121/kit`), `grade-local --driver
process`: **score 1,000,000 / 1,000,000** — all 5 levels solved exactly
at P\* (manifest keys 13, 16, 29, 47, 60; per-room sums 13; 16; 15+14;
15+15+17; 16+14+14+16), whole set in ~2.3 s, two executions
byte-identical (L1 regrade reproduced byte for byte). The house baseline
`plain-astar 1.0.0` scores 200,000 on the same set (solves i001 only).

This run caught the bug the fixture set had missed: the pre-fix solver
scored **0** on the real practice set. Its corner / wall-line dead-square
heuristic wrongly marked live squares dead (e.g. i001's boxes at (3,5)
and (4,7), which escape their wall run at its open end), pruning every
successor, and its longest-straight-run hallway guess found partial or
wrong rooms on i001–i003. The fix (2026-11-21, in `main.ts`): exact dead
squares by reverse pulls from the goals, and room decomposition by
cutting the player's row's dead squares (the kit's own `roomsOf`
method). Both fixes follow the kit's own solver
(`program/generator/subject/solver.mjs`); the fixture P\* values above
were corrected at the same time (see note).

\*Points use the assumed checker formula 1000 × P\*/pushes (1000 at
optimum); the exact checker formula lives in the kit, which could not be
downloaded here (see README).

## Cross-checks

- **Independent brute force:** level 1's room optimum was recomputed
  with a plain push-BFS in Python (`tests/gen_levels.py::room_optimum`,
  no heuristic, no TS code): **9 pushes**, matching P\* = 9.
- **Handcrafted 2-room level** (`fixtures/hand2.txt`, 3 rooms, 9 boxes,
  incl. a box on a door row that can only be pushed inward from the
  hallway): solved with **11 pushes** (3+3+5 per room), verified by the
  independent simulator. This test caught a real bug — the room solver
  originally confined the player to room cells; it now also allows
  standing on hallway cells adjacent to the room (boxes may never be
  pushed into them).
- **Trivial / small levels** (`fixtures/t1`, `t2`): 1 push and 3 pushes,
  verified.
- **Input layouts:** flat `*.txt` files and `cases.json` both discovered
  and solved correctly.
- **Fallback:** whole-level push A\* (weight 1, then 3, 10) is exercised
  on levels without a hallway/room structure (`t2`, and `hand2` before
  the decomposition fix).

## Not tested here (needs the official kit)

- `grade-local` in the grader sandbox (Docker, Node 22/26, 1 CPU,
  512 MB, 60 s, `/input` + `/output` layout). Local runs use Node 24
  with `--driver process`; the kit's own note says the score is the same
  either way and the L1 regrade reproduced byte for byte.
- Which exact output filename the checker reads — verified: the checker
  reads `<id>/solution.txt` only (see README); `main.ts` also writes the
  other usual names as harmless extras.
