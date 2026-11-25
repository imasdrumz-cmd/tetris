/* Texas Hold'em engine — pure logic, no DOM. Runs authoritatively on the
   host only; clients just render whatever state the host sends them. */

const SUITS = ['S', 'H', 'D', 'C'];
const RANK_NAMES = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

function rankLabel(r) { return RANK_NAMES[r] || String(r); }

function freshDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push({ rank: r, suit: s });
  return deck;
}

function shuffle(deck) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function combinations(arr, k) {
  const result = [];
  function helper(start, combo) {
    if (combo.length === k) { result.push(combo.slice()); return; }
    for (let i = start; i < arr.length; i++) { combo.push(arr[i]); helper(i + 1, combo); combo.pop(); }
  }
  helper(0, []);
  return result;
}

/** Evaluate exactly 5 cards. Returns a comparable array: [rankClass, ...tiebreakers]. */
function evaluate5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  const uniqueRanks = [...new Set(ranks)];
  let isStraight = false;
  let straightHigh = 0;
  if (uniqueRanks.length === 5) {
    if (uniqueRanks[0] - uniqueRanks[4] === 4) { isStraight = true; straightHigh = uniqueRanks[0]; }
    else if (uniqueRanks.join(',') === '14,5,4,3,2') { isStraight = true; straightHigh = 5; }
  }

  const countMap = {};
  for (const r of ranks) countMap[r] = (countMap[r] || 0) + 1;
  const groups = Object.entries(countMap)
    .map(([r, c]) => [Number(r), c])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const counts = groups.map((g) => g[1]);

  if (isStraight && isFlush) return [8, straightHigh];
  if (counts[0] === 4) return [7, groups[0][0], groups[1][0]];
  if (counts[0] === 3 && counts[1] === 2) return [6, groups[0][0], groups[1][0]];
  if (isFlush) return [5, ...ranks];
  if (isStraight) return [4, straightHigh];
  if (counts[0] === 3) return [3, groups[0][0], groups[1][0], groups[2][0]];
  if (counts[0] === 2 && counts[1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]];
  if (counts[0] === 2) return [1, groups[0][0], groups[1][0], groups[2][0], groups[3][0]];
  return [0, ...ranks];
}

function compareHandValues(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

const HAND_NAMES = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];

/** Best 5-card hand out of 7 (2 hole + 5 community). */
function bestHandOf7(cards7) {
  let best = null;
  for (const combo of combinations(cards7, 5)) {
    const val = evaluate5(combo);
    if (!best || compareHandValues(val, best) > 0) best = val;
  }
  return best;
}

class PokerEngine {
  constructor(playerIds, startingChips) {
    this.players = playerIds.map((id, i) => ({
      id, seat: i, name: '', chips: startingChips,
      holeCards: [], folded: false, allIn: false,
      betThisStreet: 0, totalThisHand: 0, hasActed: false, bustedOut: false,
    }));
    this.dealerSeat = -1;
    this.handNumber = 0;
    this.phase = 'waiting'; // waiting | preflop | flop | turn | river | showdown | handover | gameover
    this.community = [];
    this.pots = []; // [{amount, eligibleIds}] — only populated at showdown
    this.pot = 0; // running total of chips collected from completed streets this hand
    this.deck = [];
    this.currentSeat = null;
    this.amountToCall = 0;
    this.minRaiseSize = 0;
    this.smallBlind = Math.max(1, Math.round(startingChips / 200));
    this.bigBlind = this.smallBlind * 2;
    this.lastHandSummary = null;
    this.winnerId = null;
  }

  byId(id) { return this.players.find((p) => p.id === id); }
  byseat(seat) { return this.players.find((p) => p.seat === seat); }
  activePlayers() { return this.players.filter((p) => !p.bustedOut); }
  inHandPlayers() { return this.players.filter((p) => !p.bustedOut && !p.folded); }
  canActPlayers() { return this.players.filter((p) => !p.bustedOut && !p.folded && !p.allIn); }

  _nextActiveSeatFrom(seat) {
    const active = this.activePlayers();
    if (active.length === 0) return null;
    const seats = active.map((p) => p.seat).sort((a, b) => a - b);
    let next = seats.find((s) => s > seat);
    if (next === undefined) next = seats[0];
    return next;
  }

  _nextActingSeatFrom(seat) {
    const candidates = this.canActPlayers();
    if (candidates.length === 0) return null;
    const seats = candidates.map((p) => p.seat).sort((a, b) => a - b);
    let next = seats.find((s) => s > seat);
    if (next === undefined) next = seats[0];
    return next;
  }

  totalPotAmount() { return this.pot + this._liveBetsSum(); }
  _liveBetsSum() { return this.players.reduce((s, p) => s + p.betThisStreet, 0); }

