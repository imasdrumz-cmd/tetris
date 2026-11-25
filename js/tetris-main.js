/* Wires the engine, renderer, and network room to the DOM. */

const HS_KEY = 'tetris_high_score';
const NAME_KEY = 'tetris_player_name';

function getHighScore() { return parseInt(localStorage.getItem(HS_KEY) || '0', 10); }
function setHighScore(v) { localStorage.setItem(HS_KEY, String(v)); }

class InputController {
  constructor(game) {
    this.game = game;
    this.disabled = false;
    this.onEscape = null;
    this.left = { down: false, t: 0 };
    this.right = { down: false, t: 0 };
    this.downHeld = false;
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  destroy() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }

  _handleKeyDown(e) {
    if (this.disabled) return;
    switch (e.code) {
      case 'ArrowLeft':
        if (!this.left.down) { this.left.down = true; this.left.t = 0; this.game.moveLeft(); }
        e.preventDefault(); break;
      case 'ArrowRight':
        if (!this.right.down) { this.right.down = true; this.right.t = 0; this.game.moveRight(); }
        e.preventDefault(); break;
      case 'ArrowDown':
        this.downHeld = true; e.preventDefault(); break;
      case 'ArrowUp':
      case 'KeyX':
        if (!e.repeat) this.game.rotateCW();
        e.preventDefault(); break;
      case 'KeyZ':
        if (!e.repeat) this.game.rotateCCW();
        e.preventDefault(); break;
      case 'Space':
        if (!e.repeat) this.game.hardDrop();
        e.preventDefault(); break;
      case 'KeyC':
      case 'ShiftLeft':
      case 'ShiftRight':
        if (!e.repeat) this.game.holdPiece();
        e.preventDefault(); break;
      case 'Escape':
        if (!e.repeat && this.onEscape) this.onEscape();
        e.preventDefault(); break;
      default: break;
    }
  }

  _handleKeyUp(e) {
    switch (e.code) {
      case 'ArrowLeft': this.left.down = false; break;
      case 'ArrowRight': this.right.down = false; break;
      case 'ArrowDown': this.downHeld = false; break;
      default: break;
    }
  }

  update(dtMs) {
    if (this.disabled) return;
    const DAS = 170, ARR = 42;
    if (this.left.down) {
      this.left.t += dtMs;
      if (this.left.t >= DAS) { this.left.t -= ARR; this.game.moveLeft(); }
    }
    if (this.right.down) {
      this.right.t += dtMs;
      if (this.right.t >= DAS) { this.right.t -= ARR; this.game.moveRight(); }
    }
    if (this.downHeld) this.game.softDrop();
  }
}

