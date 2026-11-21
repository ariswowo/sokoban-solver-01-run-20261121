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
| 3 | 2 | 8 | 20 | 20 | 92 | room-decomposed push-optimal A\* | 1000 |
| 4 | 3 | 12 | 32 | 32 | 178 | room-decomposed push-optimal A\* | 1000 |
| 5 | 4 | 16 | 44 | 44 | 204 | room-decomposed push-optimal A\* | 1000 |

**Total: 5/5 solved, every level exactly at P\*, estimated score
1,000,000 / 1,000,000, whole set in 1.05 s (limit: 60 s).**
Two consecutive runs produce byte-identical outputs (determinism: True).

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

- The real practice set (kit download page returned no extractable
  content via the text fetcher, so it was not retrieved).
- `grade-local` in the grader sandbox (Node 22, 1 CPU, 512 MB, 60 s,
  `/input` + `/output` layout). Local runs use Node 24; `main.ts` uses
  only erasable TypeScript syntax so Node 22 type-stripping runs it.
- Which exact output filename the checker reads — `main.ts` writes
  every plausible one (see README).
