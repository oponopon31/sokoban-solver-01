// Push-optimal Sokoban solver.
//
// The generated levels are a one-cell-wide hallway with 1-4 small rooms off
// it, each room holding 3-4 boxes and as many goals behind a single door. A
// box pushed into the hallway can never be pushed back, so every box stays in
// its room and the level optimum is the sum of the rooms' optima. Each room is
// therefore solved on its own with a push-based breadth-first search (uniform
// cost over pushes, so the first solved state found is push-optimal), with
// dead-square pruning from a reverse-pull analysis and frozen 2x2 pruning.
// The per-room push sequences are then stitched together with player walks
// through the hallway. If a room ever defeats the search, the whole level is
// retried with one push-BFS as a fallback; if that also fails the level is
// left empty so the other instances still score.
//
// Everything is budgeted by work (state counts), never by the clock, and every
// order is fixed, so two runs write identical bytes. The program reads no
// clock, no environment beyond the two directory variables, and no files
// outside /input and /output (plus /bot for its own source).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed direction order: up, down, left, right.
const DIRS = [
  { ch: 'u', dr: -1, dc: 0 },
  { ch: 'd', dr: 1, dc: 0 },
  { ch: 'l', dr: 0, dc: -1 },
  { ch: 'r', dr: 0, dc: 1 },
];

const ROOM_STATE_CAP = 250000;
const WHOLE_STATE_CAP = 500000;

// ---------------------------------------------------------------- parsing

function parseLevel(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const H = lines.length;
  let W = 0;
  for (const line of lines) if (line.length > W) W = line.length;
  const wall = new Uint8Array(W * H).fill(1);
  const goals = new Set();
  const boxes = [];
  let player = -1;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const ch = c < lines[r].length ? lines[r][c] : '#';
      const cell = r * W + c;
      if (ch === '#') continue;
      wall[cell] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.add(cell);
      if (ch === '$' || ch === '*') boxes.push(cell);
      if (ch === '@' || ch === '+') player = cell;
    }
  }
  return { W, H, wall, goals, boxes, player };
}

// ---------------------------------------------------------------- helpers

function maskOf(W, H, cells) {
  const m = new Uint8Array(W * H);
  for (const cell of cells) m[cell] = 1;
  return m;
}

// Flood fill from `from` over walkable cells that are not blocked. Returns the
// reached set and the lowest reached cell that is in keyMask (-1 if none).
function flood(W, H, walkable, blocked, keyMask, from) {
  const seen = new Uint8Array(W * H);
  const stack = [from];
  seen[from] = 1;
  let minKey = keyMask[from] ? from : -1;
  for (let i = 0; i < stack.length; i++) {
    const cur = stack[i];
    const r = Math.floor(cur / W);
    const c = cur % W;
    for (let d = 0; d < 4; d++) {
      const nr = r + DIRS[d].dr;
      const nc = c + DIRS[d].dc;
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const n = nr * W + nc;
      if (!walkable[n] || blocked[n] || seen[n]) continue;
      seen[n] = 1;
      if (keyMask[n] && (minKey === -1 || n < minKey)) minKey = n;
      stack.push(n);
    }
  }
  return { seen, minKey };
}

// Shortest player walk (no pushes) from `from` to `to` over walkable cells
// that are not blocked; returns the move string or null.
function walkPath(W, H, wall, walkable, blocked, from, to) {
  if (from === to) return '';
  if (!walkable[to] || blocked[to]) return null;
  const prev = new Int32Array(W * H).fill(-1);
  const prevDir = new Int8Array(W * H).fill(-1);
  const queue = [from];
  prev[from] = from;
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    const r = Math.floor(cur / W);
    const c = cur % W;
    for (let d = 0; d < 4; d++) {
      const nr = r + DIRS[d].dr;
      const nc = c + DIRS[d].dc;
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const n = nr * W + nc;
      if (!walkable[n] || blocked[n] || prev[n] !== -1) continue;
      prev[n] = cur;
      prevDir[n] = d;
      if (n === to) {
        let s = '';
        let x = n;
        while (x !== from) {
          s = DIRS[prevDir[x]].ch + s;
          x = prev[x];
        }
        return s;
      }
      queue.push(n);
    }
  }
  return null;
}

// ---------------------------------------------------------------- dead squares
//
// A cell is live when a box on it can still be pushed onto a goal. Computed by
// reverse reachability from the goals: a cell n is live when some adjacent
// live cell c can be reached from n by one reverse move, i.e. the cell on the
// far side of n from c (2n - c) is open floor for the player to stand on while
// pulling. (Equivalently: the forward push n -> c needs the player at 2n - c.)
// Cells never reached are dead; any box on one prunes its state.