  startHand() {
    const active = this.activePlayers();
    if (active.length < 2) { this.phase = 'gameover'; this.winnerId = active[0] ? active[0].id : null; return; }

    this.handNumber++;
    this.community = [];
    this.pots = [];
    this.pot = 0;
    this.lastHandSummary = null;
    this.deck = shuffle(freshDeck());
    active.forEach((p) => {
      p.holeCards = []; p.folded = false; p.allIn = false;
      p.betThisStreet = 0; p.totalThisHand = 0; p.hasActed = false;
    });

    this.dealerSeat = this._nextActiveSeatFrom(this.dealerSeat === -1 ? -1 : this.dealerSeat);
    for (let i = 0; i < 2; i++) for (const p of active) p.holeCards.push(this.deck.pop());

    const heads = active.length === 2;
    const sbSeat = heads ? this.dealerSeat : this._nextActiveSeatFrom(this.dealerSeat);
    const bbSeat = this._nextActiveSeatFrom(sbSeat);
    this._postBlind(sbSeat, this.smallBlind);
    this._postBlind(bbSeat, this.bigBlind);
    this.amountToCall = this.bigBlind;
    this.minRaiseSize = this.bigBlind;
    this.phase = 'preflop';
    this.currentSeat = heads ? sbSeat : this._nextActingSeatFrom(bbSeat);
    this._advanceIfNoActionPossible();
  }

  _postBlind(seat, amount) {
    const p = this.byseat(seat);
    if (!p) return;
    const pay = Math.min(amount, p.chips);
    p.chips -= pay; p.betThisStreet += pay; p.totalThisHand += pay;
    if (p.chips === 0) p.allIn = true;
  }

  currentPlayer() { return this.currentSeat == null ? null : this.byseat(this.currentSeat); }

  legalActions() {
    const p = this.currentPlayer();
    if (!p) return [];
    const toCall = this.amountToCall - p.betThisStreet;
    const actions = ['fold'];
    if (toCall <= 0) actions.push('check'); else actions.push('call');
    if (p.chips > toCall) actions.push('raise');
    return actions;
  }

  applyAction(playerId, action, amount) {
    const p = this.byId(playerId);
    if (!p || this.currentSeat !== p.seat) return { ok: false, error: 'not_your_turn' };
    const toCall = this.amountToCall - p.betThisStreet;

    if (action === 'fold') {
      p.folded = true;
      p.hasActed = true;
    } else if (action === 'check') {
      if (toCall > 0) return { ok: false, error: 'cannot_check' };
      p.hasActed = true;
    } else if (action === 'call') {
      const pay = Math.min(toCall, p.chips);
      p.chips -= pay; p.betThisStreet += pay; p.totalThisHand += pay;
      if (p.chips === 0) p.allIn = true;
      p.hasActed = true;
    } else if (action === 'raise') {
      const raiseTo = Math.max(this.amountToCall + this.minRaiseSize, amount || 0);
      const needed = Math.min(raiseTo - p.betThisStreet, p.chips);
      const newBet = p.betThisStreet + needed;
      const raiseSize = newBet - this.amountToCall;
      p.chips -= needed; p.betThisStreet = newBet; p.totalThisHand += needed;
      if (p.chips === 0) p.allIn = true;
      if (newBet > this.amountToCall) {
        this.amountToCall = newBet;
        if (raiseSize > 0) this.minRaiseSize = raiseSize;
        this.players.forEach((other) => {
          if (other.id !== p.id && !other.folded && !other.allIn && !other.bustedOut) other.hasActed = false;
        });
      }
      p.hasActed = true;
    } else {
      return { ok: false, error: 'unknown_action' };
    }

    if (this.inHandPlayers().length <= 1) { this._awardUncontested(); return { ok: true }; }

    this._advanceTurn();
    return { ok: true };
  }

  _advanceTurn() {
    if (this._bettingRoundComplete()) { this._endBettingRound(); return; }
    this.currentSeat = this._nextActingSeatFrom(this.currentSeat);
    this._advanceIfNoActionPossible();
  }

  _advanceIfNoActionPossible() {
    if (this.canActPlayers().length === 0) { this._endBettingRound(); return; }
    if (this.canActPlayers().length === 1 && this.canActPlayers()[0].hasActed &&
      this.canActPlayers()[0].betThisStreet === this.amountToCall) { this._endBettingRound(); return; }
  }

  _bettingRoundComplete() {
    const acting = this.canActPlayers();
    if (acting.length === 0) return true;
    return acting.every((p) => p.hasActed && p.betThisStreet === this.amountToCall);
  }

  _collectStreetBets() {
    // Move this street's bets into the running pot total. Side-pot splitting
    // at showdown is computed separately from each player's totalThisHand,
    // so this is purely to keep the displayed/tracked pot total accurate.
    this.pot += this._liveBetsSum();
    this.players.forEach((p) => { p.betThisStreet = 0; });
  }

  _endBettingRound() {
    this._collectStreetBets();
    if (this.phase === 'preflop') this._dealStreet('flop', 3);
    else if (this.phase === 'flop') this._dealStreet('turn', 1);
    else if (this.phase === 'turn') this._dealStreet('river', 1);
    else if (this.phase === 'river') this._goToShowdown();
  }

