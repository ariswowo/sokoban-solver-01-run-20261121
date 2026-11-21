#!/usr/bin/env python3
"""Generate generator-style Sokoban levels (hallway + 6x6 rooms, reverse pulls)
and compute each room's push-optimum with an independent brute-force BFS.

Writes fixtures/practice/<n>/level.txt and fixtures/practice/expected.json
with P* per level (= sum of per-room optima).
"""
import json, random, sys
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "fixtures" / "practice"

DIRS = [(-1, 0), (1, 0), (0, -1), (0, 1)]  # dy,dx

def bfs_reach(floor, boxes, start):
    seen = {start}
    q = deque([start])
    while q:
        y, x = q.popleft()
        for dy, dx in DIRS:
            n = (y + dy, x + dx)
            if n in floor and n not in boxes and n not in seen:
                seen.add(n); q.append(n)
    return seen

def ts_optimum(floor, goals, boxes, door):
    """Push-optimum of a room, via main.ts --room-opt (exact A*, weight 1).
    Much faster than the Python BFS below for 4 boxes."""
    import subprocess
    ys = [y for y, _ in floor]; xs = [x for _, x in floor]
    h = max(ys) + 3; w = max(xs) + 3
    g = [["#"] * w for _ in range(h)]
    for (y, x) in floor:
        g[y][x] = " "
    for (y, x) in goals:
        g[y][x] = "."
    for (y, x) in boxes:
        g[y][x] = "*" if (y, x) in goals else "$"
    py, px = door
    g[py][px] = "@" if g[py][px] == " " else "+"
    import tempfile, os
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write("\n".join("".join(r) for r in g) + "\n")
        path = f.name
    try:
        r = subprocess.run(["node", "main.ts", "--room-opt", path],
                           cwd=ROOT, capture_output=True, text=True, timeout=120)
        v = int(r.stdout.strip())
        return v if v >= 0 else None
    except Exception:
        return None
    finally:
        os.unlink(path)

def room_optimum(floor, goals, boxes, door):
    """Brute-force BFS over pushes; returns min pushes from door, or None."""
    start = (tuple(sorted(boxes)), door)
    # canonical player: smallest reachable cell
    def canon(boxes_t, player):
        reach = bfs_reach(floor, set(boxes_t), player)
        return min(reach)
    seen = {(start[0], canon(start[0], start[1]))}
    q = deque([(start[0], start[1], 0)])
    while q:
        boxes_t, player, pushes = q.popleft()
        if all(b in goals for b in boxes_t):
            return pushes
        boxset = set(boxes_t)
        reach = bfs_reach(floor, boxset, player)
        for i, b in enumerate(boxes_t):
            by, bx = b
            for dy, dx in DIRS:
                tgt = (by + dy, bx + dx)
                stand = (by - dy, bx - dx)
                if tgt not in floor or tgt in boxset or stand not in reach:
                    continue
                nb = list(boxes_t); nb[i] = tgt; nb_t = tuple(sorted(nb))
                key = (nb_t, canon(nb_t, b))
                if key not in seen:
                    seen.add(key); q.append((nb_t, b, pushes + 1))
    return None

def assignment_lb(floor, goals, boxes):
    """Admissible lower bound: min over bijections of BFS distances
    (boxes -> goals, ignoring other boxes). Brute force over permutations
    (n <= 4). Returns 0 if any box cannot reach any goal."""
    import itertools
    def dist(a, b):
        q = deque([(a, 0)]); seen = {a}
        while q:
            (y, x), d = q.popleft()
            if (y, x) == b:
                return d
            for dy, dx in DIRS:
                n = (y + dy, x + dx)
                if n in floor and n not in seen:
                    seen.add(n); q.append((n, d + 1))
        return 10 ** 6
    best = 10 ** 9
    for perm in itertools.permutations(goals):
        s = sum(dist(b, g) for b, g in zip(boxes, perm))
        best = min(best, s)
    return best

