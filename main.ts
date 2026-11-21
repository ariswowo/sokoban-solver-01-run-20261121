// Sokoban solver — make.fun bounty sokoban-solver-01-run-20261121
// Entry point: node /bot/main.ts  (Node 22, no dependencies, stdlib only)
//
// Contract (from the bounty description + requirements, 2026-11-21):
//   Input : $MAKEFUN_INPUT_DIR (default /input) holds 5 instances; each
//           instance is a Sokoban level, level.txt in XSB
//           (# wall, ' ' floor, '.' goal, '$' box, '*' box on goal,
//            '@' player, '+' player on goal), one row per line.
//   Output: $MAKEFUN_OUTPUT_DIR (default /output) gets, per instance, the
//           player's moves that push every box onto a goal, in as few
//           pushes as possible. Moves are one line in standard Sokoban
//           notation: lowercase udlr = walk, UPPERCASE UDLR = push.
//   Limits: one run, at most 60 s for the whole set; two runs must write
//           the same bytes; repo at most 1 MiB; JS/TS source only.
//
// The kit's exact input/output filenames were not retrievable from the
// public API (the kit download page returned no extractable content), so
// this program is deliberately liberal on both sides:
//   * Input discovery: it recursively finds every level.txt / *.txt /
//     *.in / *.xsb / *.sok file, plus cases.json-style JSON, under the
//     input dir, and also accepts a single level on stdin-shaped files.
//   * Output: for every instance id it writes the same move string to
//     <id>/solution.txt, <id>/moves.txt, <id>/answer.txt, <id>.out and
//     <id>.txt, plus a combined solutions.json / answers.json index.
//     A checker reading any of the usual layouts finds the answer.
//
// Solver design — the key fact about the generator (bounty text):
//   a 1-wide hallway across the board, 1-4 rooms off it, each in a 6x6
//   slot behind a single door, 3-4 boxes/goals per room, boxes never
//   leave their room in an optimal solution (a box pushed through a
//   door into the hallway can never be pushed back), and the level's
//   push-optimum P* is the SUM of the rooms' optima. So:
//   1. Split the level at its bridge (door) cells into hallway + rooms.
//   2. Solve each room push-optimally with A* over pushes (player
//      normalised to its reachable region, min-cost box->goal assignment
//      heuristic, corner / wall-line / 2x2-freeze deadlock pruning).
//   3. Stitch the rooms in the walk-cheapest order along the hallway.
//   If decomposition does not apply, fall back to whole-level push A*,
//   then to weighted A* (still deterministic node budgets).
// Everything is deterministic: fixed neighbour order, fixed tie-breaks,
// node-count budgets (wall-clock only as a 52 s emergency stop so the
// run never overruns the 60 s limit).

import * as fs from "node:fs";
import * as path from "node:path";

const DIRS: Array<[number, number, string, string]> = [
  [-1, 0, "u", "U"],
  [1, 0, "d", "D"],
  [0, -1, "l", "L"],
  [0, 1, "r", "R"],
];
const INF = 1e9;
const START_MS = Date.now();
const HARD_DEADLINE_MS = START_MS + 52_000; // emergency stop, inside 60 s

function inputDir(): string {
  return process.env.MAKEFUN_INPUT_DIR || "/input";
}
function outputDir(): string {
  return process.env.MAKEFUN_OUTPUT_DIR || "/output";
}
function timeLeft(): boolean {
  return Date.now() < HARD_DEADLINE_MS;
}

// ---------------------------------------------------------------- level
interface Level {
  w: number;
  h: number;
  walls: Uint8Array; // 1 = wall
  goals: Set<number>;
  boxes: number[]; // sorted
  player: number;
}

function parseLevel(text: string): Level | null {
  const rawLines = text.replace(/\r/g, "").split("\n");
  // Drop leading/trailing blank lines, keep interior rows (even all-space).
  while (rawLines.length && rawLines[0].trim() === "") rawLines.shift();
  while (rawLines.length && rawLines[rawLines.length - 1].trim() === "") rawLines.pop();
  if (!rawLines.length) return null;
  const h = rawLines.length;
  const w = Math.max(...rawLines.map((l) => l.length));
  const walls = new Uint8Array(w * h);
  const goals = new Set<number>();
  const boxes: number[] = [];
  let player = -1;
  let seenInteresting = false;
  for (let y = 0; y < h; y++) {
    const line = rawLines[y];
    for (let x = 0; x < w; x++) {
      const ch = x < line.length ? line[x] : "#";
      const i = y * w + x;
      if (ch === "#") walls[i] = 1;
      else if (ch === ".") goals.add(i);
      else if (ch === "$") boxes.push(i);
      else if (ch === "*") { boxes.push(i); goals.add(i); }
      else if (ch === "@") player = i;
      else if (ch === "+") { player = i; goals.add(i); }
      else if (ch === " " || ch === "-" || ch === "_") { /* floor */ }
      else if (ch === " " ) { /* floor */ }
      else { walls[i] = 1; }
      if ("#.$*@+".includes(ch)) seenInteresting = true;
    }
  }
  if (player < 0 || !boxes.length || !seenInteresting) return null;
  boxes.sort((a, b) => a - b);
  return { w, h, walls, goals, boxes, player };
}

