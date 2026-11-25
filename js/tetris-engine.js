/* Tetris core engine — pure game logic, no DOM. */

const COLS = 10;
const HIDDEN_ROWS = 2;
const VISIBLE_ROWS = 20;
const ROWS = VISIBLE_ROWS + HIDDEN_ROWS;

const PIECE_TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

const SHAPES = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]],
  ],
  O: [
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
  ],
  T: [
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ],
  S: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[1, 1], [2, 1], [0, 2], [1, 2]],
    [[0, 0], [0, 1], [1, 1], [1, 2]],
  ],
  Z: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[1, 0], [0, 1], [1, 1], [0, 2]],
  ],
  J: [
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ],
  L: [
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [1, 1], [1, 2]],
  ],
};

const SPAWN_OFFSET = { x: 3, y: 1 };

const KICK_OFFSETS = [
  [0, 0], [1, 0], [-1, 0], [0, -1],
  [1, -1], [-1, -1], [2, 0], [-2, 0], [0, -2],
];

const LOCK_DELAY_MS = 500;
const MAX_LOCK_RESETS = 15;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class PieceQueue {
  constructor(seed) {
    this.rand = mulberry32(seed);
    this.queue = [];
  }
  _bag() {
    const bag = PIECE_TYPES.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    return bag;
  }
  _ensure(n) {
    while (this.queue.length < n) this.queue.push(...this._bag());
  }
  next() {
    this._ensure(1);
    return this.queue.shift();
  }
  peek(n) {
    this._ensure(n);
    return this.queue.slice(0, n);
  }
}

class TetrisGame {
  constructor(seed) {
    this.reset(seed);
  }

  reset(seed) {
    this.grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
    this.queue = new PieceQueue(seed >>> 0);
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.alive = true;
    this.hold = null;
    this.canHold = true;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.grounded = false;
    this.gravityAcc = 0;
    this.softDropping = false;
    this.lastClear = null;
    this._spawn();
  }

  _spawnPieceAt(type) {
    return {
      type,
      rot: 0,
      x: SPAWN_OFFSET.x,
      y: SPAWN_OFFSET.y,
    };
  }

  _spawn(type) {
    const t = type || this.queue.next();
    const piece = this._spawnPieceAt(t);
    if (this._collides(piece, piece.x, piece.y, piece.rot)) {
      this.alive = false;
      this.active = piece;
      return;
    }
    this.active = piece;
    this.canHold = true;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.grounded = false;
  }

  _cells(piece, rot) {
    return SHAPES[piece.type][rot ?? piece.rot];
  }

  _collides(piece, x, y, rot) {
    const cells = this._cells(piece, rot);
    for (const [cx, cy] of cells) {
      const gx = x + cx;
      const gy = y + cy;
      if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
      if (gy < 0) continue;
      if (this.grid[gy][gx]) return true;
    }
    return false;
  }

  _tryMove(dx, dy) {
    const p = this.active;
    if (!this._collides(p, p.x + dx, p.y + dy, p.rot)) {
      p.x += dx;
      p.y += dy;
      return true;
    }
    return false;
  }

  moveLeft() { if (this.alive) { if (this._tryMove(-1, 0)) this._afterMove(); } }
  moveRight() { if (this.alive) { if (this._tryMove(1, 0)) this._afterMove(); } }

  _afterMove() {
    if (this.grounded) {
      this.lockResets = Math.min(this.lockResets + 1, MAX_LOCK_RESETS);
      this.lockTimer = 0;
    }
  }

  rotate(dir) {
    if (!this.alive) return;
    const p = this.active;
    if (p.type === 'O') return;
    const from = p.rot;
    const to = (p.rot + dir + 4) % 4;
    for (const [ox, oy] of KICK_OFFSETS) {
      if (!this._collides(p, p.x + ox, p.y + oy, to)) {
        p.x += ox;
        p.y += oy;
        p.rot = to;
        this._afterMove();
        return;
      }
    }
  }
  rotateCW() { this.rotate(1); }
  rotateCCW() { this.rotate(-1); }