(function () {
  const el = (id) => document.getElementById(id);

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    el('screen-' + name).classList.add('active');
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ---- menu bootstrap ----
  el('high-score-value').textContent = getHighScore();
  const nameInput = el('input-name');
  nameInput.value = localStorage.getItem(NAME_KEY) || '';

  function playerName() {
    const v = nameInput.value.trim().slice(0, 16) || ('Player' + Math.floor(Math.random() * 900 + 100));
    localStorage.setItem(NAME_KEY, v);
    return v;
  }

  el('btn-show-controls').onclick = () => el('overlay-controls').classList.add('active');
  el('btn-close-controls').onclick = () => el('overlay-controls').classList.remove('active');
  el('btn-online').onclick = () => { setOnlineError(''); showScreen('online-menu'); };
  el('btn-back-to-menu').onclick = () => showScreen('menu');

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.querySelector(`.tab-pane[data-pane="${btn.dataset.tab}"]`).classList.add('active');
      setOnlineError('');
    };
  });

  function setOnlineError(msg) { el('online-error').textContent = msg || ''; }

  // ---- state ----
  let mode = null; // 'solo' | 'online'
  let room = null;
  let game = null;
  let input = null;
  let rafId = null;
  let lastTs = 0;
  let paused = false;
  let localDead = false;
  let sendStateTimer = 0;
  const miniEls = new Map();

  const mainCanvas = el('canvas-main');
  const mainCtx = mainCanvas.getContext('2d');
  let CELL = 30;
  const holdCanvas = el('canvas-hold');
  const nextCanvases = [0, 1, 2].map((i) => el('canvas-next-' + i));

  function computeCellSize() {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const reserveBottom = coarse ? 210 : 24;
    const reserveTop = coarse ? 72 : 24;
    const availH = window.innerHeight - reserveBottom - reserveTop;
    const availW = Math.min(window.innerWidth - 32, 340);
    const byHeight = Math.floor(availH / TetrisCore.VISIBLE_ROWS);
    const byWidth = Math.floor(availW / TetrisCore.COLS);
    return Math.max(12, Math.min(byHeight, byWidth, 30));
  }

  function applyCellSize() {
    CELL = computeCellSize();
    mainCanvas.width = CELL * TetrisCore.COLS;
    mainCanvas.height = CELL * TetrisCore.VISIBLE_ROWS;
  }

  // ---- solo ----
  el('btn-solo').onclick = () => {
    mode = 'solo';
    room = null;
    el('peripherals').innerHTML = '';
    showScreen('game');
    beginGame(Math.floor(Math.random() * 2 ** 31));
  };

  // ---- online: create / join ----
  function withBusy(button, busyText, fn) {
    return async (...args) => {
      const original = button.textContent;
      button.disabled = true;
      button.textContent = busyText;
      try {
        await fn(...args);
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    };
  }

  el('btn-create-room').onclick = withBusy(el('btn-create-room'), 'Connecting…', async () => {
    const name = playerName();
    setOnlineError('');
    const r = new TetrisNetwork.TetrisRoom();
    wireRoomEvents(r);
    try {
      const code = await r.createRoom(name);
      room = r;
      el('lobby-code').textContent = code;
      el('btn-start-game').hidden = false;
      el('start-delay-field').hidden = false;
      el('waiting-hint').hidden = true;
      renderRoster(r._rosterArray());
      showScreen('lobby');
    } catch (err) {
      setOnlineError(err.message || 'Could not create room.');
    }
  });

  el('btn-join-room').onclick = withBusy(el('btn-join-room'), 'Connecting…', async () => {
    const name = playerName();
    const code = el('input-code').value.trim();
    if (!code) { setOnlineError('Enter a room code.'); return; }
    setOnlineError('');
    const r = new TetrisNetwork.TetrisRoom();
    wireRoomEvents(r);
    try {
      await r.joinRoom(code, name);
      room = r;
      el('lobby-code').textContent = room.code;
      el('btn-start-game').hidden = true;
      el('start-delay-field').hidden = true;
      el('waiting-hint').hidden = false;
      renderRoster([...room.players.entries()].map(([id, p]) => ({ id, ...p })));
      showScreen('lobby');
    } catch (err) {
      setOnlineError(err.message || 'Could not join room.');
    }
  });

  el('btn-copy-code').onclick = () => {
    const code = el('lobby-code').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
  };

  el('btn-leave-lobby').onclick = () => { cleanupRoom(); showScreen('menu'); };
  el('btn-start-game').onclick = () => {
    if (!room) return;
    const delayMs = parseInt(el('start-delay').value, 10) || 3000;
    room.startGame(delayMs);
  };

  function wireRoomEvents(r) {
    r.addEventListener('roster', (e) => renderRoster(e.detail.players));
    r.addEventListener('start', (e) => onNetworkStart(e.detail));
    r.addEventListener('peer-state', (e) => onPeerState(e.detail));
    r.addEventListener('peer-topout', (e) => onPeerTopout(e.detail));
    r.addEventListener('gameover', (e) => onNetworkGameOver(e.detail));
    r.addEventListener('error', (e) => setOnlineError(e.detail.message));
    r.addEventListener('host-left', () => {
      stopLoop();
      cleanupRoom();
      alert('The host left the room.');
      showScreen('menu');
    });
  }

  function renderRoster(players) {
    const list = el('roster-list');
    list.innerHTML = '';
    players.forEach((p) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.color;
      const label = document.createElement('span');
      label.textContent = p.name + (p.isHost ? ' (host)' : '');
      li.appendChild(dot);
      li.appendChild(label);
      if (room && p.id === room.selfId) {
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = 'you';
        li.appendChild(you);
      }
      list.appendChild(li);
    });
  }

  function cleanupRoom() {
    if (room) { room.leave(); room = null; }
    stopLoop();
  }

  // ---- online: starting a round ----
  function onNetworkStart(detail) {
    mode = 'online';
    localDead = false;
    el('local-status-overlay').hidden = true;
    setupPeripherals();
    showScreen('game');
    const delay = Math.max(0, detail.startAt - Date.now());
    runCountdown(delay, () => beginGame(detail.seed));
  }

  function runCountdown(ms, cb) {
    const cd = el('countdown');
    cd.hidden = false;
    let remaining = Math.ceil(ms / 1000);
    cd.textContent = remaining > 0 ? remaining : 'GO';
    const interval = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) cd.textContent = remaining;
      else if (remaining === 0) cd.textContent = 'GO';
      else { clearInterval(interval); cd.hidden = true; cb(); }
    }, 1000);
  }

  function setupPeripherals() {
    const container = el('peripherals');
    container.innerHTML = '';
    miniEls.clear();
    if (!room) return;
    [...room.players.entries()].filter(([id]) => id !== room.selfId).forEach(([id, p]) => {
      const box = document.createElement('div');
      box.className = 'mini-board';
      const canvas = document.createElement('canvas');
      canvas.width = 60; canvas.height = 120;
      const nameEl = document.createElement('div');
      nameEl.className = 'mini-name';
      nameEl.textContent = p.name;
      const scoreEl = document.createElement('div');
      scoreEl.className = 'mini-score';
      scoreEl.textContent = '0';
      box.appendChild(canvas); box.appendChild(nameEl); box.appendChild(scoreEl);
      container.appendChild(box);
      miniEls.set(id, { box, ctx: canvas.getContext('2d'), scoreEl });
    });
  }

  function onPeerState(detail) {
    const m = miniEls.get(detail.id);
    if (!m || !detail.grid) return;
    m.scoreEl.textContent = detail.score;
    TetrisRender.drawBoard(m.ctx, detail.grid, 6, { flat: true, skipGridLines: true });
    m.box.classList.toggle('dead', !detail.alive);
  }

  function onPeerTopout(detail) {
    const m = miniEls.get(detail.id);
    if (m) { m.box.classList.add('dead'); m.scoreEl.textContent = detail.score; }
  }

  function onNetworkGameOver(detail) {
    stopLoop();
    el('local-status-overlay').hidden = true;
    showOnlineGameOver(detail.results);
  }

  // ---- the actual game loop ----
  function beginGame(seed) {
    applyCellSize();
    game = new TetrisCore.TetrisGame(seed);
    if (input) input.destroy();
    input = new InputController(game);
    input.onEscape = () => { if (mode === 'solo') togglePause(); };
    paused = false;
    localDead = false;
    el('pause-overlay').hidden = true;
    el('local-status-overlay').hidden = true;
    sendStateTimer = 0;
    lastTs = performance.now();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  }

  function togglePause() {
    paused = !paused;
    el('pause-overlay').hidden = !paused;
  }

  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (input) input.disabled = true;
  }

  function loop(ts) {
    const dt = Math.min(50, ts - lastTs);
    lastTs = ts;
    if (!paused) {
      input.update(dt);
      game.update(dt);
      render();
      if (mode === 'online' && room) {
        sendStateTimer += dt;
        if (sendStateTimer >= 150) { sendStateTimer = 0; room.sendState(game.getState()); }
      }
      if (!game.alive) { onLocalGameOver(); return; }
    }
    rafId = requestAnimationFrame(loop);
  }

  function onLocalGameOver() {
    render();
    if (mode === 'solo') {
      stopLoop();
      const score = game.score;
      const best = getHighScore();
      const isNew = score > best;
      if (isNew) setHighScore(score);
      showSoloGameOver(score, isNew);
    } else if (mode === 'online' && room) {
      stopLoop();
      localDead = true;
      room.sendTopout(game.score);
      el('local-status-text').textContent = `You topped out — score ${game.score}. Waiting for the round to end…`;
      el('local-status-overlay').hidden = false;
    }
  }

  function render() {
    const state = game.getState();
    TetrisRender.drawBoard(mainCtx, state.grid, CELL);
    if (game.alive) {
      const ghostY = game.ghostY() - TetrisCore.HIDDEN_ROWS;
      TetrisRender.drawGhost(mainCtx, game.activeCells(), game.active.x, ghostY, CELL);
    }
    el('stat-score').textContent = state.score;
    el('stat-lines').textContent = state.lines;
    el('stat-level').textContent = state.level;
    TetrisRender.drawPiecePreview(holdCanvas, state.hold, 18);
    state.next.forEach((t, i) => TetrisRender.drawPiecePreview(nextCanvases[i], t, 18));
  }

  // ---- game over screens ----
  function showSoloGameOver(score, isNew) {
    el('gameover-title').textContent = 'Game Over';
    el('results-table').hidden = true;
    el('new-high-badge').hidden = !isNew;
    el('solo-result').hidden = false;
    el('solo-score').textContent = score;
    el('solo-best').textContent = getHighScore();
    el('btn-play-again').hidden = false;
    el('high-score-value').textContent = getHighScore();
    showScreen('gameover');
  }

  function showOnlineGameOver(results) {
    el('gameover-title').textContent = 'Round Over';
    el('new-high-badge').hidden = true;
    el('solo-result').hidden = true;
    const table = el('results-table');
    table.hidden = false;
    const tbody = table.querySelector('tbody');
    tbody.innerHTML = '';
    results.forEach((r, i) => {
      const tr = document.createElement('tr');
      if (i === 0) tr.classList.add('winner');
      tr.innerHTML = `<td class="rank">${i === 0 ? '\u{1F3C6}' : '#' + (i + 1)}</td>` +
        `<td>${escapeHtml(r.name)}</td><td class="score-col">${r.score}</td>`;
      tbody.appendChild(tr);
    });
    el('btn-play-again').hidden = !(room && room.isHost);
    showScreen('gameover');
  }

  el('btn-play-again').onclick = () => {
    if (mode === 'solo') {
      showScreen('game');
      beginGame(Math.floor(Math.random() * 2 ** 31));
    } else if (room && room.isHost) {
      room.startGame();
    }
  };

  el('btn-back-to-menu-2').onclick = () => {
    cleanupRoom();
    mode = null;
    el('high-score-value').textContent = getHighScore();
    showScreen('menu');
  };

  // ---- touch controls (phones / tablets) ----
  function bindHoldButton(elem, action) {
    let timeoutId = null;
    let intervalId = null;
    const fire = () => { if (game && !paused) action(); };
    const start = (e) => {
      e.preventDefault();
      fire();
      timeoutId = setTimeout(() => { intervalId = setInterval(fire, 42); }, 170);
    };
    const stop = () => { clearTimeout(timeoutId); clearInterval(intervalId); };
    elem.addEventListener('pointerdown', start);
    elem.addEventListener('pointerup', stop);
    elem.addEventListener('pointercancel', stop);
    elem.addEventListener('pointerleave', stop);
  }

  function bindTapButton(elem, action) {
    elem.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (game && !paused) action();
    });
  }

  bindHoldButton(el('tc-left'), () => game.moveLeft());
  bindHoldButton(el('tc-right'), () => game.moveRight());
  bindHoldButton(el('tc-down'), () => game.softDrop());
  bindTapButton(el('tc-rotate-cw'), () => game.rotateCW());
  bindTapButton(el('tc-rotate-ccw'), () => game.rotateCCW());
  bindTapButton(el('tc-harddrop'), () => game.hardDrop());
  bindTapButton(el('tc-hold'), () => game.holdPiece());
})();