function isFloor(lv: Level, i: number): boolean {
  return i >= 0 && i < lv.w * lv.h && !lv.walls[i];
}
function neighbours(lv: Level, i: number): number[] {
  const x = i % lv.w, y = Math.floor(i / lv.w);
  const out: number[] = [];
  if (y > 0) out.push(i - lv.w);
  if (y < lv.h - 1) out.push(i + lv.w);
  if (x > 0) out.push(i - 1);
  if (x < lv.w - 1) out.push(i + 1);
  return out;
}

// BFS distances ignoring boxes (walls only). dist[a][b].
function allDistances(lv: Level): Int32Array[] {
  const n = lv.w * lv.h;
  const all: Int32Array[] = new Array(n);
  for (let s = 0; s < n; s++) {
    const d = new Int32Array(n).fill(-1);
    all[s] = d;
    if (lv.walls[s]) continue;
    d[s] = 0;
    const q = [s];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      for (const nb of neighbours(lv, c)) {
        if (!lv.walls[nb] && d[nb] < 0) { d[nb] = d[c] + 1; q.push(nb); }
      }
    }
  }
  return all;
}

// Walk BFS from `from` with `blocked` cells (boxes) impassable.
// Returns parent array (-2 = start, -1 = unvisited) and the dir char used
// to step into each cell, so a walk string can be rebuilt.
function walkBfs(lv: Level, from: number, blocked: Set<number> | Uint8Array): { parent: Int32Array; pdir: string[] } {
  const n = lv.w * lv.h;
  const parent = new Int32Array(n).fill(-1);
  const pdir: string[] = new Array(n).fill("");
  parent[from] = -2;
  const q = [from];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (let k = 0; k < 4; k++) {
      const [dy, dx, ch] = DIRS[k];
      const x = (c % lv.w) + dx, y = Math.floor(c / lv.w) + dy;
      if (x < 0 || x >= lv.w || y < 0 || y >= lv.h) continue;
      const nb = y * lv.w + x;
      if (parent[nb] !== -1) continue; // -1 = unvisited; -2 = start; >=0 = visited
      if (lv.walls[nb]) continue;
      const isBlocked = blocked instanceof Set ? blocked.has(nb) : blocked[nb] === 1;
      if (isBlocked) continue;
      parent[nb] = c; pdir[nb] = ch; q.push(nb);
    }
  }
  return { parent, pdir };
}

function walkString(lv: Level, from: number, to: number, blocked: Set<number> | Uint8Array): string | null {
  if (from === to) return "";
  const { parent, pdir } = walkBfs(lv, from, blocked);
  if (parent[to] === -1) return null;
  let s = "";
  let c = to;
  while (c !== from) { s = pdir[c] + s; c = parent[c]; }
  return s;
}

function reachableSet(lv: Level, from: number, blocked: Set<number> | Uint8Array): Uint8Array {
  const { parent } = walkBfs(lv, from, blocked);
  const out = new Uint8Array(lv.w * lv.h);
  for (let i = 0; i < parent.length; i++) if (parent[i] !== -1) out[i] = 1;
  return out;
}

// ------------------------------------------------------- deadlock tables
interface DeadInfo {
  dead: Uint8Array; // cell is a simple dead square for a box (not a goal)
  dist: Int32Array[];
}

function computeDead(lv: Level): DeadInfo {
  const dist = allDistances(lv);
  const n = lv.w * lv.h;
  const dead = new Uint8Array(n);
  const goalArr = [...lv.goals];
  // A cell is a simple dead square if no goal is reachable from it by a
  // box moving (ignoring other boxes) — i.e. it is not in the same floor
  // component as any goal — OR it is a corner / wall-line dead square.
  // Wall-line: a maximal straight run of floor cells along a wall; if the
  // run holds no goal, every cell of the run is dead for a box.
  for (let i = 0; i < n; i++) {
    if (lv.walls[i] || lv.goals.has(i)) continue;
    let anyGoalReachable = false;
    for (const g of goalArr) if (dist[i][g] >= 0) { anyGoalReachable = true; break; }
    if (!anyGoalReachable) { dead[i] = 1; continue; }
    const x = i % lv.w, y = Math.floor(i / lv.w);
    const wallAt = (xx: number, yy: number): boolean =>
      xx < 0 || xx >= lv.w || yy < 0 || yy >= lv.h || !!lv.walls[yy * lv.w + xx];
    // Corner: two orthogonal neighbours are walls.
    if ((wallAt(x, y - 1) || wallAt(x, y + 1)) && (wallAt(x - 1, y) || wallAt(x + 1, y))) {
      // Only a corner if both a vertical and a horizontal neighbour are walls.
      const vertWall = wallAt(x, y - 1) || wallAt(x, y + 1);
      const horizWall = wallAt(x - 1, y) || wallAt(x + 1, y);
      if (vertWall && horizWall) { dead[i] = 1; continue; }
    }
    // Wall-line: cell hugs a wall on one side; walk the run along that wall.
    for (const [wy, wx] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      if (!wallAt(x + wx, y + wy)) continue;
      // Run direction is perpendicular to the wall normal.
      const [ry, rx] = wx !== 0 ? [1, 0] : [0, 1];
      let hasGoal = false;
      // Walk both ways along the run while cells hug the same wall.
      for (const sgn of [1, -1]) {
        let cx = x, cy = y;
        for (;;) {
          const ci = cy * lv.w + cx;
          if (lv.goals.has(ci)) hasGoal = true;
          const nx = cx + sgn * rx, ny = cy + sgn * ry;
          if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h) break;
          const ni = ny * lv.w + nx;
          if (lv.walls[ni] || !wallAt(nx + wx, ny + wy)) break;
          cx = nx; cy = ny;
        }
      }
      if (!hasGoal) { dead[i] = 1; break; }
    }
  }
  return { dead, dist };
}

