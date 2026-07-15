const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { 
    origin: "*", 
    methods: ["GET", "POST"] 
  },
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
  res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

const rooms = new Map();
const roomCodes = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (roomCodes.has(code));
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
    
    if (this.playerCount === 4) {
      this.bracket = { type: '4players', round1: [], final: null, loserFinal: null, superFinal: null };
    } else if (this.playerCount > 4) {
      this.bracket = { type: 'elimination', rounds: [], currentRound: 0 };
      this.buildEliminationRounds();
    }
  }

  buildEliminationRounds() {
    let remaining = [...this.players];
    let roundNum = 1;
    while (remaining.length > 1) {
      let shuffled = [...remaining].sort(() => Math.random() - 0.5);
      let roundMatches = [];
      let winners = [];
      while (shuffled.length >= 2) {
        roundMatches.push({ player1: shuffled.shift(), player2: shuffled.shift(), winner: null, loser: null });
      }
      if (shuffled.length === 1) winners.push(shuffled[0]);
      this.bracket.rounds.push({ number: roundNum, matches: roundMatches, winners: winners });
      remaining = [];
      roundNum++;
    }
  }

  generateTargetTime() {
    const min = (this.settings.timerMin || 5) * 1000;
    const max = (this.settings.timerMax || 20) * 1000;
    if (this.useDecimal) {
      return Math.floor(Math.random() * (max - min)) + min;
    } else {
      const minSec = Math.ceil(min / 1000);
      const maxSec = Math.floor(max / 1000);
      return (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000;
    }
  }

  start() {
    return this.playerCount === 3 ? this.start3Player() : this.startMultiPlayer();
  }

  start3Player() {
    const shuffled = [...this.players].sort(() => Math.random() - 0.5);
    this.currentMatch = { player1: shuffled[0], player2: shuffled[1], type: '1. MAÇ', round: 1 };
    this.currentPlayers = [shuffled[0], shuffled[1]];
    this.waitingPlayer = shuffled[2];
    this.targetTime = this.generateTargetTime();
    this.timerStarted = false;
    this.playerResults = {};
    this.roundName = '1. MAÇ';
    return this.getState();
  }

  startMultiPlayer() {
    if (this.playerCount === 4) {
      const shuffled = [...this.players].sort(() => Math.random() - 0.5);
      this.bracket.round1 = [
        { player1: shuffled[0], player2: shuffled[1], winner: null, loser: null },
        { player1: shuffled[2], player2: shuffled[3], winner: null, loser: null }
      ];
      this.currentMatchIndex = 0;
      this.currentMatch = { player1: shuffled[0], player2: shuffled[1], type: 'YARI FİNAL 1', round: 1 };
      this.currentPlayers = [shuffled[0], shuffled[1]];
      this.roundName = 'YARI FİNAL 1';
    } else {
      const firstRound = this.bracket.rounds[0];
      if (firstRound.matches.length > 0) {
        const match = firstRound.matches[0];
        this.currentMatch = { player1: match.player1, player2: match.player2, type: `TUR 1 - MAÇ 1`, round: 1 };
        this.currentPlayers = [match.player1, match.player2];
        this.currentMatchIndex = 0;
        this.roundName = '1. TUR';
      }
    }
    this.targetTime = this.generateTargetTime();
    this.timerStarted = false;
    this.playerResults = {};
    return this.getState();
  }

  startTimer() {
    this.timerStarted = true;
    this.timerStartTime = Date.now();
  }

  recordResult(playerId, stopTime) {
    if (!this.timerStarted) return null;
    if (this.playerResults[playerId]) return null;
    const elapsed = stopTime - this.timerStartTime;
    const difference = Math.abs(elapsed - this.targetTime);
    this.playerResults[playerId] = { elapsed, difference, timestamp: stopTime };
    if (Object.keys(this.playerResults).length >= 2) return this.determineWinner();
    return null;
  }

  determineWinner() {
    const players = Object.keys(this.playerResults);
    const p1 = players[0], p2 = players[1];
    if (this.playerResults[p1].difference !== this.playerResults[p2].difference) {
      const winner = this.playerResults[p1].difference < this.playerResults[p2].difference ? p1 : p2;
      return { winner, loser: winner === p1 ? p2 : p1, results: this.playerResults };
    }
    const winner = this.playerResults[p1].elapsed < this.playerResults[p2].elapsed ? p1 : p2;
    return { winner, loser: winner === p1 ? p2 : p1, results: this.playerResults, tieBreak: true };
  }

  advanceRound(winner, loser) {
    if (this.playerCount === 3) return this.advance3P(winner, loser);
    if (this.playerCount === 4) return this.advance4P(winner, loser);
    return this.advanceMultiP(winner, loser);
  }

  advance3P(winner, loser) {
    if (this.step === 1) {
      this.match1 = { winner, loser };
      this.step = 2;
      this.currentMatch = { player1: loser, player2: this.waitingPlayer, type: '2. MAÇ', round: 2 };
      this.currentPlayers = [loser, this.waitingPlayer];
      this.waitingPlayer = null;
      this.roundName = '2. MAÇ';
    } else if (this.step === 2) {
      this.match2 = { winner, loser };
      this.step = 3;
      this.currentMatch = { player1: this.match1.winner, player2: winner, type: '3. MAÇ (Ara Final)', round: 3 };
      this.currentPlayers = [this.match1.winner, winner];
      this.roundName = 'ARA FİNAL';
    } else if (this.step === 3) {
      this.match3 = { winner, loser };
      this.step = 4;
      this.currentMatch = { player1: this.match2.loser, player2: loser, type: '4. MAÇ (Kaybedenler Finali)', round: 4 };
      this.currentPlayers = [this.match2.loser, loser];
      this.roundName = 'KAYBEDENLER FİNALİ';
    } else if (this.step === 4) {
      this.match4 = { winner, loser };
      this.step = 5;
      this.currentMatch = { player1: this.match3.winner, player2: winner, type: '⭐ 5. MAÇ (SÜPER FİNAL)', round: 5 };
      this.currentPlayers = [this.match3.winner, winner];
      this.roundName = 'SÜPER FİNAL';
    } else if (this.step === 5) {
      this.champion = winner;
      return { champion: winner };
    }
    this.targetTime = this.generateTargetTime();
    this.timerStarted = false;
    this.playerResults = {};
    return this.getState();
  }

  advance4P(winner, loser) {
    const idx = this.currentMatchIndex;
    this.bracket.round1[idx].winner = winner;
    this.bracket.round1[idx].loser = loser;
    
    if (idx === 0) {
      this.currentMatchIndex = 1;
      const m = this.bracket.round1[1];
      this.currentMatch = { player1: m.player1, player2: m.player2, type: 'YARI FİNAL 2', round: 1 };
      this.currentPlayers = [m.player1, m.player2];
      this.roundName = 'YARI FİNAL 2';
    } else {
      const f1 = this.bracket.round1[0].winner, f2 = this.bracket.round1[1].winner;
      const l1 = this.bracket.round1[0].loser, l2 = this.bracket.round1[1].loser;
      
      if (!this.bracket.final) {
        this.bracket.final = { player1: f1, player2: f2, winner: null, loser: null };
        this.currentMatch = { player1: f1, player2: f2, type: '🏆 FİNAL', round: 2 };
        this.currentPlayers = [f1, f2];
        this.roundName = 'FİNAL';
      } else if (!this.bracket.loserFinal) {
        this.bracket.final.winner = winner;
        this.bracket.final.loser = loser;
        this.bracket.loserFinal = { player1: l1, player2: l2, winner: null };
        this.currentMatch = { player1: l1, player2: l2, type: '🥉 KAYBEDENLER FİNALİ', round: 3 };
        this.currentPlayers = [l1, l2];
        this.roundName = 'KAYBEDENLER FİNALİ';
      } else {
        this.bracket.loserFinal.winner = winner;
        this.currentMatch = { player1: this.bracket.final.winner, player2: winner, type: '⭐ SÜPER FİNAL', round: 4 };
        this.currentPlayers = [this.bracket.final.winner, winner];
        this.roundName = 'SÜPER FİNAL';
        this.step = 99;
      }
    }
    this.targetTime = this.generateTargetTime();
    this.timerStarted = false;
    this.playerResults = {};
    return this.getState();
  }

  advanceMultiP(winner, loser) {
    const cr = this.bracket.rounds[this.bracket.currentRound];
    if (cr && this.currentMatchIndex < cr.matches.length) {
      cr.matches[this.currentMatchIndex].winner = winner;
      cr.matches[this.currentMatchIndex].loser = loser;
    }
    this.currentMatchIndex++;
    
    if (cr && this.currentMatchIndex < cr.matches.length) {
      const nm = cr.matches[this.currentMatchIndex];
      this.currentMatch = { player1: nm.player1, player2: nm.player2, type: `TUR ${cr.number} - MAÇ ${this.currentMatchIndex+1}`, round: cr.number };
      this.currentPlayers = [nm.player1, nm.player2];
      this.roundName = `${cr.number}. TUR`;
    } else {
      let winners = cr.winners || [];
      cr.matches.forEach(m => { if (m.winner) winners.push(m.winner); });
      this.bracket.currentRound++;
      
      if (winners.length === 1) { this.champion = winners[0]; return { champion: winners[0] }; }
      if (winners.length === 2) {
        this.currentMatch = { player1: winners[0], player2: winners[1], type: '🏆 FİNAL', round: 999 };
        this.currentPlayers = winners;
        this.roundName = 'FİNAL';
        this.step = 98;
      } else {
        const nr = { number: this.bracket.currentRound + 1, matches: [], winners: [] };
        let sh = [...winners].sort(() => Math.random() - 0.5);
        while (sh.length >= 2) nr.matches.push({ player1: sh.shift(), player2: sh.shift(), winner: null, loser: null });
        if (sh.length === 1) nr.winners.push(sh[0]);
        this.bracket.rounds.push(nr);
        this.currentMatchIndex = 0;
        if (nr.matches.length > 0) {
          const m = nr.matches[0];
          this.currentMatch = { player1: m.player1, player2: m.player2, type: `TUR ${nr.number} - MAÇ 1`, round: nr.number };
          this.currentPlayers = [m.player1, m.player2];
          this.roundName = `${nr.number}. TUR`;
        }
      }
    }
    this.targetTime = this.generateTargetTime();
    this.timerStarted = false;
    this.playerResults = {};
    return this.getState();
  }

  getState() {
    return {
      step: this.step, playerCount: this.playerCount, currentMatch: this.currentMatch,
      waitingPlayer: this.waitingPlayer, currentPlayers: this.currentPlayers,
      targetTime: this.targetTime, timerStarted: this.timerStarted,
      timerStartTime: this.timerStartTime, match1: this.match1, match2: this.match2,
      match3: this.match3, match4: this.match4, champion: this.champion,
      allPlayers: this.allPlayers, useDecimal: this.useDecimal, roundName: this.roundName
    };
  }
}