  _dealStreet(name, count) {
    this.deck.pop(); // burn
    for (let i = 0; i < count; i++) this.community.push(this.deck.pop());
    this.phase = name;
    this.players.forEach((p) => { p.hasActed = false; });
    this.amountToCall = 0;
    this.minRaiseSize = this.bigBlind;
    const stillCanAct = this.canActPlayers();
    if (stillCanAct.length <= 1) {
      // everyone (or all but one) is all-in — run it out with no more betting
      if (this.phase === 'river') { this._goToShowdown(); } else { this._endBettingRound(); }
      return;
    }
    this.currentSeat = this._nextActingSeatFrom(this.dealerSeat);
  }

  _computeSidePots() {
    const contributors = this.inHandPlayersAndFolded().filter((p) => p.totalThisHand > 0);
    const levels = [...new Set(contributors.map((p) => p.totalThisHand))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      const delta = level - prev;
      const atLevel = contributors.filter((p) => p.totalThisHand >= level);
      const amount = delta * atLevel.length;
      if (amount > 0) {
        const eligibleIds = atLevel.filter((p) => !p.folded).map((p) => p.id);
        pots.push({ amount, eligibleIds });
      }
      prev = level;
    }
    return pots;
  }

  inHandPlayersAndFolded() { return this.players.filter((p) => !p.bustedOut); }

  _awardUncontested() {
    const winner = this.inHandPlayers()[0];
    const total = this.activePlayers().reduce((s, p) => s + p.totalThisHand, 0);
    if (winner) winner.chips += total;
    this.lastHandSummary = {
      showdown: false,
      pots: [{ amount: total, winners: winner ? [{ id: winner.id, amount: total }] : [] }],
      revealed: [],
    };
    this.pot = 0;
    this.players.forEach((p) => { p.betThisStreet = 0; });
    this.phase = 'handover';
    this._checkBustouts();
  }

  _goToShowdown() {
    this.phase = 'showdown';
    const pots = this._computeSidePots();
    const contenders = this.inHandPlayers();
    const results = [];
    for (const pot of pots) {
      const eligible = contenders.filter((p) => pot.eligibleIds.includes(p.id));
      if (eligible.length === 0) continue;
      let bestVal = null;
      let winners = [];
      for (const p of eligible) {
        const val = bestHandOf7([...p.holeCards, ...this.community]);
        p._handValue = val;
        if (!bestVal || compareHandValues(val, bestVal) > 0) { bestVal = val; winners = [p]; }
        else if (compareHandValues(val, bestVal) === 0) winners.push(p);
      }
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      const winnerInfo = winners.map((w) => {
        let amt = share;
        if (remainder > 0) { amt += 1; remainder -= 1; }
        w.chips += amt;
        return { id: w.id, amount: amt, handRank: HAND_NAMES[w._handValue[0]] };
      });
      results.push({ amount: pot.amount, winners: winnerInfo });
    }
    this.lastHandSummary = {
      showdown: true,
      pots: results,
      revealed: contenders.map((p) => ({ id: p.id, cards: p.holeCards, handRank: p._handValue ? HAND_NAMES[p._handValue[0]] : null })),
    };
    this.pot = 0;
    this.players.forEach((p) => { p.betThisStreet = 0; });
    this.phase = 'handover';
    this._checkBustouts();
  }

  _checkBustouts() {
    this.players.forEach((p) => {
      if (!p.bustedOut && p.chips <= 0) {
        p.bustedOut = true;
        // Clear this hand's contribution so it can never leak into a later
        // hand's pot math (e.g. an uncontested-fold award summing everyone).
        p.totalThisHand = 0;
      }
    });
    const remaining = this.activePlayers();
    if (remaining.length <= 1) {
      this.phase = 'gameover';
      this.winnerId = remaining[0] ? remaining[0].id : null;
    }
  }

  /** Per-recipient view: hides other players' hole cards unless revealed at showdown. */
  viewFor(recipientId) {
    const revealedIds = this.lastHandSummary && this.lastHandSummary.showdown
      ? new Set(this.lastHandSummary.revealed.map((r) => r.id)) : new Set();
    return {
      phase: this.phase,
      handNumber: this.handNumber,
      community: this.community,
      pot: this.totalPotAmount(),
      currentSeat: this.currentSeat,
      amountToCall: this.amountToCall,
      minRaiseSize: this.minRaiseSize,
      dealerSeat: this.dealerSeat,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      winnerId: this.winnerId,
      lastHandSummary: this.lastHandSummary,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, seat: p.seat, chips: p.chips,
        folded: p.folded, allIn: p.allIn, betThisStreet: p.betThisStreet,
        bustedOut: p.bustedOut,
        holeCards: p.id === recipientId || revealedIds.has(p.id) ? p.holeCards : (p.holeCards.length ? [null, null] : []),
      })),
    };
  }
}

const PokerCore = { PokerEngine, evaluate5, bestHandOf7, compareHandValues, freshDeck, shuffle, rankLabel, HAND_NAMES };
if (typeof window !== 'undefined') window.PokerCore = PokerCore;
