const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const rooms = new Map();
const roomCodes = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = ''; for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]; }
  while (roomCodes.has(code));
  return code;
}

class Tournament {
  constructor(players, settings = {}) {
    this.players = players;
    this.settings = settings;
    this.useDecimal = settings.useDecimal !== false;
    this.playerCount = players.length;
    this.step = 1;
    this.currentMatch = null;
    this.currentPlayers = [];
    this.targetTime = 0;
    this.playerResults = {};
    this.timerStarted = false;
    this.timerStartTime = null;
    this.allPlayers = players;
    this.champion = null;
    this.roundName = '';
    this.waitingPlayer = null;
    this.match1 = { winner: null, loser: null };
    this.match2 = { winner: null, loser: null };
    this.match3 = { winner: null, loser: null };
    this.match4 = { winner: null, loser: null };
    this.currentMatchIndex = 0;
    this.bracket = null;
    if (this.playerCount === 4) this.bracket = { type: '4players', round1: [], final: null, loserFinal: null, superFinal: null };
    else if (this.playerCount > 4) { this.bracket = { type: 'elimination', rounds: [], currentRound: 0 }; this.buildEliminationRounds(); }
  }

  buildEliminationRounds() {
    let remaining = [...this.players], roundNum = 1;
    while (remaining.length > 1) {
      let sh = [...remaining].sort(() => Math.random() - 0.5), matches = [], winners = [];
      while (sh.length >= 2) matches.push({ player1: sh.shift(), player2: sh.shift(), winner: null, loser: null });
      if (sh.length === 1) winners.push(sh[0]);
      this.bracket.rounds.push({ number: roundNum, matches, winners });
      remaining = []; roundNum++;
    }
  }

  generateTargetTime() {
    const min = (this.settings.timerMin || 5) * 1000, max = (this.settings.timerMax || 20) * 1000;
    return this.useDecimal ? Math.floor(Math.random() * (max - min)) + min : (Math.floor(Math.random() * (Math.floor(max/1000) - Math.ceil(min/1000) + 1)) + Math.ceil(min/1000)) * 1000;
  }

  start() { return this.playerCount === 3 ? this.start3P() : this.startMP(); }

  start3P() {
    const sh = [...this.players].sort(() => Math.random() - 0.5);
    this.currentMatch = { player1: sh[0], player2: sh[1], type: '1. MAÇ' };
    this.currentPlayers = [sh[0], sh[1]]; this.waitingPlayer = sh[2];
    this.targetTime = this.generateTargetTime(); this.timerStarted = false; this.playerResults = {};
    this.roundName = '1. MAÇ'; return this.getState();
  }

  startMP() {
    if (this.playerCount === 4) {
      const sh = [...this.players].sort(() => Math.random() - 0.5);
      this.bracket.round1 = [{ player1: sh[0], player2: sh[1], winner: null, loser: null }, { player1: sh[2], player2: sh[3], winner: null, loser: null }];
      this.currentMatchIndex = 0; this.currentMatch = { player1: sh[0], player2: sh[1], type: 'YARI FİNAL 1' };
      this.currentPlayers = [sh[0], sh[1]]; this.roundName = 'YARI FİNAL 1';
    } else {
      const fr = this.bracket.rounds[0];
      if (fr.matches.length > 0) {
        const m = fr.matches[0];
        this.currentMatch = { player1: m.player1, player2: m.player2, type: 'TUR 1 - MAÇ 1' };
        this.currentPlayers = [m.player1, m.player2]; this.currentMatchIndex = 0; this.roundName = '1. TUR';
      }
    }
    this.targetTime = this.generateTargetTime(); this.timerStarted = false; this.playerResults = {};
    return this.getState();
  }

  startTimer() { this.timerStarted = true; this.timerStartTime = Date.now(); }

  recordResult(playerId, stopTime) {
    if (!this.timerStarted || this.playerResults[playerId]) return null;
    this.playerResults[playerId] = { elapsed: stopTime - this.timerStartTime, difference: Math.abs(stopTime - this.timerStartTime - this.targetTime) };
    if (Object.keys(this.playerResults).length >= 2) return this.determineWinner();
    return null;
  }

  determineWinner() {
    const [p1, p2] = Object.keys(this.playerResults);
    if (this.playerResults[p1].difference !== this.playerResults[p2].difference) {
      const w = this.playerResults[p1].difference < this.playerResults[p2].difference ? p1 : p2;
      return { winner: w, loser: w === p1 ? p2 : p1, results: this.playerResults };
    }
    const w = this.playerResults[p1].elapsed < this.playerResults[p2].elapsed ? p1 : p2;
    return { winner: w, loser: w === p1 ? p2 : p1, results: this.playerResults, tieBreak: true };
  }

