/* Wires the poker engine/network to the DOM: lobby flow, table rendering,
   betting controls. */

const PNAME_KEY = 'poker_player_name';
const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED_SUITS = { H: true, D: true };

function cardEl(card) {
  const el = document.createElement('div');
  if (!card) {
    el.className = 'pcard back';
    return el;
  }
  el.className = 'pcard ' + (RED_SUITS[card.suit] ? 'red' : 'black');
  const corner = document.createElement('div');
  corner.className = 'corner';
  corner.textContent = PokerCore.rankLabel(card.rank) + SUIT_SYMBOL[card.suit];
  const rank = document.createElement('div');
  rank.textContent = PokerCore.rankLabel(card.rank);
  const suit = document.createElement('div');
  suit.className = 'suit-sym';
  suit.textContent = SUIT_SYMBOL[card.suit];
  el.appendChild(corner);
  el.appendChild(rank);
  el.appendChild(suit);
  return el;
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

  const nameInput = el('input-name');
  nameInput.value = localStorage.getItem(PNAME_KEY) || '';
  function playerName() {
    const v = nameInput.value.trim().slice(0, 16) || ('Player' + Math.floor(Math.random() * 900 + 100));
    localStorage.setItem(PNAME_KEY, v);
    return v;
  }

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

  let room = null;
  let lastView = null;
  let lastHandKeyShown = null;

  function withBusy(button, busyText, fn) {
    return async (...args) => {
      const original = button.textContent;
      button.disabled = true;
      button.textContent = busyText;
      try { await fn(...args); } finally { button.disabled = false; button.textContent = original; }
    };
  }

  el('btn-create-room').onclick = withBusy(el('btn-create-room'), 'Connecting…', async () => {
    const name = playerName();
    setOnlineError('');
    const r = new PokerNetwork.PokerRoom();
    wireRoomEvents(r);
    try {
      const code = await r.createRoom(name);
      room = r;
      el('lobby-code').textContent = code;
      el('btn-start-game').hidden = false;
      el('starting-chips-field').hidden = false;
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
    const r = new PokerNetwork.PokerRoom();
    wireRoomEvents(r);
    try {
      await r.joinRoom(code, name);
      room = r;
      el('lobby-code').textContent = room.code;
      el('btn-start-game').hidden = true;
      el('starting-chips-field').hidden = true;
      el('waiting-hint').hidden = false;
      renderRoster(r._rosterArray());
      showScreen('lobby');
    } catch (err) {
      setOnlineError(err.message || 'Could not join room.');
    }
  });

  el('btn-copy-code').onclick = () => {
    const code = el('lobby-code').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
  };

  el('btn-leave-lobby').onclick = () => { if (room) room.leave(); room = null; showScreen('menu'); };
  el('btn-start-game').onclick = () => {
    if (!room) return;
    const chips = parseInt(el('starting-chips').value, 10) || 500;
    room.startGame(chips);
  };

  function wireRoomEvents(r) {
    r.addEventListener('roster', (e) => renderRoster(e.detail.players));
    r.addEventListener('game-start', () => { showScreen('table'); });
    r.addEventListener('table-state', (e) => renderTable(e.detail));
    r.addEventListener('game-over', (e) => showGameOver(e.detail));
    r.addEventListener('error', (e) => setOnlineError(e.detail.message));
    r.addEventListener('host-left', () => {
      room = null;
      alert('The host left the table.');
      showScreen('menu');
    });
  }

  function renderRoster(players) {
    const list = el('roster-list');
    list.innerHTML = '';
    players.forEach((p) => {
      const li = document.createElement('li');
      const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = p.color;
      const label = document.createElement('span'); label.textContent = p.name + (p.isHost ? ' (host)' : '');
      li.appendChild(dot); li.appendChild(label);
      if (room && p.id === room.selfId) {
        const you = document.createElement('span'); you.className = 'you'; you.textContent = 'you';
        li.appendChild(you);
      }
      list.appendChild(li);
    });
  }

  // ---- table rendering ----
  function seatPositionClass(relativeIndex) {
    return 'seat-pos-' + Math.min(relativeIndex, 5);
  }

  function renderTable(view) {
    lastView = view;
    const myId = room ? room.selfId : null;
    const me = view.players.find((p) => p.id === myId);
    const n = view.players.length;
    const mySeat = me ? me.seat : 0;

    el('pot-readout').textContent = 'Pot: ' + view.pot;
    el('blinds-readout').textContent = `Blinds ${view.smallBlind}/${view.bigBlind}`;

    const community = el('community-row');
    community.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const c = view.community[i];
      const d = c ? cardEl(c) : (() => { const ph = document.createElement('div'); ph.className = 'pcard placeholder'; return ph; })();
      community.appendChild(d);
    }

    const seatsContainer = el('seats');
    seatsContainer.innerHTML = '';
    view.players.forEach((p) => {
      if (p.id === myId) return; // rendered separately in the fixed "my area"
      const rel = ((p.seat - mySeat) % n + n) % n;
      const seat = document.createElement('div');
      seat.className = 'seat ' + seatPositionClass(rel);
      if (p.folded) seat.classList.add('folded');
      if (p.bustedOut) seat.classList.add('busted');
      if (view.currentSeat === p.seat && view.phase !== 'handover' && view.phase !== 'gameover') seat.classList.add('turn');
      if (p.seat === view.dealerSeat) seat.classList.add('dealer');

      const card = document.createElement('div');
      card.className = 'seat-card';
      if (p.seat === view.dealerSeat) {
        const dchip = document.createElement('div'); dchip.className = 'dealer-chip'; dchip.textContent = 'D';
        card.appendChild(dchip);
      }
      const nameEl = document.createElement('div'); nameEl.className = 'seat-name'; nameEl.textContent = p.name || 'Player';
      const chipsEl = document.createElement('div'); chipsEl.className = 'seat-chips'; chipsEl.textContent = p.chips;
      card.appendChild(nameEl); card.appendChild(chipsEl);

      if (p.holeCards && p.holeCards.length) {
        const cardsRow = document.createElement('div'); cardsRow.className = 'seat-cards';
        p.holeCards.forEach((c) => cardsRow.appendChild(cardEl(c)));
        card.appendChild(cardsRow);
      }
      if (p.betThisStreet > 0) {
        const bet = document.createElement('div'); bet.className = 'seat-bet';
        const dot = document.createElement('span'); dot.className = 'chip-dot';
        bet.appendChild(dot);
        bet.appendChild(document.createTextNode(p.betThisStreet));
        card.appendChild(bet);
      }
      if (p.bustedOut) { const b = document.createElement('div'); b.className = 'seat-name'; b.textContent = 'OUT'; card.appendChild(b); }
      else if (p.allIn) { const b = document.createElement('div'); b.className = 'seat-name'; b.textContent = 'ALL IN'; card.appendChild(b); }
      else if (p.folded) { const b = document.createElement('div'); b.className = 'seat-name'; b.textContent = 'FOLDED'; card.appendChild(b); }

      seat.appendChild(card);
      seatsContainer.appendChild(seat);
    });

    // my own area
    el('my-name').textContent = me ? (me.name || 'You') : 'You';
    el('my-chips').textContent = me ? me.chips : 0;
    const myCards = el('my-cards');
    myCards.innerHTML = '';
    if (me && me.holeCards) me.holeCards.forEach((c) => myCards.appendChild(cardEl(c)));
    if (me && me.betThisStreet > 0) {
      const bet = document.createElement('div'); bet.className = 'seat-bet';
      const dot = document.createElement('span'); dot.className = 'chip-dot';
      bet.appendChild(dot); bet.appendChild(document.createTextNode(me.betThisStreet));
      myCards.appendChild(bet);
    }

    renderHandBanner(view);
    renderActionBar(view, me);
    renderNextHandButton(view);
  }

  function renderHandBanner(view) {
    const banner = el('hand-banner');
    const summary = view.lastHandSummary;
    const key = view.handNumber + ':' + (summary ? JSON.stringify(summary.pots) : '');
    if (!summary || (view.phase !== 'handover' && view.phase !== 'gameover')) { banner.hidden = true; return; }
    const lines = summary.pots.map((pot) => {
      const names = pot.winners.map((w) => {
        const p = view.players.find((pp) => pp.id === w.id);
        const rankTxt = w.handRank ? ` with ${w.handRank}` : '';
        return `<strong>${escapeHtml(p ? p.name : 'Player')}</strong> +${w.amount}${rankTxt}`;
      });
      return names.join(', ');
    });
    banner.innerHTML = lines.join('<br>');
    banner.hidden = false;
  }

  function renderActionBar(view, me) {
    const bar = el('action-bar');
    const isMyTurn = me && !me.bustedOut && !me.folded && view.currentSeat === me.seat &&
      view.phase !== 'handover' && view.phase !== 'gameover';
    bar.hidden = !isMyTurn;
    if (!isMyTurn) return;

    const toCall = view.amountToCall - me.betThisStreet;
    el('btn-check').hidden = toCall > 0;
    el('btn-call').hidden = toCall <= 0;
    if (toCall > 0) el('btn-call').textContent = `Call ${Math.min(toCall, me.chips)}`;

    const canRaise = me.chips > Math.max(0, toCall);
    el('btn-raise').hidden = !canRaise;
    el('raise-row').hidden = !canRaise;
    if (canRaise) {
      const minTo = Math.min(view.amountToCall + view.minRaiseSize, me.betThisStreet + me.chips);
      const maxTo = me.betThisStreet + me.chips;
      const slider = el('raise-slider');
      slider.min = minTo; slider.max = maxTo;
      if (Number(slider.value) < minTo || Number(slider.value) > maxTo || slider.dataset.lastSeat !== String(me.seat) + view.handNumber) {
        slider.value = minTo;
        slider.dataset.lastSeat = String(me.seat) + view.handNumber;
      }
      el('raise-amount').textContent = slider.value;
      el('btn-raise').textContent = Number(slider.value) >= maxTo ? 'All In' : ('Raise to ' + slider.value);
    }
  }

  el('raise-slider').addEventListener('input', () => {
    el('raise-amount').textContent = el('raise-slider').value;
    const max = Number(el('raise-slider').max);
    el('btn-raise').textContent = Number(el('raise-slider').value) >= max ? 'All In' : ('Raise to ' + el('raise-slider').value);
  });

  el('btn-fold').onclick = () => room && room.sendAction('fold');
  el('btn-check').onclick = () => room && room.sendAction('check');
  el('btn-call').onclick = () => room && room.sendAction('call');
  el('btn-raise').onclick = () => room && room.sendAction('raise', Number(el('raise-slider').value));

  function renderNextHandButton(view) {
    const btn = el('btn-next-hand');
    const show = room && room.isHost && view.phase === 'handover';
    btn.hidden = !show;
  }
  el('btn-next-hand').onclick = () => { if (room) room.nextHand(); };

  function showGameOver(detail) {
    const table = el('results-table');
    const tbody = table.querySelector('tbody');
    tbody.innerHTML = '';
    detail.results.forEach((r, i) => {
      const tr = document.createElement('tr');
      if (r.id === detail.winnerId) tr.classList.add('winner');
      const youTag = room && r.id === room.selfId ? ' <span class="you-tag">(you)</span>' : '';
      tr.innerHTML = `<td class="rank">${r.id === detail.winnerId ? '\u{1F3C6}' : '#' + (i + 1)}</td>` +
        `<td>${escapeHtml(r.name)}${youTag}</td><td class="score-col">${r.chips}</td>`;
      tbody.appendChild(tr);
    });
    showScreen('gameover');
  }
})();