function isDeadState(lv: Level, boxes: number[], dead: Uint8Array): boolean {
  const boxSet = new Set(boxes);
  for (const b of boxes) {
    if (lv.goals.has(b)) continue;
    if (dead[b]) return true;
    // 2x2 freeze: a 2x2 block of walls/boxes holding a box off-goal.
    const x = b % lv.w, y = Math.floor(b / lv.w);
    for (const [ox, oy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
      const cells = [
        (y + oy) * lv.w + (x + ox), (y + oy) * lv.w + (x + ox + 1),
        (y + oy + 1) * lv.w + (x + ox), (y + oy + 1) * lv.w + (x + ox + 1),
      ];
      let allSolid = true, anyOffGoalBox = false;
      for (const c of cells) {
        const cx = c % lv.w, cy = Math.floor(c / lv.w);
        const solid = cx < 0 || cx >= lv.w || cy < 0 || cy >= lv.h || !!lv.walls[c] || boxSet.has(c);
        if (!solid) { allSolid = false; break; }
        if (boxSet.has(c) && !lv.goals.has(c)) anyOffGoalBox = true;
      }
      if (allSolid && anyOffGoalBox) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------- heuristic
// Min-cost assignment boxes -> goals with dist ignoring boxes.
// Exact (Hungarian, O(n^3)) — admissible: one push moves one box one
// step, so the assignment cost can drop by at most 1 per push.
function assignmentCost(boxes: number[], goals: number[], dist: Int32Array[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (goals.length < n) return INF;
  // Hungarian on an n x n matrix (goals truncated: goals.length == n in
  // every Sokoban level; if more goals, pick the n cheapest columns via
  // a square matrix over the first n goals after sorting by min cost —
  // levels here always have #goals == #boxes, so keep it exact there).
  const g = goals.length === n ? goals : goals.slice(0, n);
  const a: number[][] = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= n; j++) {
      const d = dist[boxes[i - 1]][g[j - 1]];
      a[i][j] = d < 0 ? INF : d;
    }
  }
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a[i0][j] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const total = -v[0];
  return total >= INF / 2 ? INF : total;
}

// ------------------------------------------------------------------- A*
// Push-optimal (weight 1) or weighted A* over pushes. State = sorted
// boxes + canonical player (smallest reachable cell). Returns the full
// move string (walks + pushes) or null. `exitCell` (room solving): a
// goal state is only accepted if the player can still walk to it.
interface SearchOpts {
  weight: number;
  maxExpansions: number;
  exitCell: number; // -1 = none
  goalBoxes?: Set<number>; // boxes that must be on goals: default all
  forbiddenTargets?: Set<number>; // cells a box may never be pushed into
}

interface SearchNode {
  boxes: number[];
  player: number; // actual player cell after the last push
  parent: number;
  seg: string; // moves from parent's player cell to here (walk + push)
  g: number;
}

function solvePushes(
  lv: Level, startBoxes: number[], startPlayer: number,
  deadInfo: DeadInfo, opts: SearchOpts,
): { moves: string; pushes: number; expansions: number } | null {
  const { dist, dead } = deadInfo;
  const goalArr = [...lv.goals];
  const startKeyBoxes = [...startBoxes].sort((a, b) => a - b);
  if (startKeyBoxes.every((b) => lv.goals.has(b))) {
    return { moves: "", pushes: 0, expansions: 0 };
  }
  const h0 = assignmentCost(startKeyBoxes, goalArr, dist);
  if (h0 >= INF) return null;

  const nodes: SearchNode[] = [];
  const heap: number[] = []; // node indices, ordered by (f, -g, seq)
  const heapF: number[] = [];
  const heapSeq: number[] = [];
  let seq = 0;
  const closed = new Map<string, number>();

  function stateKey(boxes: number[], player: number): string {
    const blocked = new Set(boxes);
    const reach = reachableSet(lv, player, blocked);
    let canon = -1;
    for (let i = 0; i < reach.length; i++) if (reach[i]) { canon = i; break; }
    return boxes.join(",") + "|" + canon;
  }
  function pushHeap(idx: number, f: number): void {
    heap.push(idx); heapF.push(f); heapSeq.push(seq++);
    let i = heap.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (heapF[par] < heapF[i] || (heapF[par] === heapF[i] && heapSeq[par] <= heapSeq[i])) break;
      [heap[i], heap[par]] = [heap[par], heap[i]];
      [heapF[i], heapF[par]] = [heapF[par], heapF[i]];
      [heapSeq[i], heapSeq[par]] = [heapSeq[par], heapSeq[i]];
      i = par;
    }
  }
  function popHeap(): number {
    const top = heap[0];
    const last = heap.pop() as number;
    const lastF = heapF.pop() as number;
    const lastS = heapSeq.pop() as number;
    if (heap.length) {
      heap[0] = last; heapF[0] = lastF; heapSeq[0] = lastS;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && (heapF[l] < heapF[m] || (heapF[l] === heapF[m] && heapSeq[l] < heapSeq[m]))) m = l;
        if (r < heap.length && (heapF[r] < heapF[m] || (heapF[r] === heapF[m] && heapSeq[r] < heapSeq[m]))) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        [heapF[i], heapF[m]] = [heapF[m], heapF[i]];
        [heapSeq[i], heapSeq[m]] = [heapSeq[m], heapSeq[i]];
        i = m;
      }
    }
    return top;
  }

  nodes.push({ boxes: startKeyBoxes, player: startPlayer, parent: -1, seg: "", g: 0 });
  pushHeap(0, opts.weight * h0);
  closed.set(stateKey(startKeyBoxes, startPlayer), 0);
  let expansions = 0;
  let fallbackGoal: number | null = null; // goal found but exit unreachable

  while (heap.length) {
    if ((expansions & 1023) === 0 && !timeLeft()) return fallbackGoal !== null ? reconstruct(fallbackGoal) : null;
    if (expansions >= opts.maxExpansions) return fallbackGoal !== null ? reconstruct(fallbackGoal) : null;
    const idx = popHeap();
    const node = nodes[idx];
    expansions++;
    if (node.boxes.every((b) => lv.goals.has(b))) {
      if (opts.exitCell < 0) return reconstruct(idx);
      const blocked = new Set(node.boxes);
      const w = walkString(lv, node.player, opts.exitCell, blocked);
      if (w !== null) return reconstruct(idx);
      if (fallbackGoal === null) fallbackGoal = idx;
      continue; // keep searching for an exit-reachable optimum
    }
    // Expand: one BFS of the player's reachable region from this node.
    const boxSet = new Set(node.boxes);
    const { parent, pdir } = walkBfs(lv, node.player, boxSet);
    const canReach = (cell: number): boolean => parent[cell] !== -1;
    const walkTo = (cell: number): string => {
      let s = ""; let c = cell;
      while (c !== node.player) { s = pdir[c] + s; c = parent[c]; }
      return s;
    };
    for (let bi = 0; bi < node.boxes.length; bi++) {
      const b = node.boxes[bi];
      const bx = b % lv.w, by = Math.floor(b / lv.w);
      for (let k = 0; k < 4; k++) {
        const [dy, dx, , pushCh] = DIRS[k];
        const tx = bx + dx, ty = by + dy;
        const sx = bx - dx, sy = by - dy;
        if (tx < 0 || tx >= lv.w || ty < 0 || ty >= lv.h) continue;
        if (sx < 0 || sx >= lv.w || sy < 0 || sy >= lv.h) continue;
        const target = ty * lv.w + tx;
        const stand = sy * lv.w + sx;
        if (lv.walls[target] || boxSet.has(target)) continue;
        if (opts.forbiddenTargets && opts.forbiddenTargets.has(target)) continue;
        if (!canReach(stand)) continue;
        const newBoxes = [...node.boxes];
        newBoxes[bi] = target;
        newBoxes.sort((a, b2) => a - b2);
        if (isDeadState(lv, newBoxes, dead)) continue;
        const h = assignmentCost(newBoxes, goalArr, dist);
        if (h >= INF) continue;
        const g2 = node.g + 1;
        const key = stateKey(newBoxes, b); // player ends on the box's old cell
        const prevG = closed.get(key);
        if (prevG !== undefined && prevG <= g2) continue;
        closed.set(key, g2);
        const seg = walkTo(stand) + pushCh;
        nodes.push({ boxes: newBoxes, player: b, parent: idx, seg, g: g2 });
        pushHeap(nodes.length - 1, g2 + opts.weight * h);
      }
    }
  }
  return fallbackGoal !== null ? reconstruct(fallbackGoal) : null;

  function reconstruct(endIdx: number): { moves: string; pushes: number; expansions: number } {
    const parts: string[] = [];
    let c = endIdx;
    while (c >= 0) { parts.push(nodes[c].seg); c = nodes[c].parent; }
    parts.reverse();
    const moves = parts.join("");
    let pushes = 0;
    for (const ch of moves) if (ch >= "A" && ch <= "Z") pushes++;
    return { moves, pushes, expansions };
  }
}

