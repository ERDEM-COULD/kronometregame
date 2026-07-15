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

const rooms = new Map();
const roomCodes = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
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
  }

  generateTargetTime() {
    const min = (this.settings.timerMin || 5) * 1000;
    const max = (this.settings.timerMax || 20) * 1000;
    if (this.useDecimal) return Math.floor(Math.random() * (max - min)) + min;
    const minSec = Math.ceil(min / 1000), maxSec = Math.floor(max / 1000);
    return (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000;
  }

  start() {
    if (this.playerCount === 3) return this.start3P();
    return this.startMP();
  }

  start3P() {
    const sh = [...this.players].sort(() => Math.random() - 0.5);
    this.currentMatch = { player1: sh[0], player2: sh[1], type: '1. MAÇ' };
    this.currentPlayers = [sh[0], sh[1]];
    this.waitingPlayer = sh[2];
    this.targetTime = this.generateTargetTime();
    this.timerStarted = false;
    this.playerResults = {};
    this.roundName = '1. MAÇ';
    return this.getState();
  }

  startMP() {
    const sh = [...this.players].sort(() => Math.random() - 0.5);
    const matches = [];
    while (sh.length >= 2) matches.push({ p1: sh.shift(), p2: sh.shift(), winner: null });
    this.bracket = { matches, current: 0, winners: sh };
    if (matches.length > 0) {
      this.currentMatch = { player1: matches[0].p1, player2: matches[0].p2, type: '1. TUR' };
      this.currentPlayers = [matches[0].p1, matches[0].p2];
      this.roundName = '1. TUR';
    }
    this.targetTime = this.generateTargetTime();
    this.timerStarted = false;
    this.playerResults = {};
    return this.getState();
  }

  startTimer() { this.timerStarted = true; this.timerStartTime = Date.now(); }

  recordResult(playerId, stopTime) {
    if (!this.timerStarted || this.playerResults[playerId]) return null;
    this.playerResults[playerId] = {
      elapsed: stopTime - this.timerStartTime,
      difference: Math.abs(stopTime - this.timerStartTime - this.targetTime)
    };
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
    return this.advMP(winner, loser);
  }

  adv3(winner, loser) {
    if (this.step === 1) {
      this.match1 = { winner, loser }; this.step = 2;
      this.currentMatch = { player1: loser, player2: this.waitingPlayer, type: '2. MAÇ' };
      this.currentPlayers = [loser, this.waitingPlayer]; this.waitingPlayer = null;
      this.roundName = '2. MAÇ';
    } else if (this.step === 2) {
      this.match2 = { winner, loser }; this.step = 3;
      this.currentMatch = { player1: this.match1.winner, player2: winner, type: '3. MAÇ (Ara Final)' };
      this.currentPlayers = [this.match1.winner, winner];
      this.roundName = 'ARA FİNAL';
    } else if (this.step === 3) {
      this.match3 = { winner, loser }; this.step = 4;
      this.currentMatch = { player1: this.match2.loser, player2: loser, type: '4. MAÇ (Kaybedenler Finali)' };
      this.currentPlayers = [this.match2.loser, loser];
      this.roundName = 'KAYBEDENLER FİNALİ';
    } else if (this.step === 4) {
      this.match4 = { winner, loser }; this.step = 5;
      this.currentMatch = { player1: this.match3.winner, player2: winner, type: '⭐ SÜPER FİNAL' };
      this.currentPlayers = [this.match3.winner, winner];
      this.roundName = 'SÜPER FİNAL';
    } else {
      this.champion = winner;
      return { champion: winner };
    }
    this.targetTime = this.generateTargetTime();
    this.timerStarted = false;
    this.playerResults = {};
    return this.getState();
  }

  advMP(winner, loser) {
    const b = this.bracket;
    b.matches[b.current].winner = winner;
    b.current++;
    
    if (b.current < b.matches.length) {
      const m = b.matches[b.current];
      this.currentMatch = { player1: m.p1, player2: m.p2, type: `${b.current+1}. MAÇ` };
      this.currentPlayers = [m.p1, m.p2];
    } else {
      let winners = b.winners || [];
      b.matches.forEach(m => { if (m.winner) winners.push(m.winner); });
      
      if (winners.length === 1) { this.champion = winners[0]; return { champion: winners[0] }; }
      
      const sh = [...winners].sort(() => Math.random() - 0.5);
      const newMatches = [];
      while (sh.length >= 2) newMatches.push({ p1: sh.shift(), p2: sh.shift(), winner: null });
      b.matches = newMatches;
      b.current = 0;
      b.winners = sh;
      
      if (newMatches.length > 0) {
        const m = newMatches[0];
        this.currentMatch = { player1: m.p1, player2: m.p2, type: 'ÜST TUR' };
        this.currentPlayers = [m.p1, m.p2];
        this.roundName = 'ÜST TUR';
      }
    }
    this.targetTime = this.generateTargetTime();
    this.timerStarted = false;
    this.playerResults = {};
    return this.getState();
  }

  getState() {
    return {
      step: this.step, playerCount: this.playerCount,
      currentPlayers: this.currentPlayers, targetTime: this.targetTime,
      useDecimal: this.useDecimal, roundName: this.roundName,
      champion: this.champion, waitingPlayer: this.waitingPlayer
    };
  }
}