  advanceRound(winner, loser) {
    if (this.playerCount === 3) return this.adv3(winner, loser);
    if (this.playerCount === 4) return this.adv4(winner, loser);
    return this.advMP(winner, loser);
  }

  adv3(winner, loser) {
    if (this.step === 1) { this.match1 = { winner, loser }; this.step = 2; this.currentMatch = { player1: loser, player2: this.waitingPlayer, type: '2. MAÇ' }; this.currentPlayers = [loser, this.waitingPlayer]; this.waitingPlayer = null; this.roundName = '2. MAÇ'; }
    else if (this.step === 2) { this.match2 = { winner, loser }; this.step = 3; this.currentMatch = { player1: this.match1.winner, player2: winner, type: '3. MAÇ (Ara Final)' }; this.currentPlayers = [this.match1.winner, winner]; this.roundName = 'ARA FİNAL'; }
    else if (this.step === 3) { this.match3 = { winner, loser }; this.step = 4; this.currentMatch = { player1: this.match2.loser, player2: loser, type: '4. MAÇ (Kaybedenler Finali)' }; this.currentPlayers = [this.match2.loser, loser]; this.roundName = 'KAYBEDENLER FİNALİ'; }
    else if (this.step === 4) { this.match4 = { winner, loser }; this.step = 5; this.currentMatch = { player1: this.match3.winner, player2: winner, type: '⭐ 5. MAÇ (SÜPER FİNAL)' }; this.currentPlayers = [this.match3.winner, winner]; this.roundName = 'SÜPER FİNAL'; }
    else { this.champion = winner; return { champion: winner }; }
    this.targetTime = this.generateTargetTime(); this.timerStarted = false; this.playerResults = {};
    return this.getState();
  }

  adv4(winner, loser) {
    this.bracket.round1[this.currentMatchIndex].winner = winner;
    this.bracket.round1[this.currentMatchIndex].loser = loser;
    if (this.currentMatchIndex === 0) {
      this.currentMatchIndex = 1;
      const m = this.bracket.round1[1];
      this.currentMatch = { player1: m.player1, player2: m.player2, type: 'YARI FİNAL 2' };
      this.currentPlayers = [m.player1, m.player2]; this.roundName = 'YARI FİNAL 2';
    } else {
      const f1 = this.bracket.round1[0].winner, f2 = this.bracket.round1[1].winner;
      const l1 = this.bracket.round1[0].loser, l2 = this.bracket.round1[1].loser;
      if (!this.bracket.final) {
        this.bracket.final = { player1: f1, player2: f2, winner: null, loser: null };
        this.currentMatch = { player1: f1, player2: f2, type: '🏆 FİNAL' };
        this.currentPlayers = [f1, f2]; this.roundName = 'FİNAL';
      } else if (!this.bracket.loserFinal) {
        this.bracket.final.winner = winner; this.bracket.final.loser = loser;
        this.bracket.loserFinal = { player1: l1, player2: l2, winner: null };
        this.currentMatch = { player1: l1, player2: l2, type: '🥉 KAYBEDENLER FİNALİ' };
        this.currentPlayers = [l1, l2]; this.roundName = 'KAYBEDENLER FİNALİ';
      } else {
        this.bracket.loserFinal.winner = winner;
        this.currentMatch = { player1: this.bracket.final.winner, player2: winner, type: '⭐ SÜPER FİNAL' };
        this.currentPlayers = [this.bracket.final.winner, winner]; this.roundName = 'SÜPER FİNAL'; this.step = 99;
      }
    }
    this.targetTime = this.generateTargetTime(); this.timerStarted = false; this.playerResults = {};
    return this.getState();
  }

  advMP(winner, loser) {
    const cr = this.bracket.rounds[this.bracket.currentRound];
    if (cr && this.currentMatchIndex < cr.matches.length) { cr.matches[this.currentMatchIndex].winner = winner; cr.matches[this.currentMatchIndex].loser = loser; }
    this.currentMatchIndex++;
    if (cr && this.currentMatchIndex < cr.matches.length) {
      const nm = cr.matches[this.currentMatchIndex];
      this.currentMatch = { player1: nm.player1, player2: nm.player2, type: `TUR ${cr.number} - MAÇ ${this.currentMatchIndex+1}` };
      this.currentPlayers = [nm.player1, nm.player2]; this.roundName = `${cr.number}. TUR`;
    } else {
      let winners = cr.winners || []; cr.matches.forEach(m => { if (m.winner) winners.push(m.winner); });
      this.bracket.currentRound++;
      if (winners.length === 1) { this.champion = winners[0]; return { champion: winners[0] }; }
      if (winners.length === 2) {
        this.currentMatch = { player1: winners[0], player2: winners[1], type: '🏆 FİNAL' };
        this.currentPlayers = winners; this.roundName = 'FİNAL'; this.step = 98;
      } else {
        const nr = { number: this.bracket.currentRound + 1, matches: [], winners: [] };
        let sh = [...winners].sort(() => Math.random() - 0.5);
        while (sh.length >= 2) nr.matches.push({ player1: sh.shift(), player2: sh.shift(), winner: null, loser: null });
        if (sh.length === 1) nr.winners.push(sh[0]);
        this.bracket.rounds.push(nr); this.currentMatchIndex = 0;
        if (nr.matches.length > 0) {
          const m = nr.matches[0];
          this.currentMatch = { player1: m.player1, player2: m.player2, type: `TUR ${nr.number} - MAÇ 1` };
          this.currentPlayers = [m.player1, m.player2]; this.roundName = `${nr.number}. TUR`;
        }
      }
    }
    this.targetTime = this.generateTargetTime(); this.timerStarted = false; this.playerResults = {};
    return this.getState();
  }