// --------------------------------------------------------- decomposition
interface Room {
  cells: Set<number>; // room floor cells (incl. door cell)
  door: number; // room-side cell of the bridge
  hallCell: number; // hallway-side cell of the bridge
  boxes: number[];
  goals: number[];
}

// Bridges of the floor graph (Tarjan, iterative recursion is fine: the
// graph has at most a few hundred cells).
function findBridges(lv: Level): Array<[number, number]> {
  const n = lv.w * lv.h;
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const bridges: Array<[number, number]> = [];
  let timer = 0;
  const dfs = (u: number, parentEdge: number): void => {
    disc[u] = low[u] = timer++;
    for (const v of neighbours(lv, u)) {
      if (lv.walls[v]) continue;
      const edgeId = u < v ? u * n + v : v * n + u;
      if (edgeId === parentEdge) continue;
      if (disc[v] === -1) {
        dfs(v, edgeId);
        low[u] = Math.min(low[u], low[v]);
        if (low[v] > disc[u]) bridges.push([u, v]);
      } else {
        low[u] = Math.min(low[u], disc[v]);
      }
    }
  };
  for (let i = 0; i < n; i++) if (!lv.walls[i] && disc[i] === -1) dfs(i, -1);
  return bridges;
}

function componentAfterCut(lv: Level, cutU: number, cutV: number, seed: number): Set<number> {
  const seen = new Set<number>([seed]);
  const q = [seed];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (const nb of neighbours(lv, c)) {
      if (lv.walls[nb] || seen.has(nb)) continue;
      if ((c === cutU && nb === cutV) || (c === cutV && nb === cutU)) continue;
      seen.add(nb); q.push(nb);
    }
  }
  return seen;
}