io.on('connection', (socket) => {
  let currentRoom = null, playerName = null;
  let trainingMode = false, trainingSettings = {};

  socket.on('createRoom', (data) => {
    const { playerName: name, settings = {} } = data;
    const code = generateRoomCode();
    const room = {
      code, host: socket.id, players: new Map(), tournament: null,
      settings: {
        maxPlayers: settings.maxPlayers || 10,
        useDecimal: settings.useDecimal !== false,
        timerMin: settings.timerMin || 5,
        timerMax: settings.timerMax || 20
      },
      champions: [], gameHistory: []
    };
    room.players.set(socket.id, { id: socket.id, name, isHost: true });
    rooms.set(code, room);
    roomCodes.set(code, code);
    socket.join(code);
    currentRoom = code;
    playerName = name;
    socket.emit('roomCreated', { code, players: getPlayers(room), settings: room.settings, champions: room.champions });
  });

  socket.on('joinRoom', (data) => {
    const { code, playerName: name } = data;
    const room = rooms.get(code.toUpperCase());
    if (!room) { socket.emit('error', 'Oda bulunamadı!'); return; }
    if (room.players.size >= room.settings.maxPlayers) { socket.emit('error', 'Oda dolu!'); return; }
    room.players.set(socket.id, { id: socket.id, name, isHost: false });
    socket.join(code);
    currentRoom = code;
    playerName = name;
    io.to(code).emit('playerJoined', getPlayers(room));
    socket.emit('joinSuccess', { code, players: getPlayers(room), settings: room.settings, champions: room.champions });
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
    io.to(currentRoom).emit('tournamentStarted', room.tournament.start());
  });

  socket.on('startCountdown', () => {
    const room = rooms.get(currentRoom);
    if (!room || !room.tournament || room.host !== socket.id) return;
    let count = 3;
    io.to(currentRoom).emit('countdown', { count });
    const ci = setInterval(() => {
      count--;
      if (count > 0) io.to(currentRoom).emit('countdown', { count });
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
          io.to(currentRoom).emit('tournamentEnd', { champion: next.champion, champions: room.champions, players: getPlayers(room) });
        } else {
          io.to(currentRoom).emit('nextRound', next);
        }
      }, 3000);
    }
  });

  socket.on('forceEndTournament', () => {
    const room = rooms.get(currentRoom);
    if (!room || room.host !== socket.id) return;
    room.tournament = null;
    io.to(currentRoom).emit('tournamentForceEnd', { message: 'Oyun sonlandırıldı!', players: getPlayers(room), champions: room.champions });
  });

  socket.on('startTraining', (settings) => {
    trainingMode = true;
    trainingSettings = settings;
    socket.emit('trainingStarted', {
      targetTime: Math.floor(Math.random() * (settings.timerMax - settings.timerMin + 1) + settings.timerMin) * 1000,
      useDecimal: settings.useDecimal
    });
  });

  socket.on('startTrainingCountdown', () => {
    if (!trainingMode) return;
    let count = 3;
    socket.emit('trainingCountdown', { count });
    const ci = setInterval(() => {
      count--;
      if (count > 0) socket.emit('trainingCountdown', { count });
      else {
        clearInterval(ci);
        socket.emit('trainingCountdown', { count: 'BAŞLA!' });
        socket.emit('trainingTimerStarted', { startTime: Date.now() });
      }
    }, 1000);
  });

  socket.on('stopTraining', (data) => {
    if (!trainingMode) return;
    const elapsed = data.stopTime - data.startTime;
    const diff = Math.abs(elapsed - data.targetTime);
    const pct = (diff / data.targetTime) * 100;
    let rating, emoji, color;
    if (pct < 1) { rating = 'MÜKEMMEL!'; emoji = '🌟🌟🌟'; color = '#ffd700'; }
    else if (pct < 3) { rating = 'Harika!'; emoji = '🌟🌟'; color = '#4ade80'; }
    else if (pct < 5) { rating = 'Çok İyi!'; emoji = '🌟'; color = '#60a5fa'; }
    else if (pct < 10) { rating = 'İyi!'; emoji = '✨'; color = '#a78bfa'; }
    else if (pct < 20) { rating = 'İdare Eder'; emoji = '💪'; color = '#f59e0b'; }
    else { rating = 'Pratik Yap!'; emoji = '🏋️'; color = '#ef4444'; }
    socket.emit('trainingResult', { elapsed, difference: diff, targetTime: data.targetTime, rating, emoji, color, percentage: pct.toFixed(1) });
    setTimeout(() => {
      if (trainingMode) {
        socket.emit('trainingNewRound', {
          targetTime: Math.floor(Math.random() * (trainingSettings.timerMax - trainingSettings.timerMin + 1) + trainingSettings.timerMin) * 1000,
          useDecimal: trainingSettings.useDecimal
        });
      }
    }, 2500);
  });

  socket.on('stopTrainingMode', () => { trainingMode = false; });

  socket.on('sendMessage', (data) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('newMessage', { player: playerName, message: data.message });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      const wasHost = room.host === socket.id;
      room.players.delete(socket.id);
      if (room.players.size === 0 || wasHost) {
        io.to(currentRoom).emit('roomClosed', { message: wasHost ? 'Oda sahibi ayrıldı!' : 'Oda kapatıldı!' });
        rooms.delete(currentRoom);
        roomCodes.delete(currentRoom);
      } else {
        io.to(currentRoom).emit('playerLeft', getPlayers(room));
      }
    }
    trainingMode = false;
  });
});

function getPlayers(room) { return Array.from(room.players.values()); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🏆 Turnuva v8.0 - Port: ${PORT}`));