def gen_room(rng, rows, cols, nboxes, door):
    """rows/cols: slot ranges. door: (y,x) cell inside slot on hallway edge.
    Returns (floor set, goals set, boxes list) or None if unusable."""
    for _attempt in range(200):
        floor = set()
        for y in rows:
            for x in cols:
                if rng.random() > 0.18:
                    floor.add((y, x))
        floor.add(door)
        # Single door, like the bounty generator: wall off every other
        # cell of the door row inside the slot.
        floor = {c for c in floor if not (c[0] == door[0] and c != door)}
        # connectivity: everything must connect to door
        reach = bfs_reach(floor, set(), door)
        floor = {c for c in floor if c in reach}
        if len(floor) < 14:
            continue
        cells = sorted(floor - {door})
        if len(cells) < nboxes + 2:
            continue
        goals = set(rng.sample(cells, nboxes))
        boxes = list(goals)
        player = door
        # reverse pulls
        pulls = rng.randint(30, 80)
        done = 0
        for _ in range(pulls * 3):
            if done >= pulls:
                break
            boxset = set(boxes)
            reach = bfs_reach(floor, boxset, player)
            cands = []
            for b in boxes:
                by, bx = b
                for dy, dx in DIRS:
                    # Reverse of a forward push in direction (dy,dx):
                    # forward: player at b-d, box at b -> player at b, box at b+d.
                    # Reverse: box at b, player must walk to b-d, then the
                    # box moves to b-d and the player ends at b-2d.
                    stand = (by - dy, bx - dx)  # player walks here
                    dst = (by - dy, bx - dx)    # box moves here
                    new_player = (by - 2 * dy, bx - 2 * dx)
                    if stand in reach and dst in floor and dst not in boxset \
                            and new_player in floor and new_player not in boxset:
                        cands.append((b, (dy, dx), stand, dst, new_player))
            if not cands:
                break
            b, (dy, dx), stand, dst, new_player = rng.choice(cands)
            boxes = [dst if v == b else v for v in boxes]
            player = new_player
            done += 1
        if done < 20:
            continue
        # Cheap lower bound first (assignment cost on BFS distances):
        # skip the oracle when even the bound is far below the bar.
        lb = assignment_lb(floor, goals, boxes)
        if lb < 6:
            continue
        opt = ts_optimum(floor, goals, boxes, door)
        if opt is None:
            continue
        # Fixtures only need a known optimum; the bounty keeps rooms
        # with opt >= 12 (3 boxes) / >= 14 (4 boxes) — we accept >= 8/10
        # so fixtures generate in reasonable time.
        if opt >= (8 if nboxes == 3 else 10):
            return floor, goals, boxes, opt
    return None

def gen_level(rng, nrooms, nboxes_list):
    W, H = 31, 19
    hall_y = 9
    # slots: above rows 3..8 (door row 8 touches hallway y=9),
    # below rows 10..15 (door row 10 touches hallway y=9); x slots width 6
    slots = []
    for x0 in (2, 9, 16, 23):
        slots.append(("above", range(3, 9), range(x0, x0 + 6)))
        slots.append(("below", range(10, 16), range(x0, x0 + 6)))
    rng.shuffle(slots)
    grid = [["#"] * W for _ in range(H)]
    for x in range(1, W - 1):
        grid[hall_y][x] = " "
    player = (hall_y, W // 2)
    rooms = []
    used_cols = set()
    for side, rows, cols in slots:
        if len(rooms) >= nrooms:
            break
        door_x = rng.choice(list(cols))
        if door_x in used_cols:
            continue
        door = (rows[-1] if side == "above" else rows[0], door_x)
        # hallway neighbour of door
        hall_cell = (hall_y, door_x)
        if grid[hall_y][door_x] != " ":
            continue
        nboxes = nboxes_list[len(rooms)]
        r = gen_room(rng, rows, cols, nboxes, door)
        if r is None:
            continue
        floor, goals, boxes, opt = r
        used_cols.add(door_x)
        rooms.append((floor, goals, boxes, opt, door))
    if len(rooms) < nrooms:
        return None
    for floor, goals, boxes, opt, door in rooms:
        for (y, x) in floor:
            grid[y][x] = " "
        for (y, x) in goals:
            grid[y][x] = "."
        for (y, x) in boxes:
            grid[y][x] = "*" if (y, x) in goals else "$"
    py, px = player
    grid[py][px] = "@"
    text = "\n".join("".join(row).rstrip() for row in grid) + "\n"
    pstar = sum(r[3] for r in rooms)
    return text, pstar, [r[3] for r in rooms]

def main():
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 20261121
    rng = random.Random(seed)
    OUT.mkdir(parents=True, exist_ok=True)
    # growth like the bounty: 1 room x3 boxes, 1x4, 2x4, 3x4, 4x4
    specs = [(1, [3]), (1, [4]), (2, [4, 4]), (3, [4, 4, 4]), (4, [4, 4, 4, 4])]
    expected = {}
    for idx, (nrooms, nb) in enumerate(specs, start=1):
        for attempt in range(50):
            got = gen_level(rng, nrooms, nb)
            if got:
                break
        if not got:
            print(f"level {idx}: FAILED to generate", file=sys.stderr)
            sys.exit(1)
        text, pstar, per_room = got
        d = OUT / str(idx)
        d.mkdir(parents=True, exist_ok=True)
        (d / "level.txt").write_text(text)
        expected[str(idx)] = {"p_star": pstar, "per_room_optima": per_room,
                              "rooms": nrooms, "boxes": sum(nb)}
        print(f"level {idx}: rooms={nrooms} boxes={sum(nb)} P*={pstar} per-room={per_room}")
    (OUT / "expected.json").write_text(json.dumps(expected, indent=2))
    print("wrote", OUT)

if __name__ == "__main__":
    main()
