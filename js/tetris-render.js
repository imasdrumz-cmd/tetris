/* Canvas rendering for Tetris boards — main board, mini peripheral boards, previews. */

const PIECE_COLORS = {
  I: '#7FB0C9',
  O: '#D9B65C',
  T: '#9C7BC9',
  S: '#7FBF8E',
  Z: '#CC7A7A',
  J: '#5B7FA6',
  L: '#D99559',
};

function drawBoard(ctx, grid, cell, opts = {}) {
  const cols = grid[0].length;
  const rows = grid.length;
  const w = cols * cell;
  const h = rows * cell;

  ctx.clearRect(0, 0, w, h);

  if (!opts.skipGridLines) {
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    for (let c = 1; c < cols; c++) {
      ctx.beginPath();
      ctx.moveTo(c * cell + 0.5, 0);
      ctx.lineTo(c * cell + 0.5, h);
      ctx.stroke();
    }
    for (let r = 1; r < rows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * cell + 0.5);
      ctx.lineTo(w, r * cell + 0.5);
      ctx.stroke();
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = grid[r][c];
      if (!v) continue;
      drawCell(ctx, c * cell, r * cell, cell, PIECE_COLORS[v] || '#888', opts.flat);
    }
  }
}

function drawCell(ctx, x, y, size, color, flat) {
  const pad = flat ? Math.max(1, size * 0.06) : Math.max(1, size * 0.08);
  const r = Math.max(2, size * 0.16);
  roundRect(ctx, x + pad, y + pad, size - pad * 2, size - pad * 2, r);
  ctx.fillStyle = color;
  ctx.fill();
  if (!flat) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
    const grad = ctx.createLinearGradient(x, y, x, y + size);
    grad.addColorStop(0, 'rgba(255,255,255,0.14)');
    grad.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = grad;
    roundRect(ctx, x + pad, y + pad, size - pad * 2, size - pad * 2, r);
    ctx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawGhost(ctx, cells, x, y, cell) {
  ctx.save();
  ctx.globalAlpha = 0.25;
  for (const [cx, cy] of cells) {
    const gx = (x + cx) * cell;
    const gy = (y + cy) * cell;
    roundRect(ctx, gx + 2, gy + 2, cell - 4, cell - 4, Math.max(2, cell * 0.16));
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

function drawPiecePreview(canvas, type, cell = 20) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!type) return;
  const shape = TetrisCore.SHAPES[type][0];
  let minX = 4, maxX = 0, minY = 4, maxY = 0;
  for (const [x, y] of shape) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const w = (maxX - minX + 1) * cell;
  const h = (maxY - minY + 1) * cell;
  const ox = (canvas.width - w) / 2 - minX * cell;
  const oy = (canvas.height - h) / 2 - minY * cell;
  for (const [x, y] of shape) {
    drawCell(ctx, ox + x * cell, oy + y * cell, cell, PIECE_COLORS[type]);
  }
}

const TetrisRender = { PIECE_COLORS, drawBoard, drawGhost, drawPiecePreview, roundRect };
if (typeof window !== 'undefined') window.TetrisRender = TetrisRender;