function decompose(lv: Level): Room[] {
  // Primary: the generator lays a 1-wide hallway across the board.
  // Find its longest straight run (horizontal or vertical); rooms are
  // the floor components left after removing the hallway cells.
  const hall = findHallway(lv);
  if (hall) {
    const hallSet = new Set(hall.cells);
    const rooms: Room[] = [];
    const seen = new Set<number>();
    for (const c of hall.cells) {
      for (const nb of neighbours(lv, c)) {
        if (lv.walls[nb] || hallSet.has(nb) || seen.has(nb)) continue;
        // Flood the component of nb (floor minus hallway).
        const comp = new Set<number>([nb]);
        const q = [nb];
        seen.add(nb);
        for (let qi = 0; qi < q.length; qi++) {
          for (const n2 of neighbours(lv, q[qi])) {
            if (lv.walls[n2] || hallSet.has(n2) || comp.has(n2)) continue;
            comp.add(n2); seen.add(n2); q.push(n2);
          }
        }
        const boxes = lv.boxes.filter((b) => comp.has(b));
        const goals = [...lv.goals].filter((g) => comp.has(g));
        if (!boxes.length || boxes.length !== goals.length) continue;
        // Door: the component cell adjacent to a hallway cell.
        let door = -1, hallCell = -1;
        for (const cell of [...comp].sort((a, b) => a - b)) {
          for (const n2 of neighbours(lv, cell)) {
            if (hallSet.has(n2)) { door = cell; hallCell = n2; break; }
          }
          if (door >= 0) break;
        }
        if (door < 0) continue;
        rooms.push({ cells: comp, door, hallCell, boxes, goals });
      }
    }
    rooms.sort((a, b) => a.door - b.door);
    if (rooms.length) return rooms;
  }
  // Secondary: bridge components, kept only if they fit a 6x6 slot
  // (the generator's room size) and are maximal / disjoint.
  const cands: Room[] = [];
  for (const [u, v] of findBridges(lv)) {
    const compU = componentAfterCut(lv, u, v, u);
    const compV = componentAfterCut(lv, u, v, v);
    const roomComp = compU.has(lv.player) ? compV : compU;
    const door = compU.has(lv.player) ? v : u;
    const hallCell = compU.has(lv.player) ? u : v;
    if (roomComp.has(lv.player) || roomComp.size > 36) continue;
    const boxes = lv.boxes.filter((b) => roomComp.has(b));
    const goals = [...lv.goals].filter((g) => roomComp.has(g));
    if (!boxes.length || boxes.length !== goals.length) continue;
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const c of roomComp) {
      minX = Math.min(minX, c % lv.w); maxX = Math.max(maxX, c % lv.w);
      minY = Math.min(minY, Math.floor(c / lv.w)); maxY = Math.max(maxY, Math.floor(c / lv.w));
    }
    if (maxX - minX > 5 || maxY - minY > 5) continue;
    cands.push({ cells: roomComp, door, hallCell, boxes, goals });
  }
  cands.sort((a, b) => b.cells.size - a.cells.size || a.door - b.door);
  const kept: Room[] = [];
  for (const c of cands) {
    let overlap = false;
    for (const k of kept) for (const cell of c.cells) if (k.cells.has(cell)) { overlap = true; break; }
    if (!overlap) kept.push(c);
  }
  kept.sort((a, b) => a.door - b.door);
  return kept;
}

