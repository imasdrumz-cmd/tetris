/* Online poker rooms over WebRTC (PeerJS), same star topology as the Tetris
   rooms: the host's browser tab IS the room. Unlike Tetris, poker needs a
   single trusted authority — the host runs the actual PokerEngine, validates
   every action, and sends each player a PERSONALIZED view of the table (your
   own hole cards revealed, everyone else's hidden) rather than one shared
   broadcast. Clients just render whatever view they're sent and forward the
   local player's button clicks to the host as action requests. */

const ROOM_PREFIX = 'smusht-poker-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PLAYER_COLORS = ['#7FB0C9', '#D9B65C', '#9C7BC9', '#7FBF8E', '#CC7A7A', '#5B7FA6', '#D99559'];
const MAX_PLAYERS = 6;

function randomCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function ensurePeerJsLoaded() {
  if (typeof Peer === 'undefined') {
    throw new Error('Could not load the networking library. Check your connection and reload the page.');
  }
}

class PokerRoom extends EventTarget {
  constructor() {
    super();
    this.peer = null;
    this.isHost = false;
    this.code = null;
    this.selfId = null;
    this.name = null;
    this.roster = new Map(); // id -> {name, color, isHost}
    this.conns = new Map();
    this.hostConn = null;
    this.engine = null; // PokerEngine, host-only
    this.startingChips = 1000;
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _rosterArray() { return Array.from(this.roster.entries()).map(([id, p]) => ({ id, ...p })); }

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

    this.roster.set(this.selfId, { name, color: PLAYER_COLORS[0], isHost: true });
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
      if (this.roster.size >= MAX_PLAYERS) { conn.send({ type: 'full' }); conn.close(); return; }
      const color = PLAYER_COLORS[this.roster.size % PLAYER_COLORS.length];
      this.roster.set(conn.peer, { name: msg.name || 'Player', color, isHost: false });
      conn.send({ type: 'welcome', id: conn.peer, code: this.code, roster: this._rosterArray() });
      this._broadcastRoster();
      return;
    }
    if (msg.type === 'action') {
      if (!this.engine) return;
      const res = this.engine.applyAction(conn.peer, msg.action, msg.amount);
      if (res.ok) this._broadcastTableState();
      return;
    }
    if (msg.type === 'leave') this._onPeerLeft(conn.peer);
  }

  _onPeerLeft(id) {
    if (!this.roster.has(id)) return;
    this.roster.delete(id);
    this.conns.delete(id);
    if (this.engine) {
      const p = this.engine.byId(id);
      if (p && !p.bustedOut) { p.folded = true; p.bustedOut = true; p.chips = 0; }
      this.engine._checkBustouts();
      this._broadcastTableState();
    }
    this._broadcastRoster();
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
          this.roster = new Map(msg.roster.map((p) => [p.id, p]));
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
        this.roster = new Map(msg.roster.map((p) => [p.id, p]));
        this._emit('roster', { players: msg.roster });
        break;
      case 'table-state':
        this._emit('table-state', msg.view);
        break;
      case 'game-start':
        this._emit('game-start', {});
        break;
      case 'game-over':
        this._emit('game-over', msg);
        break;
      default: break;
    }
  }

  startGame(startingChips) {
    if (!this.isHost) return;
    this.startingChips = startingChips;
    const ids = this._rosterArray().map((p) => p.id);
    this.engine = new PokerCore.PokerEngine(ids, startingChips);
    this.engine.players.forEach((p) => { p.name = (this.roster.get(p.id) || {}).name || 'Player'; });
    this.engine.startHand();
    for (const [, c] of this.conns) if (c.open) c.send({ type: 'game-start' });
    this._emit('game-start', {});
    this._broadcastTableState();
  }

  nextHand() {
    if (!this.isHost || !this.engine) return;
    this.engine.startHand();
    this._broadcastTableState();
  }

  _broadcastTableState() {
    if (!this.engine) return;
    const hostView = this.engine.viewFor(this.selfId);
    this._emit('table-state', hostView);
    if (this.engine.phase === 'gameover') {
      const results = this.engine.players
        .map((p) => ({ id: p.id, name: p.name, chips: p.chips, place: p.bustedOut ? null : 1 }))
        .sort((a, b) => b.chips - a.chips);
      const msg = { type: 'game-over', winnerId: this.engine.winnerId, results };
      for (const [, c] of this.conns) if (c.open) c.send(msg);
      this._emit('game-over', msg);
    }
    for (const [id, c] of this.conns) {
      if (!c.open) continue;
      c.send({ type: 'table-state', view: this.engine.viewFor(id) });
    }
  }

  sendAction(action, amount) {
    if (this.isHost) {
      if (!this.engine) return;
      const res = this.engine.applyAction(this.selfId, action, amount);
      if (res.ok) this._broadcastTableState();
    } else if (this.hostConn && this.hostConn.open) {
      this.hostConn.send({ type: 'action', action, amount });
    }
  }

  leave() {
    try {
      if (this.isHost) { for (const [, c] of this.conns) if (c.open) c.close(); }
      else if (this.hostConn) { if (this.hostConn.open) this.hostConn.send({ type: 'leave' }); this.hostConn.close(); }
      if (this.peer) this.peer.destroy();
    } catch (e) { /* ignore */ }
  }
}

const PokerNetwork = { PokerRoom, PLAYER_COLORS, MAX_PLAYERS };
if (typeof window !== 'undefined') window.PokerNetwork = PokerNetwork;
