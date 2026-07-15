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
  transports: ['websocket', 'polling']
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
    this.currentPlayers = [];
    this.targetTime = 0;
    this.playerResults = {};
    this.timerStarted = false;
    this.timerStartTime = null;
    this.champion = null;
    this.roundName = '';
    this.waitingPlayer = null;
    this.match1 = { winner: null, loser: null };
    this.match2 = { winner: null, loser: null };
    this.match3 = { winner: null, loser: null };
    this.match4 = { winner: null, loser: null };
  }

  generateTargetTime() {
    const min = (this.settings.timerMin || 5) * 1000;
    const max = (this.settings.timerMax || 20) * 1000;
    if (this.useDecimal) return Math.floor(Math.random() * (max - min)) + min;
    const minSec = Math.ceil(min / 1000), maxSec = Math.floor(max / 1000);
    return (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000;
  }

  start() {
    const sh = [...this.players].sort(() => Math.random() - 0.5);
    this.currentPlayers = [sh[0], sh[1]];
    this.waitingPlayer = sh[2] || null;
    this.targetTime = this.generateTargetTime();
    this.timerStarted = false;
    this.playerResults = {};
    this.roundName = '1. MAÇ';
    this.step = 1;
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
    if (this.step === 1) {
      this.match1 = { winner, loser }; this.step = 2;
      this.currentPlayers = [loser, this.waitingPlayer]; this.waitingPlayer = null;
      this.roundName = '2. MAÇ';
    } else if (this.step === 2) {
      this.match2 = { winner, loser }; this.step = 3;
      this.currentPlayers = [this.match1.winner, winner];
      this.roundName = 'ARA FİNAL';
    } else if (this.step === 3) {
      this.match3 = { winner, loser }; this.step = 4;
      this.currentPlayers = [this.match2.loser, loser];
      this.roundName = 'KAYBEDENLER FİNALİ';
    } else if (this.step === 4) {
      this.match4 = { winner, loser }; this.step = 5;
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

  getState() {
    return {
      step: this.step, currentPlayers: this.currentPlayers,
      targetTime: this.targetTime, useDecimal: this.useDecimal,
      roundName: this.roundName, champion: this.champion,
      waitingPlayer: this.waitingPlayer, timerStarted: this.timerStarted,
      match1: this.match1, match2: this.match2, match3: this.match3, match4: this.match4
    };
  }
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName = null;

  socket.on('createRoom', (data) => {
    playerName = data.playerName;
    const settings = data.settings || {};
    const code = generateRoomCode();
    const room = {
      code, host: socket.id, hostName: playerName,
      players: new Map(), tournament: null,
      settings: {
        maxPlayers: settings.maxPlayers || 10,
        useDecimal: settings.useDecimal !== false,
        timerMin: settings.timerMin || 5,
        timerMax: settings.timerMax || 20
      },
      champions: []
    };
    room.players.set(socket.id, playerName);
    rooms.set(code, room);
    roomCodes.set(code, code);
    socket.join(code);
    currentRoom = code;
    socket.emit('roomCreated', { code, players: getPlayers(room), settings: room.settings, champions: room.champions });
  });

  socket.on('joinRoom', (data) => {
    playerName = data.playerName;
    const code = data.code.toUpperCase();
    const room = rooms.get(code);
    if (!room) { socket.emit('error', 'Oda bulunamadı!'); return; }
    if (room.tournament) { socket.emit('error', 'Oyun devam ediyor!'); return; }
    room.players.set(socket.id, playerName);
    socket.join(code);
    currentRoom = code;
    socket.emit('joinSuccess', { code, players: getPlayers(room), settings: room.settings, champions: room.champions });
    io.to(code).emit('playerJoined', getPlayers(room));
  });

  socket.on('startTournament', () => {
    const room = rooms.get(currentRoom);
    if (!room || room.host !== socket.id) return;
    const arr = Array.from(room.players.values());
    if (arr.length < 3) { socket.emit('error', 'En az 3 oyuncu!'); return; }
    room.tournament = new Tournament(arr, room.settings);
    const state = room.tournament.getState();
    
    // HER OYUNCUYA ÖZEL GÖNDER - KRİTİK DÜZELTME
    room.players.forEach((name, socketId) => {
      const ps = io.sockets.sockets.get(socketId);
      if (ps) {
        const isPlaying = state.currentPlayers.includes(name);
        ps.emit('gameStateUpdate', {
          ...state,
          youArePlaying: isPlaying,
          yourName: name
        });
        if (isPlaying) {
          ps.emit('matchScreenShow', state);
        } else {
          ps.emit('waitingScreenShow', { players: state.currentPlayers, roundName: state.roundName });
        }
      }
    });
    
    if (room.host === socket.id) {
      setTimeout(() => startCountdown(room), 500);
    }
  });

  function startCountdown(room) {
    let count = 3;
    io.to(room.code).emit('countdown', { count });
    const ci = setInterval(() => {
      count--;
      if (count > 0) {
        io.to(room.code).emit('countdown', { count });
      } else {
        clearInterval(ci);
        io.to(room.code).emit('countdown', { count: 'BAŞLA!' });
        room.tournament.startTimer();
        io.to(room.code).emit('timerStarted', {
          startTime: room.tournament.timerStartTime,
          targetTime: room.tournament.targetTime
        });
      }
    }, 1000);
  }

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
          io.to(currentRoom).emit('championDeclared', { champion: next.champion, champions: room.champions });
          room.tournament = null;
        } else {
          const state = room.tournament.getState();
          // HER OYUNCUYA ÖZEL
          room.players.forEach((name, socketId) => {
            const ps = io.sockets.sockets.get(socketId);
            if (ps) {
              const isPlaying = state.currentPlayers.includes(name);
              ps.emit('gameStateUpdate', { ...state, youArePlaying: isPlaying, yourName: name });
              if (isPlaying) {
                ps.emit('matchScreenShow', state);
              } else {
                ps.emit('waitingScreenShow', { players: state.currentPlayers, roundName: state.roundName });
              }
            }
          });
          if (room.host === socket.id) {
            setTimeout(() => startCountdown(room), 1000);
          }
        }
      }, 3000);
    }
  });

  socket.on('forceEndTournament', () => {
    const room = rooms.get(currentRoom);
    if (!room || room.host !== socket.id) return;
    room.tournament = null;
    io.to(currentRoom).emit('gameForceEnd', { message: 'Oyun sonlandırıldı!' });
  });

  socket.on('sendMessage', (data) => {
    if (currentRoom) io.to(currentRoom).emit('newMessage', { player: playerName, message: data.message });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.players.delete(socket.id);
      if (room.players.size === 0 || room.host === socket.id) {
        io.to(currentRoom).emit('roomClosed', { message: 'Oda kapatıldı!' });
        rooms.delete(currentRoom);
        roomCodes.delete(currentRoom);
      } else {
        io.to(currentRoom).emit('playerLeft', getPlayers(room));
      }
    }
  });
});

function getPlayers(room) {
  return Array.from(room.players.entries()).map(([id, name]) => ({ id, name, isHost: id === room.host }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🏆 Render Turnuva - Port: ${PORT}`));
