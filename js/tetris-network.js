/* Online rooms over WebRTC (PeerJS). The host's browser tab IS the room —
   PeerJS's free public broker only brokers the initial handshake; game
   traffic flows peer-to-peer after that. Host relays state in a star
   topology: every client connects only to the host, and the host forwards
   each player's updates to everyone else. */

const ROOM_PREFIX = 'smusht-tet-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PLAYER_COLORS = ['#7FB0C9', '#D9B65C', '#9C7BC9', '#7FBF8E', '#CC7A7A', '#5B7FA6', '#D99559'];
const MAX_PLAYERS = 7;

function randomCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function ensurePeerJsLoaded() {
  if (typeof Peer === 'undefined') {
    throw new Error('Could not load the networking library. Check your connection and reload the page.');
  }
}

class TetrisRoom extends EventTarget {
  constructor() {
    super();
    this.peer = null;
    this.isHost = false;
    this.code = null;
    this.selfId = null;
    this.name = null;
    this.players = new Map();
    this.conns = new Map();
    this.hostConn = null;
    this.gameEnded = false;
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _rosterArray() { return Array.from(this.players.entries()).map(([id, p]) => ({ id, ...p })); }

  async createRoom(name) {
    ensurePeerJsLoaded();
    this.name = name;
    this.isHost = true;
    this.code = randomCode();
    const peer = new Peer(ROOM_PREFIX + this.code, { debug: 0 });
    this.peer = peer;

    await withTimeout(new Promise((resolve, reject) => {
      peer.on('open', (id) => { this.selfId = id; resolve(); });
      peer.on('error', (err) => reject(new Error(err && err.type === 'unavailable-id'
        ? 'That room code is taken, try again.' : (err.message || 'Could not create room.'))));
    }), 15000, 'Could not reach the connection server. Check your internet connection and try again.');

    this.players.set(this.selfId, { name, color: PLAYER_COLORS[0], score: 0, lines: 0, level: 1, alive: true, isHost: true });
    peer.on('connection', (conn) => this._onIncoming(conn));
    peer.on('error', (err) => this._emit('error', { message: err.message || String(err) }));
    return this.code;
  }

  _onIncoming(conn) {
    conn.on('data', (msg) => this._onHostReceive(conn, msg));
    conn.on('close', () => this._onPeerLeft(conn.peer));
    conn.on('error', () => this._onPeerLeft(conn.peer));
    this.conns.set(conn.peer, conn);
  }

  _onHostReceive(conn, msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'hello') {
      if (this.players.size >= MAX_PLAYERS) { conn.send({ type: 'full' }); conn.close(); return; }
      const color = PLAYER_COLORS[this.players.size % PLAYER_COLORS.length];
      this.players.set(conn.peer, { name: msg.name || 'Player', color, score: 0, lines: 0, level: 1, alive: true, isHost: false });
      conn.send({ type: 'welcome', id: conn.peer, code: this.code, roster: this._rosterArray() });
      this._broadcastRoster();
      return;
    }
    if (msg.type === 'state') {
      const p = this.players.get(conn.peer);
      if (p) { p.score = msg.score; p.lines = msg.lines; p.level = msg.level; p.alive = msg.alive; }
      this._relay(conn.peer, { type: 'peer-state', id: conn.peer, grid: msg.grid, score: msg.score, lines: msg.lines, level: msg.level, alive: msg.alive });
      this._emit('peer-state', { id: conn.peer, ...msg });
      this._checkGameOver();
      return;
    }
    if (msg.type === 'topout') {
      const p = this.players.get(conn.peer);
      if (p) { p.alive = false; p.score = msg.score; }
      this._relay(conn.peer, { type: 'peer-topout', id: conn.peer, score: msg.score });
      this._emit('peer-topout', { id: conn.peer, score: msg.score });
      this._checkGameOver();
      return;
    }
    if (msg.type === 'leave') this._onPeerLeft(conn.peer);
  }

  _relay(senderId, msg) {
    for (const [id, c] of this.conns) if (id !== senderId && c.open) c.send(msg);
  }

  _onPeerLeft(id) {
    if (!this.players.has(id)) return;
    this.players.delete(id);
    this.conns.delete(id);
    this._broadcastRoster();
    this._checkGameOver();
  }

  _broadcastRoster() {
    const roster = this._rosterArray();
    for (const [, c] of this.conns) if (c.open) c.send({ type: 'roster', roster });
    this._emit('roster', { players: roster });
  }