  softDrop() {
    if (!this.alive) return;
    if (this._tryMove(0, 1)) {
      this.score += 1;
      this.gravityAcc = 0;
      this._afterMove();
    }
  }

  hardDrop() {
    if (!this.alive) return;
    let dist = 0;
    while (this._tryMove(0, 1)) dist++;
    this.score += dist * 2;
    this._lock();
  }

  holdPiece() {
    if (!this.alive || !this.canHold) return;
    const p = this.active;
    const current = p.type;
    if (this.hold == null) {
      this.hold = current;
      this._spawn();
    } else {
      const swap = this.hold;
      this.hold = current;
      this._spawn(swap);
    }
    this.canHold = false;
  }

  _dropIntervalMs() {
    return Math.max(100, 1000 - (this.level - 1) * 80);
  }

  update(dtMs) {
    if (!this.alive) return;
    const p = this.active;
    const onFloor = this._collides(p, p.x, p.y + 1, p.rot);
    this.grounded = onFloor;

    if (onFloor) {
      this.lockTimer += dtMs;
      if (this.lockTimer >= LOCK_DELAY_MS || this.lockResets >= MAX_LOCK_RESETS) {
        this._lock();
      }
    } else {
      this.gravityAcc += dtMs;
      const interval = this._dropIntervalMs();
      while (this.gravityAcc >= interval) {
        this.gravityAcc -= interval;
        if (!this._tryMove(0, 1)) break;
      }
    }
  }

  _lock() {
    const p = this.active;
    const cells = this._cells(p);
    let minRow = ROWS;
    for (const [cx, cy] of cells) {
      const gx = p.x + cx;
      const gy = p.y + cy;
      if (gy >= 0) {
        this.grid[gy][gx] = p.type;
        minRow = Math.min(minRow, gy);
      }
    }
    const clearedCount = this._clearLines();
    if (minRow < HIDDEN_ROWS && clearedCount === 0) {
      this.alive = false;
      return;
    }
    this._spawn();
  }

  _clearLines() {
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (this.grid[r].every((c) => c !== 0)) {
        this.grid.splice(r, 1);
        this.grid.unshift(new Array(COLS).fill(0));
        cleared++;
        r++;
      }
    }
    if (cleared > 0) {
      const points = [0, 100, 300, 500, 800][cleared] || 800;
      this.score += points * this.level;
      this.lines += cleared;
      this.level = Math.floor(this.lines / 10) + 1;
      this.lastClear = { cleared, at: Date.now() };
    }
    return cleared;
  }

  ghostY() {
    const p = this.active;
    let y = p.y;
    while (!this._collides(p, p.x, y + 1, p.rot)) y++;
    return y;
  }

  activeCells() {
    return this._cells(this.active);
  }

  /** Flattened visible-grid snapshot (20x10) with the active piece baked in, for rendering/network. */
  snapshot() {
    const out = [];
    for (let r = HIDDEN_ROWS; r < ROWS; r++) out.push(this.grid[r].slice());
    if (this.alive && this.active) {
      const p = this.active;
      for (const [cx, cy] of this._cells(p)) {
        const gx = p.x + cx;
        const gy = p.y + cy - HIDDEN_ROWS;
        if (gy >= 0 && gy < VISIBLE_ROWS && gx >= 0 && gx < COLS) {
          out[gy][gx] = p.type;
        }
      }
    }
    return out;
  }

  getState() {
    return {
      grid: this.snapshot(),
      next: this.queue.peek(3),
      hold: this.hold,
      score: this.score,
      lines: this.lines,
      level: this.level,
      alive: this.alive,
    };
  }
}

const TetrisCore = { COLS, VISIBLE_ROWS, ROWS, HIDDEN_ROWS, SHAPES, PIECE_TYPES, TetrisGame, mulberry32 };
if (typeof window !== 'undefined') window.TetrisCore = TetrisCore;