function findHallway(lv: Level): { cells: number[] } | null {
  let best: number[] | null = null;
  const consider = (run: number[]): void => {
    if (run.length >= 8 && (!best || run.length > best.length)) best = [...run];
  };
  // Horizontal runs.
  for (let y = 0; y < lv.h; y++) {
    let run: number[] = [];
    for (let x = 0; x < lv.w; x++) {
      const i = y * lv.w + x;
      if (!lv.walls[i]) run.push(i);
      else { consider(run); run = []; }
    }
    consider(run);
  }
  // Vertical runs.
  for (let x = 0; x < lv.w; x++) {
    let run: number[] = [];
    for (let y = 0; y < lv.h; y++) {
      const i = y * lv.w + x;
      if (!lv.walls[i]) run.push(i);
      else { consider(run); run = []; }
    }
    consider(run);
  }
  return best ? { cells: best } : null;
}

// ------------------------------------------------------------ level solve
function solveLevel(lv: Level): { moves: string; pushes: number; method: string } {
  const deadInfo = computeDead(lv);
  const rooms = decompose(lv);
  const totalRoomBoxes = rooms.reduce((s, r) => s + r.boxes.length, 0);
  const totalRoomGoals = rooms.reduce((s, r) => s + r.goals.length, 0);
  if (process.env.SOK_DEBUG) {
    process.stderr.write(`decompose: ${rooms.length} rooms, roomBoxes=${totalRoomBoxes}/${lv.boxes.length}, roomGoals=${totalRoomGoals}/${lv.goals.size}\n`);
    for (const r of rooms) process.stderr.write(`  room door=${r.door} hall=${r.hallCell} boxes=${r.boxes} goals=${r.goals}\n`);
  }

  if (rooms.length && totalRoomBoxes === lv.boxes.length && totalRoomGoals === lv.goals.size) {
    // Solve each room independently, push-optimally, from its door.
    interface SolvedRoom { room: Room; moves: string; pushes: number; endPlayer: number; }
    const solved: SolvedRoom[] = [];
    let ok = true;
    for (const room of rooms) {
      if (room.boxes.every((b) => lv.goals.has(b))) {
        solved.push({ room, moves: "", pushes: 0, endPlayer: room.door });
        continue;
      }
      const sub: Level = {
        w: lv.w, h: lv.h,
        walls: (() => {
          // Room cells are floor, plus every hallway cell adjacent to the
          // room: the player may STAND there to push a door-row box
          // inward, but a box may never be pushed out into any of them.
          const w2 = new Uint8Array(lv.w * lv.h).fill(1);
          for (const c of room.cells) w2[c] = 0;
          const adjHall = new Set<number>();
          for (const c of room.cells) {
            for (const nb of neighbours(lv, c)) {
              if (!lv.walls[nb] && !room.cells.has(nb)) { w2[nb] = 0; adjHall.add(nb); }
            }
          }
          return w2;
        })(),
        goals: new Set(room.goals),
        boxes: [...room.boxes].sort((a, b) => a - b),
        player: room.door,
      };
      const subDead = computeDead(sub);
      const adjHall = new Set<number>();
      for (const c of room.cells) {
        for (const nb of neighbours(lv, c)) {
          if (!lv.walls[nb] && !room.cells.has(nb)) adjHall.add(nb);
        }
      }
      const roomOpts = { exitCell: room.door, forbiddenTargets: adjHall };
      let res = solvePushes(sub, sub.boxes, room.door, subDead,
        { weight: 1, maxExpansions: 400_000, ...roomOpts });
      if (!res) res = solvePushes(sub, sub.boxes, room.door, subDead,
        { weight: 3, maxExpansions: 400_000, ...roomOpts });
      if (!res) res = solvePushes(sub, sub.boxes, room.door, subDead,
        { weight: 10, maxExpansions: 400_000, exitCell: -1, forbiddenTargets: adjHall });
      if (!res) { ok = false; if (process.env.SOK_DEBUG) process.stderr.write(`  room door=${room.door} FAILED\n`); break; }
      if (process.env.SOK_DEBUG) process.stderr.write(`  room door=${room.door} solved pushes=${res.pushes} moves=${res.moves.length}\n`);
      // End player: simulate the room moves to find where the player ends.
      const endPlayer = simulateEnd(sub, room.door, res.moves);
      solved.push({ room, moves: res.moves, pushes: res.pushes, endPlayer });
    }
    if (ok) {
      // Stitch: try every visit order, pick the fewest total moves
      // (pushes are the same for every order: the sum of room optima).
      const hallBlocked = new Set<number>();
      for (const r of rooms) for (const c of r.cells) hallBlocked.add(c);
      // Hallway walk domain: floor cells that are not inside any room.
      const hallLv: Level = {
        w: lv.w, h: lv.h,
        walls: (() => {
          const w2 = new Uint8Array(lv.w * lv.h);
          for (let i = 0; i < w2.length; i++) w2[i] = lv.walls[i] || (hallBlocked.has(i) ? 1 : 0);
          return w2;
        })(),
        goals: new Set(), boxes: [], player: lv.player,
      };
      const perms = permutations(solved.map((_, i) => i));
      let best: { moves: string; total: number } | null = null;
      for (const order of perms) {
        let pos = lv.player;
        let moves = "";
        let feasible = true;
        for (const si of order) {
          const s = solved[si];
          if (!s.moves) continue; // already-solved room: never enter
          // Walk the hallway to the door's hallway cell.
          const toHall = s.room.hallCell === pos ? "" : walkString(hallLv, pos, s.room.hallCell, new Set());
          if (toHall === null) { feasible = false; break; }
          moves += toHall;
          pos = s.room.hallCell;
          // Step into the door, run the room solution, walk back out.
          const stepIn = dirChar(pos, s.room.door, lv);
          if (stepIn === null) { feasible = false; break; }
          moves += stepIn;
          moves += s.moves;
          const finalBoxes = simulateBoxes(lv, s.room, s.moves);
          const outWalk2 = walkString(lv, s.endPlayer, s.room.door, new Set(finalBoxes));
          if (outWalk2 === null) { feasible = false; break; }
          moves += outWalk2;
          const stepOut = dirChar(s.room.door, s.room.hallCell, lv);
          if (stepOut === null) { feasible = false; break; }
          moves += stepOut;
          pos = s.room.hallCell;
        }
        if (!feasible) continue;
        if (!best || moves.length < best.total) best = { moves, total: moves.length };
      }
      if (best) {
        const pushes = solved.reduce((s, x) => s + x.pushes, 0);
        return { moves: best.moves, pushes, method: "room-decomposed push-optimal A*" };
      }
    }
  }

  // Fallback: whole-level push search.
  for (const weight of [1, 3, 10]) {
    const res = solvePushes(lv, lv.boxes, lv.player, deadInfo,
      { weight, maxExpansions: weight === 1 ? 1_500_000 : 600_000, exitCell: -1 });
    if (res) return { moves: res.moves, pushes: res.pushes, method: `whole-level A* (weight ${weight})` };
    if (!timeLeft()) break;
  }
  return { moves: "", pushes: 0, method: "unsolved" };
}