function computeLive(W, H, wall, goals) {
  const live = new Uint8Array(W * H);
  const queue = [];
  for (const g of goals) {
    if (!live[g]) {
      live[g] = 1;
      queue.push(g);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    const cr = Math.floor(c / W);
    const cc = c % W;
    for (let d = 0; d < 4; d++) {
      const nr = cr - DIRS[d].dr;
      const nc = cc - DIRS[d].dc;
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const n = nr * W + nc;
      if (wall[n] || live[n]) continue;
      const ar = nr - DIRS[d].dr;
      const ac = nc - DIRS[d].dc;
      if (ar < 0 || ar >= H || ac < 0 || ac >= W) continue;
      if (wall[ar * W + ac]) continue;
      live[n] = 1;
      queue.push(n);
    }
  }
  return live;
}

// True when some 2x2 block of walls/boxes containing `cell` holds a box that
// is not on a goal: those boxes can never move again.
function isFrozen2x2(W, H, wall, boxSet, goalSet, cell) {
  const r = Math.floor(cell / W);
  const c = cell % W;
  const tops = [
    [r - 1, c - 1],
    [r - 1, c],
    [r, c - 1],
    [r, c],
  ];
  for (const top of tops) {
    const br = top[0];
    const bc = top[1];
    if (br < 0 || bc < 0 || br + 1 >= H || bc + 1 >= W) continue;
    let allFilled = true;
    let hasOffGoalBox = false;
    for (let k = 0; k < 4; k++) {
      const rr = br + (k >= 2 ? 1 : 0);
      const cc = bc + (k % 2);
      const q = rr * W + cc;
      if (wall[q]) continue;
      if (boxSet.has(q)) {
        if (!goalSet.has(q)) hasOffGoalBox = true;
        continue;
      }
      allFilled = false;
      break;
    }
    if (allFilled && hasOffGoalBox) return true;
  }
  return false;
}

// ---------------------------------------------------------------- push BFS
//
// Breadth-first search over pushes. A state is the sorted box positions plus
// the player's reachable region, canonicalised by the lowest cell index of
// that region (the region is a connected component, so its lowest cell names
// it). Returns the push list [{from, to, dir}] of a push-optimal solution, or
// null when the search exhausts or exceeds the state cap.

function solvePushBFS(W, H, wall, walkable, keyMask, startPlayer, startBoxes, goalSet, live, cap) {
  const start = startBoxes.slice().sort((a, b) => a - b);
  for (const b of start) if (!live[b]) return null;
  const startSet = new Set(start);
  for (const b of start) if (isFrozen2x2(W, H, wall, startSet, goalSet, b)) return null;
  if (start.every((b) => goalSet.has(b))) return [];

  const nodes = [];
  const seen = new Map();
  const startRegion = flood(W, H, walkable, maskOf(W, H, start), keyMask, startPlayer);
  nodes.push({ boxes: start, player: startPlayer, parent: -1, push: null });
  seen.set(start.join(',') + '|' + startRegion.minKey, 0);

  let head = 0;
  while (head < nodes.length) {
    const node = nodes[head];
    const nodeIdx = head;
    head++;
    if (node.boxes.every((b) => goalSet.has(b))) {
      const pushes = [];
      let x = nodeIdx;
      while (nodes[x].push !== null) {
        pushes.push(nodes[x].push);
        x = nodes[x].parent;
      }
      pushes.reverse();
      return pushes;
    }
    const region = flood(W, H, walkable, maskOf(W, H, node.boxes), keyMask, node.player);
    const boxSet = new Set(node.boxes);
    for (let bi = 0; bi < node.boxes.length; bi++) {
      const b = node.boxes[bi];
      const br = Math.floor(b / W);
      const bc = b % W;
      for (let d = 0; d < 4; d++) {
        const dr = DIRS[d].dr;
        const dc = DIRS[d].dc;
        const hr = br - dr;
        const hc = bc - dc;
        const tr = br + dr;
        const tc = bc + dc;
        if (hr < 0 || hr >= H || hc < 0 || hc >= W) continue;
        if (tr < 0 || tr >= H || tc < 0 || tc >= W) continue;
        const behind = hr * W + hc;
        const dest = tr * W + tc;
        if (!region.seen[behind]) continue;
        if (!walkable[dest] || boxSet.has(dest)) continue;
        if (!live[dest]) continue;
        const nb = node.boxes.slice();
        nb[bi] = dest;
        nb.sort((x, y) => x - y);
        const nbSet = new Set(nb);
        if (isFrozen2x2(W, H, wall, nbSet, goalSet, dest)) continue;
        const childRegion = flood(W, H, walkable, maskOf(W, H, nb), keyMask, b);
        const key = nb.join(',') + '|' + childRegion.minKey;
        if (seen.has(key)) continue;
        seen.set(key, nodes.length);
        nodes.push({ boxes: nb, player: b, parent: nodeIdx, push: { from: b, to: dest, dir: d } });
        if (nodes.length > cap) return null;
      }
    }
  }
  return null;
}

// Turn a push list into player moves: walk to each push position, then push.
// Returns {moves, player, boxes} or null if a walk fails.
function renderMoves(W, H, wall, walkable, startPlayer, startBoxes, pushes) {
  let moves = '';
  let player = startPlayer;
  const boxes = startBoxes.slice();
  for (const p of pushes) {
    const d = DIRS[p.dir];
    const behind = p.from - (d.dr * W + d.dc);
    const w = walkPath(W, H, wall, walkable, maskOf(W, H, boxes), player, behind);
    if (w === null) return null;
    moves += w + d.ch;
    const bi = boxes.indexOf(p.from);
    boxes[bi] = p.to;
    player = p.from;
  }
  return { moves, player, boxes };
}

// ---------------------------------------------------------------- whole level

function solveWholeLevel(W, H, wall, goals, boxes, player) {
  try {
    const walkable = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (!wall[i]) walkable[i] = 1;
    const goalArr = Array.from(goals);
    const live = computeLive(W, H, wall, goalArr);
    const pushes = solvePushBFS(W, H, wall, walkable, walkable, player, boxes, goals, live, WHOLE_STATE_CAP);
    if (pushes === null) return '';
    const rendered = renderMoves(W, H, wall, walkable, player, boxes, pushes);
    return rendered === null ? '' : rendered.moves;
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------- level solve

function solveLevel(text) {
  const { W, H, wall, goals, boxes, player } = parseLevel(text);
  if (boxes.length === 0 || player < 0) return '';
  try {
    const hallwayRow = Math.floor(player / W);

    // Rooms: connected components of non-wall cells after removing the
    // hallway row.
    const comp = new Int32Array(W * H).fill(-1);
    const rooms = [];
    for (let i = 0; i < W * H; i++) {
      if (wall[i] || Math.floor(i / W) === hallwayRow || comp[i] !== -1) continue;
      const id = rooms.length;
      const cells = [];
      const stack = [i];
      comp[i] = id;
      while (stack.length > 0) {
        const cur = stack.pop();
        cells.push(cur);
        const r = Math.floor(cur / W);
        const c = cur % W;
        for (let d = 0; d < 4; d++) {
          const nr = r + DIRS[d].dr;
          const nc = c + DIRS[d].dc;
          if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
          const n = nr * W + nc;
          if (wall[n] || Math.floor(n / W) === hallwayRow || comp[n] !== -1) continue;
          comp[n] = id;
          stack.push(n);
        }
      }
      const rBoxes = boxes.filter((b) => comp[b] === id);
      const rGoals = [];
      for (const g of goals) if (comp[g] === id) rGoals.push(g);
      const doors = [];
      for (const cell of cells) {
        const r = Math.floor(cell / W);
        const c = cell % W;
        if (r !== hallwayRow - 1 && r !== hallwayRow + 1) continue;
        const adj = hallwayRow * W + c;
        if (!wall[adj]) doors.push({ cell, entry: adj, col: c, row: r });
      }
      rooms.push({ cells, boxes: rBoxes, goals: rGoals, doors });
    }

    let valid = true;
    let counted = 0;
    for (const room of rooms) {
      if (room.doors.length !== 1) valid = false;
      if (room.boxes.length !== room.goals.length) valid = false;
      counted += room.boxes.length;
    }
    if (counted !== boxes.length) valid = false;
    if (!valid) return solveWholeLevel(W, H, wall, goals, boxes, player);

    // Fixed order: rooms above the hallway first, then below, by door column.
    rooms.sort((a, b) => {
      const aTop = a.doors[0].row < hallwayRow ? 0 : 1;
      const bTop = b.doors[0].row < hallwayRow ? 0 : 1;
      return aTop - bTop || a.doors[0].col - b.doors[0].col;
    });

    const allOpen = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (!wall[i]) allOpen[i] = 1;

    let moves = '';
    let curPlayer = player;
    let curBoxes = boxes.slice();
    for (const room of rooms) {
      if (room.boxes.length === 0) continue;
      const entry = room.doors[0].entry;
      const w = walkPath(W, H, wall, allOpen, maskOf(W, H, curBoxes), curPlayer, entry);
      if (w === null) return solveWholeLevel(W, H, wall, goals, boxes, player);
      moves += w;
      curPlayer = entry;

      const walkable = new Uint8Array(W * H);
      for (const c of room.cells) walkable[c] = 1;
      walkable[entry] = 1;
      const keyMask = new Uint8Array(W * H);
      for (const c of room.cells) keyMask[c] = 1;
      const live = computeLive(W, H, wall, room.goals);
      const goalSet = new Set(room.goals);
      const pushes = solvePushBFS(W, H, wall, walkable, keyMask, entry, room.boxes, goalSet, live, ROOM_STATE_CAP);
      if (pushes === null) return solveWholeLevel(W, H, wall, goals, boxes, player);
      const rendered = renderMoves(W, H, wall, walkable, entry, room.boxes, pushes);
      if (rendered === null) return solveWholeLevel(W, H, wall, goals, boxes, player);
      moves += rendered.moves;
      curPlayer = rendered.player;
      const roomSet = new Set(room.boxes);
      curBoxes = curBoxes.filter((b) => !roomSet.has(b)).concat(rendered.boxes);
    }
    return moves;
  } catch (e) {
    return solveWholeLevel(W, H, wall, goals, boxes, player);
  }
}

// ---------------------------------------------------------------- main

for (const id of readdirSync(IN_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  } catch (e) {
    moves = '';
  }
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), moves + '\n');
}
