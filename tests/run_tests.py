#!/usr/bin/env python3
"""Independent verifier for main.ts output: simulate every move string,
count pushes, compare against expected P* from fixtures/practice/expected.json.
Usage: python3 tests/run_tests.py [input_dir] [output_dir]
"""
import json, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIRS = {"u": (-1, 0), "d": (1, 0), "l": (0, -1), "r": (0, 1)}

def parse(text):
    lines = text.replace("\r", "").split("\n")
    while lines and lines[0].strip() == "":
        lines.pop(0)
    while lines and lines[-1].strip() == "":
        lines.pop()
    h = len(lines); w = max(len(l) for l in lines)
    walls, goals, boxes, player = set(), set(), [], None
    for y, line in enumerate(lines):
        for x in range(w):
            ch = line[x] if x < len(line) else "#"
            i = (y, x)
            if ch == "#": walls.add(i)
            elif ch == ".": goals.add(i)
            elif ch == "$": boxes.append(i)
            elif ch == "*": boxes.append(i); goals.add(i)
            elif ch == "@": player = i
            elif ch == "+": player = i; goals.add(i)
    return walls, goals, boxes, player

def simulate(walls, goals, boxes, player, moves):
    boxes = set(boxes)
    pushes = 0
    for ch in moves.strip():
        if ch.lower() not in DIRS:
            return False, pushes, "bad char %r" % ch
        dy, dx = DIRS[ch.lower()]
        y, x = player
        n = (y + dy, x + dx)
        if n in walls:
            return False, pushes, "walked into wall"
        if n in boxes:
            b = (n[0] + dy, n[1] + dx)
            if b in walls or b in boxes:
                return False, pushes, "illegal push"
            boxes.discard(n); boxes.add(b)
            pushes += 1
        player = n
    if not all(b in goals for b in boxes):
        return False, pushes, "boxes not all on goals"
    return True, pushes, "ok"

def main():
    inp = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "fixtures" / "practice"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/sok-out-practice")
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    r = subprocess.run(["node", "main.ts"], cwd=ROOT,
                       env={"PATH": "/usr/bin:/bin:/usr/local/bin",
                            "MAKEFUN_INPUT_DIR": str(inp),
                            "MAKEFUN_OUTPUT_DIR": str(out)},
                       capture_output=True, text=True)
    elapsed = time.time() - t0
    print(r.stdout, end="")
    if r.returncode != 0:
        print("main.ts exit", r.returncode); print(r.stderr); sys.exit(1)
    expected = {}
    exp_file = inp / "expected.json"
    if exp_file.exists():
        expected = json.loads(exp_file.read_text())
    total_points = 0
    rows = []
    for level_dir in sorted(inp.iterdir()):
        if not level_dir.is_dir() or not (level_dir / "level.txt").exists():
            continue
        lid = level_dir.name
        walls, goals, boxes, player = parse((level_dir / "level.txt").read_text())
        sol = (out / lid / "solution.txt").read_text().strip() if (out / lid / "solution.txt").exists() else ""
        ok, pushes, msg = simulate(walls, goals, boxes, player, sol) if sol else (False, 0, "empty")
        pstar = expected.get(lid, {}).get("p_star")
        pts = 0
        if ok and pstar:
            pts = 1000 if pushes <= pstar else int(1000 * pstar / pushes)
        total_points += pts
        rows.append((lid, ok, pushes, pstar, pts, len(sol), msg))
        print(f"level {lid}: solved={ok} pushes={pushes} P*={pstar} "
              f"points~{pts} moves={len(sol)} ({msg})")
    n = len(rows)
    print(f"TOTAL: {sum(r[1] for r in rows)}/{n} solved, "
          f"~score {1000 * total_points // max(n, 1)} / 1,000,000, "
          f"wall time {elapsed:.2f}s for {n} levels")
    # determinism: run again to a second dir and diff
    out2 = Path(str(out) + "-2")
    r2 = subprocess.run(["node", "main.ts"], cwd=ROOT,
                        env={"PATH": "/usr/bin:/bin:/usr/local/bin",
                             "MAKEFUN_INPUT_DIR": str(inp),
                             "MAKEFUN_OUTPUT_DIR": str(out2)},
                        capture_output=True, text=True)
    same = True
    for level_dir in sorted(inp.iterdir()):
        if not level_dir.is_dir():
            continue
        a = (out / level_dir.name / "solution.txt").read_bytes() if (out / level_dir.name / "solution.txt").exists() else b""
        b = (out2 / level_dir.name / "solution.txt").read_bytes() if (out2 / level_dir.name / "solution.txt").exists() else b""
        if a != b:
            same = False; print("NON-DETERMINISTIC:", level_dir.name)
    print("determinism (two runs identical):", same)
    if not all(r[1] for r in rows) or not same:
        sys.exit(1)

if __name__ == "__main__":
    main()