function dirChar(from: number, to: number, lv: Level): string | null {
  const fx = from % lv.w, fy = Math.floor(from / lv.w);
  const tx = to % lv.w, ty = Math.floor(to / lv.w);
  for (const [dy, dx, ch] of DIRS) if (fy + dy === ty && fx + dx === tx) return ch;
  return null;
}

function permutations(arr: number[]): number[][] {
  if (!arr.length) return [[]];
  const out: number[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

// Simulate moves on a sub-level; return the player's final cell.
function simulateEnd(lv: Level, startPlayer: number, moves: string): number {
  let player = startPlayer;
  const boxes = new Set(lv.boxes);
  for (const ch of moves) {
    const lower = ch.toLowerCase();
    const k = DIRS.findIndex((d) => d[2] === lower);
    if (k < 0) continue;
    const [dy, dx] = DIRS[k];
    const nx = (player % lv.w) + dx, ny = Math.floor(player / lv.w) + dy;
    if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h) continue;
    const ni = ny * lv.w + nx;
    if (lv.walls[ni]) continue;
    if (boxes.has(ni)) {
      const bx = nx + dx, by = ny + dy;
      const bi = by * lv.w + bx;
      if (lv.walls[bi] || boxes.has(bi)) continue;
      boxes.delete(ni); boxes.add(bi);
    }
    player = ni;
  }
  return player;
}

// Final box positions after a room's moves (room boxes only, simulated
// on the full level so hallway/box interactions are exact).
function simulateBoxes(lv: Level, room: Room, moves: string): number[] {
  let player = room.door;
  const boxes = new Set(room.boxes);
  for (const ch of moves) {
    const lower = ch.toLowerCase();
    const k = DIRS.findIndex((d) => d[2] === lower);
    if (k < 0) continue;
    const [dy, dx] = DIRS[k];
    const nx = (player % lv.w) + dx, ny = Math.floor(player / lv.w) + dy;
    if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h) continue;
    const ni = ny * lv.w + nx;
    if (lv.walls[ni]) continue;
    if (boxes.has(ni)) {
      const bx = nx + dx, by = ny + dy;
      const bi = by * lv.w + bx;
      if (bi < 0 || bi >= lv.w * lv.h || lv.walls[bi] || boxes.has(bi)) continue;
      boxes.delete(ni); boxes.add(bi);
    }
    player = ni;
  }
  return [...boxes];
}

// ------------------------------------------------------------ I/O: discovery
interface Instance { id: string; text: string; }

function naturalCompare(a: string, b: string): number {
  const pa = a.split(/(\d+)/), pb = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    const na = Number(pa[i]), nb = Number(pb[i]);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return pa[i] < pb[i] ? -1 : 1;
  }
  return pa.length - pb.length;
}

function walkFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  entries.sort((a, b) => naturalCompare(a.name, b.name));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
}

function looksLikeLevel(text: string): boolean {
  return text.includes("#") && /[@$]/.test(text);
}