  getState() {
    return { step: this.step, playerCount: this.playerCount, currentMatch: this.currentMatch, waitingPlayer: this.waitingPlayer, currentPlayers: this.currentPlayers, targetTime: this.targetTime, timerStarted: this.timerStarted, match1: this.match1, match2: this.match2, match3: this.match3, match4: this.match4, champion: this.champion, allPlayers: this.allPlayers, useDecimal: this.useDecimal, roundName: this.roundName };
  }
}

io.on('connection', (socket) => {
  console.log('Bağlantı:', socket.id);
  let currentRoom = null, playerName = null, trainingMode = false, trainingSettings = {};

  socket.on('createRoom', (data) => {
    const { playerName: name, settings = {} } = data;
    const code = generateRoomCode();
    const room = { code, host: socket.id, hostName: name, players: new Map(), tournament: null, settings: { maxPlayers: settings.maxPlayers || 10, useDecimal: settings.useDecimal !== false, timerMin: settings.timerMin || 5, timerMax: settings.timerMax || 20 }, champions: [], chatMessages: [], gameHistory: [] };
    room.players.set(socket.id, { id: socket.id, name, isHost: true });
    rooms.set(code, room); roomCodes.set(code, code);
    socket.join(code); currentRoom = code; playerName = name;
    socket.emit('roomCreated', { code, players: getPlayers(room), settings: room.settings, champions: room.champions, gameHistory: room.gameHistory });
    console.log(`✅ Oda: ${code} - ${name}`);
  });

  socket.on('joinRoom', (data) => {
    const { code, playerName: name } = data;
    const room = rooms.get(code.toUpperCase());
    if (!room) { socket.emit('error', 'Oda bulunamadı!'); return; }
    if (room.players.size >= room.settings.maxPlayers) { socket.emit('error', 'Oda dolu!'); return; }
    if (room.tournament && room.tournament.step > 0 && !room.tournament.champion) { socket.emit('error', 'Turnuva devam ediyor!'); return; }
    room.players.set(socket.id, { id: socket.id, name, isHost: false });
    socket.join(code); currentRoom = code; playerName = name;
    io.to(code).emit('playerJoined', getPlayers(room));
    socket.emit('joinSuccess', { code, players: getPlayers(room), settings: room.settings, champions: room.champions, gameHistory: room.gameHistory });
    console.log(`👤 ${name} katıldı: ${code}`);
  });

  socket.on('kickPlayer', (data) => {
    const room = rooms.get(currentRoom);
    if (!room || room.host !== socket.id) return;
    const ts = io.sockets.sockets.get(data.playerId);
    if (ts) { ts.leave(currentRoom); room.players.delete(data.playerId); ts.emit('kicked'); io.to(currentRoom).emit('playerKicked', getPlayers(room)); }
  });

  socket.on('startTournament', () => {
    const room = rooms.get(currentRoom);
    if (!room || room.host !== socket.id) return;
    const arr = Array.from(room.players.values()).map(p => p.name);
    if (arr.length < 3) { socket.emit('error', 'En az 3 oyuncu!'); return; }
    room.tournament = new Tournament(arr, room.settings);
    const state = room.tournament.start();
    io.to(currentRoom).emit('tournamentStarted', state);
    console.log(`🏆 Turnuva: ${currentRoom} (${arr.length} kişi)`);
  });

  socket.on('startCountdown', () => {
    const room = rooms.get(currentRoom);
    if (!room || !room.tournament || room.host !== socket.id) return;
    let count = 3;
    io.to(currentRoom).emit('countdown', { count });
    const ci = setInterval(() => {
      count--;
      if (count > 0) { io.to(currentRoom).emit('countdown', { count }); }
      else {
        clearInterval(ci);
        io.to(currentRoom).emit('countdown', { count: 'BAŞLA!' });
        room.tournament.startTimer();
        io.to(currentRoom).emit('timerStarted', { startTime: room.tournament.timerStartTime, targetTime: room.tournament.targetTime });
      }
    }, 1000);
  });

  socket.on('stopTimer', (data) => {
    const room = rooms.get(currentRoom);
    if (!room || !room.tournament) return;
    const result = room.tournament.recordResult(playerName, data.stopTime);
    if (result) {
      io.to(currentRoom).emit('roundResult', result);
      setTimeout(() => {
        const next = room.tournament.advanceRound(result.winner, result.loser);
        if (next && next.champion) {
          room.champions.push({ name: next.champion, date: new Date().toLocaleString('tr-TR') });
          room.gameHistory.push({ champion: next.champion, players: room.tournament.allPlayers, date: new Date().toISOString() });
          room.tournament = null;
          io.to(currentRoom).emit('tournamentEnd', { champion: next.champion, champions: room.champions, players: getPlayers(room), gameHistory: room.gameHistory });
        } else { io.to(currentRoom).emit('nextRound', next); }
      }, 3000);
    } else { socket.emit('waitingForOpponent'); }
  });

  socket.on('forceEndTournament', () => {
    const room = rooms.get(currentRoom);
    if (!room || room.host !== socket.id) return;
    if (room.tournament) room.tournament = null;
    io.to(currentRoom).emit('tournamentForceEnd', { message: 'Oyun sonlandırıldı!', players: getPlayers(room), champions: room.champions, gameHistory: room.gameHistory });
  });

  socket.on('startTraining', (settings) => {
    trainingMode = true; trainingSettings = settings;
    socket.emit('trainingStarted', { targetTime: Math.floor(Math.random() * (settings.timerMax - settings.timerMin + 1) + settings.timerMin) * 1000, useDecimal: settings.useDecimal });
  });

  socket.on('startTrainingCountdown', () => {
    if (!trainingMode) return;
    let count = 3; socket.emit('trainingCountdown', { count });
    const ci = setInterval(() => {
      count--;
      if (count > 0) socket.emit('trainingCountdown', { count });
      else { clearInterval(ci); socket.emit('trainingCountdown', { count: 'BAŞLA!' }); socket.emit('trainingTimerStarted', { startTime: Date.now() }); }
    }, 1000);
  });

  socket.on('stopTraining', (data) => {
    if (!trainingMode) return;
    const elapsed = data.stopTime - data.startTime, diff = Math.abs(elapsed - data.targetTime), pct = (diff / data.targetTime) * 100;
    let rating, emoji, color;
    if (pct < 1) { rating = 'MÜKEMMEL! 🎯'; emoji = '🌟🌟🌟'; color = '#ffd700'; }
    else if (pct < 3) { rating = 'Harika! 👏'; emoji = '🌟🌟'; color = '#4ade80'; }
    else if (pct < 5) { rating = 'Çok İyi! 👍'; emoji = '🌟'; color = '#60a5fa'; }
    else if (pct < 10) { rating = 'İyi! 🙂'; emoji = '✨'; color = '#a78bfa'; }
    else if (pct < 20) { rating = 'İdare Eder 🤔'; emoji = '💪'; color = '#f59e0b'; }
    else if (pct < 30) { rating = 'Geliştirilebilir 📈'; emoji = '🎯'; color = '#f97316'; }
    else { rating = 'Daha Çok Pratik! 🏋️'; emoji = '💪'; color = '#ef4444'; }
    socket.emit('trainingResult', { elapsed, difference: diff, targetTime: data.targetTime, rating, emoji, color, percentage: pct.toFixed(1) });
    setTimeout(() => { if (trainingMode) socket.emit('trainingNewRound', { targetTime: Math.floor(Math.random() * (trainingSettings.timerMax - trainingSettings.timerMin + 1) + trainingSettings.timerMin) * 1000, useDecimal: trainingSettings.useDecimal }); }, 2500);
  });

  socket.on('stopTrainingMode', () => { trainingMode = false; });

  socket.on('sendMessage', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    const msg = { player: playerName, message: data.message };
    if (room) { room.chatMessages.push(msg); if (room.chatMessages.length > 100) room.chatMessages.shift(); }
    io.to(currentRoom).emit('newMessage', msg);
  });

  socket.on('ping-check', (data) => { socket.emit('pong-check', { clientTime: data.clientTime }); });

  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom), wasHost = room.host === socket.id;
      room.players.delete(socket.id);
      if (room.players.size === 0 || wasHost) { io.to(currentRoom).emit('roomClosed', { message: wasHost ? 'Oda sahibi ayrıldı!' : 'Oda kapatıldı!' }); rooms.delete(currentRoom); roomCodes.delete(currentRoom); }
      else io.to(currentRoom).emit('playerLeft', getPlayers(room));
    }
    trainingMode = false;
  });
});

function getPlayers(room) { return Array.from(room.players.values()); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🏆 Turnuva v4.0 - Port: ${PORT}`));