io.on('connection', (socket) => {
  console.log('Yeni bağlantı:', socket.id);
  let currentRoom = null;
  let playerName = null;
  let trainingMode = false;
  let trainingSettings = {};

  // ODA OLUŞTUR
  socket.on('createRoom', (data) => {
    const { playerName: name, settings = {} } = data;
    const code = generateRoomCode();
    const room = {
      code, host: socket.id, hostName: name,
      players: new Map(), tournament: null, isLocked: false,
      settings: {
        maxPlayers: settings.maxPlayers || 10,
        useDecimal: settings.useDecimal !== false,
        timerMin: settings.timerMin || 5,
        timerMax: settings.timerMax || 20
      },
      champions: [], chatMessages: [], gameHistory: []
    };
    room.players.set(socket.id, { id: socket.id, name, isHost: true });
    rooms.set(code, room);
    roomCodes.set(code, code);
    socket.join(code);
    currentRoom = code;
    playerName = name;
    socket.emit('roomCreated', { code, players: getPlayersList(room), settings: room.settings, champions: room.champions, gameHistory: room.gameHistory });
    console.log(`✅ Oda: ${code} - Host: ${name}`);
  });

  // ODAYA KATIL
  socket.on('joinRoom', (data) => {
    const { code, playerName: name } = data;
    const room = rooms.get(code.toUpperCase());
    if (!room) { socket.emit('error', 'Oda bulunamadı!'); return; }
    if (room.players.size >= room.settings.maxPlayers) { socket.emit('error', `Oda dolu! Maks ${room.settings.maxPlayers}`); return; }
    if (room.tournament && room.tournament.step > 0 && !room.tournament.champion) { socket.emit('error', 'Turnuva devam ediyor!'); return; }
    room.players.set(socket.id, { id: socket.id, name, isHost: false });
    socket.join(code);
    currentRoom = code;
    playerName = name;
    io.to(code).emit('playerJoined', getPlayersList(room));
    socket.emit('joinSuccess', { code, players: getPlayersList(room), settings: room.settings, champions: room.champions, gameHistory: room.gameHistory });
    console.log(`👤 ${name} katıldı: ${code}`);
  });

  // OYUNCU AT
  socket.on('kickPlayer', (data) => {
    const room = rooms.get(currentRoom);
    if (!room || room.host !== socket.id) return;
    const ts = io.sockets.sockets.get(data.playerId);
    if (ts) { ts.leave(currentRoom); room.players.delete(data.playerId); ts.emit('kicked'); io.to(currentRoom).emit('playerKicked', getPlayersList(room)); }
  });

  // TURNUVA BAŞLAT
  socket.on('startTournament', () => {
    const room = rooms.get(currentRoom);
    if (!room || room.host !== socket.id) return;
    const playerArray = Array.from(room.players.values()).map(p => p.name);
    if (playerArray.length < 3) { socket.emit('error', 'En az 3 oyuncu gerekli!'); return; }
    room.tournament = new Tournament(playerArray, room.settings);
    const state = room.tournament.start();
    io.to(currentRoom).emit('tournamentStarted', state);
    console.log(`🏆 Turnuva başladı: ${currentRoom} (${playerArray.length} oyuncu)`);
  });

  // GERİ SAYIM BAŞLAT
  socket.on('startCountdown', () => {
    const room = rooms.get(currentRoom);
    if (!room || !room.tournament || room.host !== socket.id) return;
    let count = 3;
    io.to(currentRoom).emit('countdown', { count, timestamp: Date.now() });
    const ci = setInterval(() => {
      count--;
      if (count > 0) {
        io.to(currentRoom).emit('countdown', { count, timestamp: Date.now() });
      } else {
        clearInterval(ci);
        io.to(currentRoom).emit('countdown', { count: 'BAŞLA!', timestamp: Date.now() });
        room.tournament.startTimer();
        io.to(currentRoom).emit('timerStarted', { startTime: room.tournament.timerStartTime, targetTime: room.tournament.targetTime, serverTimestamp: Date.now() });
      }
    }, 1000);
  });

  // KRONOMETRE DURDUR
  socket.on('stopTimer', (data) => {
    const room = rooms.get(currentRoom);
    if (!room || !room.tournament) return;
    const result = room.tournament.recordResult(playerName, data.stopTime);
    if (result) {
      io.to(currentRoom).emit('roundResult', result);
      setTimeout(() => {
        const nextState = room.tournament.advanceRound(result.winner, result.loser);
        if (nextState && nextState.champion) {
          room.champions.push({ name: nextState.champion, date: new Date().toLocaleString('tr-TR') });
          room.gameHistory.push({ champion: nextState.champion, players: room.tournament.allPlayers, date: new Date().toISOString() });
          room.tournament = null;
          io.to(currentRoom).emit('tournamentEnd', { champion: nextState.champion, champions: room.champions, players: getPlayersList(room), gameHistory: room.gameHistory });
          console.log(`👑 Şampiyon: ${nextState.champion}`);
        } else {
          io.to(currentRoom).emit('nextRound', nextState);
        }
      }, 3000);
    } else {
      socket.emit('waitingForOpponent');
    }
  });

  // OYUNU ZORLA BİTİR
  socket.on('forceEndTournament', () => {
    const room = rooms.get(currentRoom);
    if (!room || room.host !== socket.id) return;
    if (room.tournament) room.tournament = null;
    io.to(currentRoom).emit('tournamentForceEnd', { message: 'Oyun ev sahibi tarafından sonlandırıldı!', players: getPlayersList(room), champions: room.champions, gameHistory: room.gameHistory });
  });

  // ANTRENMAN BAŞLAT
  socket.on('startTraining', (settings) => {
    trainingMode = true;
    trainingSettings = settings;
    const targetTime = Math.floor(Math.random() * (settings.timerMax - settings.timerMin + 1) + settings.timerMin) * 1000;
    socket.emit('trainingStarted', { targetTime, useDecimal: settings.useDecimal, timerMin: settings.timerMin, timerMax: settings.timerMax });
  });

  // ANTRENMAN GERİ SAYIM
  socket.on('startTrainingCountdown', () => {
    if (!trainingMode) return;
    let count = 3;
    socket.emit('trainingCountdown', { count });
    const ci = setInterval(() => {
      count--;
      if (count > 0) { socket.emit('trainingCountdown', { count }); }
      else {
        clearInterval(ci);
        socket.emit('trainingCountdown', { count: 'BAŞLA!' });
        socket.emit('trainingTimerStarted', { startTime: Date.now() });
      }
    }, 1000);
  });

  // ANTRENMAN DURDUR
  socket.on('stopTraining', (data) => {
    if (!trainingMode) return;
    const elapsed = data.stopTime - data.startTime;
    const difference = Math.abs(elapsed - data.targetTime);
    const percentage = (difference / data.targetTime) * 100;
    
    let rating, emoji, color;
    if (percentage < 1) { rating = 'MÜKEMMEL! 🎯'; emoji = '🌟🌟🌟'; color = '#ffd700'; }
    else if (percentage < 3) { rating = 'Harika! 👏'; emoji = '🌟🌟'; color = '#4ade80'; }
    else if (percentage < 5) { rating = 'Çok İyi! 👍'; emoji = '🌟'; color = '#60a5fa'; }
    else if (percentage < 10) { rating = 'İyi! 🙂'; emoji = '✨'; color = '#a78bfa'; }
    else if (percentage < 20) { rating = 'İdare Eder 🤔'; emoji = '💪'; color = '#f59e0b'; }
    else if (percentage < 30) { rating = 'Geliştirilebilir 📈'; emoji = '🎯'; color = '#f97316'; }
    else { rating = 'Daha Çok Pratik! 🏋️'; emoji = '💪'; color = '#ef4444'; }
    
    socket.emit('trainingResult', { elapsed, difference, targetTime: data.targetTime, rating, emoji, color, percentage: percentage.toFixed(1) });
    
    setTimeout(() => {
      if (trainingMode) {
        const newTarget = Math.floor(Math.random() * (trainingSettings.timerMax - trainingSettings.timerMin + 1) + trainingSettings.timerMin) * 1000;
        socket.emit('trainingNewRound', { targetTime: newTarget, useDecimal: trainingSettings.useDecimal });
      }
    }, 2500);
  });

  // ANTRENMANI DURDUR
  socket.on('stopTrainingMode', () => { trainingMode = false; });

  // CHAT
  socket.on('sendMessage', (data) => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      const msg = { player: playerName, message: data.message, timestamp: Date.now() };
      if (room) { room.chatMessages.push(msg); if (room.chatMessages.length > 100) room.chatMessages.shift(); }
      io.to(currentRoom).emit('newMessage', msg);
    }
  });

  // PING
  socket.on('ping-check', (data) => { socket.emit('pong-check', { clientTime: data.clientTime, serverTime: Date.now() }); });

  // BAĞLANTI KOPTU
  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      const wasHost = room.host === socket.id;
      room.players.delete(socket.id);
      if (room.players.size === 0 || wasHost) {
        io.to(currentRoom).emit('roomClosed', { message: wasHost ? 'Oda sahibi ayrıldı! Kapanıyor...' : 'Oda kapatıldı!' });
        rooms.delete(currentRoom);
        roomCodes.delete(currentRoom);
      } else {
        io.to(currentRoom).emit('playerLeft', getPlayersList(room));
      }
    }
    trainingMode = false;
  });
});

function getPlayersList(room) {
  return Array.from(room.players.values());
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════');
  console.log('🏆 KRONOMETRE TURNUVA v3.0');
  console.log(`📍 Port: ${PORT}`);
  console.log('✅ 3-20 oyuncu | Antrenman modu');
  console.log('═══════════════════════════════════');
});