  async joinRoom(code, name) {
    ensurePeerJsLoaded();
    this.name = name;
    this.isHost = false;
    this.code = code.toUpperCase().trim();
    const peer = new Peer({ debug: 0 });
    this.peer = peer;

    await withTimeout(new Promise((resolve, reject) => {
      peer.on('open', () => resolve());
      peer.on('error', (err) => reject(new Error(err.message || 'Could not connect.')));
    }), 15000, 'Could not reach the connection server. Check your internet connection and try again.');

    const conn = peer.connect(ROOM_PREFIX + this.code, { reliable: true });
    this.hostConn = conn;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Could not reach that room. Check the code and try again.')), 10000);
      conn.on('open', () => conn.send({ type: 'hello', name }));
      conn.on('data', (msg) => {
        if (msg.type === 'full') { clearTimeout(timeout); reject(new Error('That room is full.')); return; }
        if (msg.type === 'welcome') {
          clearTimeout(timeout);
          this.selfId = msg.id;
          this.players = new Map(msg.roster.map((p) => [p.id, p]));
          resolve();
          return;
        }
        this._onClientReceive(msg);
      });
      conn.on('close', () => this._emit('host-left'));
      conn.on('error', (err) => { clearTimeout(timeout); reject(err); });
      peer.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });

    return this.code;
  }

  _onClientReceive(msg) {
    switch (msg.type) {
      case 'roster':
        this.players = new Map(msg.roster.map((p) => [p.id, p]));
        this._emit('roster', { players: msg.roster });
        break;
      case 'start':
        this._emit('start', { seed: msg.seed, startAt: msg.startAt, durationMs: msg.durationMs });
        break;
      case 'peer-state':
        { const p = this.players.get(msg.id); if (p) { p.score = msg.score; p.lines = msg.lines; p.level = msg.level; p.alive = msg.alive; } }
        this._emit('peer-state', msg);
        break;
      case 'peer-topout':
        { const p = this.players.get(msg.id); if (p) { p.alive = false; p.score = msg.score; } }
        this._emit('peer-topout', msg);
        break;
      case 'gameover':
        this._emit('gameover', msg);
        break;
      default: break;
    }
  }

  startGame(durationMs = 120000) {
    if (!this.isHost) return;
    const seed = Math.floor(Math.random() * 2 ** 31);
    const startAt = Date.now() + 3000;
    this.gameEnded = false;
    for (const p of this.players.values()) { p.alive = true; p.score = 0; p.lines = 0; p.level = 1; }
    for (const [, c] of this.conns) if (c.open) c.send({ type: 'start', seed, startAt, durationMs });
    this._emit('start', { seed, startAt, durationMs });
  }

  sendState(state) {
    if (this.isHost) {
      this._relay(this.selfId, { type: 'peer-state', id: this.selfId, ...state });
      const p = this.players.get(this.selfId);
      if (p) { p.score = state.score; p.lines = state.lines; p.level = state.level; p.alive = state.alive; }
      this._checkGameOver();
    } else if (this.hostConn && this.hostConn.open) {
      this.hostConn.send({ type: 'state', ...state });
    }
  }

  sendTopout(score) {
    if (this.isHost) {
      const p = this.players.get(this.selfId);
      if (p) { p.alive = false; p.score = score; }
      this._relay(this.selfId, { type: 'peer-topout', id: this.selfId, score });
      this._checkGameOver();
    } else if (this.hostConn && this.hostConn.open) {
      this.hostConn.send({ type: 'topout', score });
    }
  }

  _checkGameOver() {
    if (!this.isHost || this.gameEnded) return;
    const aliveCount = [...this.players.values()].filter((p) => p.alive).length;
    if (aliveCount === 0) {
      this.gameEnded = true;
      const results = [...this.players.entries()]
        .map(([id, p]) => ({ id, name: p.name, score: p.score, alive: p.alive }))
        .sort((a, b) => b.score - a.score);
      const msg = { type: 'gameover', results };
      for (const [, c] of this.conns) if (c.open) c.send(msg);
      this._emit('gameover', msg);
    }
  }

  leave() {
    try {
      if (this.isHost) {
        for (const [, c] of this.conns) { if (c.open) c.close(); }
      } else if (this.hostConn) {
        if (this.hostConn.open) this.hostConn.send({ type: 'leave' });
        this.hostConn.close();
      }
      if (this.peer) this.peer.destroy();
    } catch (e) { /* ignore */ }
  }
}

const TetrisNetwork = { TetrisRoom, PLAYER_COLORS, MAX_PLAYERS };
if (typeof window !== 'undefined') window.TetrisNetwork = TetrisNetwork;
