# Sokoban Solver

A push-optimal Sokoban solver for the [make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121) — one program (`main.ts`, Node 22) that answers a whole set of 5 generated levels in a single run.

[![Bounty](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/oponopon31/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/oponopon31/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

## How it works

Each generated level is a one-cell-wide hallway with 1–4 small rooms off it, each room holding 3–4 boxes and as many goals behind a single door. A box pushed into the hallway can never be pushed back, so every box stays in its room and the level optimum is the sum of the rooms' optima.

The solver therefore decomposes each level into rooms and solves every room independently with a push-based breadth-first search (uniform cost over pushes, so the first solved state found is push-optimal), with two prunings:

- **Dead squares** from a reverse-pull analysis seeded at the goals (a cell is live only when a box there can still be pulled toward a goal).
- **Frozen 2×2 blocks** of walls/boxes holding a box off its goal.

The per-room push sequences are stitched together with shortest player walks through the hallway. If a room ever defeats the search, the whole level is retried with one push-BFS as a fallback. Everything is budgeted by work (state counts), never by the clock, and every order is fixed, so two runs write identical bytes.

## Verification

- Practice set: all 5 instances solved in exactly the optimal push counts (13, 16, 29, 47, 60) — **score 1,000,000** with the kit's local grader (`grade-local --driver process`), deterministic across runs.
- 35 extra instances drawn from 7 fresh random seeds with the kit's own generator: every one solved in exactly its optimal push count.
- Full 5-instance practice run takes a few seconds, far under the 60 s budget; the largest room search visited ~8,100 states against a 250,000 cap.

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/level.txt` for `i001`–`i005`, writes `/output/<id>/solution.txt` (moves `u`/`d`/`l`/`r`).