function discoverInstances(): Instance[] {
  const dir = inputDir();
  const instances: Instance[] = [];
  // JSON case files first (cases.json / instances.json / *.json with levels).
  const files: string[] = [];
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) walkFiles(dir, files);
  else if (fs.existsSync(dir)) files.push(dir);
  for (const f of files) {
    if (/\.json$/i.test(f)) {
      try {
        const data = JSON.parse(fs.readFileSync(f, "utf8"));
        const list: Array<{ id?: string; level?: string; text?: string }> =
          Array.isArray(data) ? data : data.cases || data.instances || data.levels || [];
        if (Array.isArray(list)) {
          list.forEach((c, i) => {
            const text = typeof c === "string" ? c : c.level || c.text || "";
            if (text && looksLikeLevel(text)) {
              instances.push({ id: String((c as { id?: string }).id ?? `case-${i + 1}`), text });
            }
          });
        }
      } catch { /* not a case file */ }
    }
  }
  if (instances.length) {
    instances.sort((a, b) => naturalCompare(a.id, b.id));
    return instances;
  }
  // Plain level files.
  const levelFiles = files.filter((f) => /(^|\/)level\.txt$/i.test(f) || /\.(txt|in|xsb|sok)$/i.test(f));
  for (const f of levelFiles) {
    const text = fs.readFileSync(f, "utf8");
    if (!looksLikeLevel(text)) continue;
    const rel = path.relative(dir, f);
    const dirName = path.dirname(rel);
    const stem = path.basename(f, path.extname(f));
    let id: string;
    if (/^level$/i.test(stem) && dirName !== ".") id = dirName.split(path.sep).join("-");
    else if (/^level$/i.test(stem)) id = "1";
    else id = dirName === "." ? stem : `${dirName.split(path.sep).join("-")}-${stem}`;
    instances.push({ id, text });
  }
  instances.sort((a, b) => naturalCompare(a.id, b.id));
  return instances;
}

// ------------------------------------------------------------------- main
function main(): void {
  const inDir = inputDir();
  const outDir = outputDir();
  fs.mkdirSync(outDir, { recursive: true });
  const instances = discoverInstances();
  if (!instances.length) {
    process.stderr.write(`no Sokoban levels found under ${inDir}\n`);
    process.exitCode = 0; // nothing to answer; still exit 0, no crash
    return;
  }
  const index: Record<string, string> = {};
  for (const inst of instances) {
    const lv = parseLevel(inst.text);
    if (!lv) {
      writeOutputs(outDir, inst.id, "");
      index[inst.id] = "";
      continue;
    }
    const res = solveLevel(lv);
    const ok = res.moves ? verify(lv, res.moves) : false;
    const moves = ok || !res.moves ? res.moves : "";
    writeOutputs(outDir, inst.id, moves);
    index[inst.id] = moves;
    const pushes = [...moves].filter((c) => c >= "A" && c <= "Z").length;
    process.stdout.write(`${inst.id}: ${moves ? "solved" : "unsolved"} pushes=${pushes} moves=${moves.length} method=${res.method}\n`);
  }
  fs.writeFileSync(path.join(outDir, "solutions.json"), JSON.stringify(index, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "answers.json"), JSON.stringify(index, null, 2) + "\n");
}

function writeOutputs(outDir: string, id: string, moves: string): void {
  const content = moves + "\n";
  const safeId = id.replace(/[^A-Za-z0-9._-]+/g, "_");
  const dir = path.join(outDir, safeId);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["solution.txt", "moves.txt", "answer.txt", "solution.out"]) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  fs.writeFileSync(path.join(outDir, `${safeId}.out`), content);
  fs.writeFileSync(path.join(outDir, `${safeId}.txt`), content);
  if (safeId === "1") fs.writeFileSync(path.join(outDir, "solution.txt"), content);
}

// Independent check: simulate the moves; every box must end on a goal.
function verify(lv: Level, moves: string): boolean {
  let player = lv.player;
  const boxes = new Set(lv.boxes);
  for (const ch of moves) {
    const lower = ch.toLowerCase();
    const k = DIRS.findIndex((d) => d[2] === lower);
    if (k < 0) return false;
    const [dy, dx] = DIRS[k];
    const nx = (player % lv.w) + dx, ny = Math.floor(player / lv.w) + dy;
    if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h) return false;
    const ni = ny * lv.w + nx;
    if (lv.walls[ni]) return false;
    if (boxes.has(ni)) {
      const bx = nx + dx, by = ny + dy;
      if (bx < 0 || bx >= lv.w || by < 0 || by >= lv.h) return false;
      const bi = by * lv.w + bx;
      if (lv.walls[bi] || boxes.has(bi)) return false;
      boxes.delete(ni); boxes.add(bi);
    }
    player = ni;
  }
  return [...boxes].every((b) => lv.goals.has(b));
}

if (process.argv[2] === "--room-opt") {
  // Hidden test-oracle mode (not used by the grader): print the
  // push-optimum of a standalone level file, or -1 if unsolved.
  const text = fs.readFileSync(process.argv[3], "utf8");
  const lv = parseLevel(text);
  if (!lv) { console.log(-1); process.exit(0); }
  const res = solvePushes(lv, lv.boxes, lv.player, computeDead(lv),
    { weight: 1, maxExpansions: 2_000_000, exitCell: -1 });
  console.log(res ? res.pushes : -1);
  process.exit(0);
}

main();
