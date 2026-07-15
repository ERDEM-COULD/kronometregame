const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000
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
    this.step = 1;
    this.currentMatch = null;
    this.waitingPlayer = null;
    this.match1 = { winner: null, loser: null };
    this.match2 = { winner: null, loser: null };
    this.match3 = { winner: null, loser: null };
    this.match4 = { winner: null, loser: null };
    this.champion = null;
    this.currentPlayers = [];
    this.targetTime = 0;
    this.playerResults = {};
    this.timerStarted = false;
    this.timerStartTime = null;
    this.allPlayers = players;
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
    const shuffled = [...this.players].sort(() => Math.random() - 0.5);
    this.currentMatch = {
      player1: shuffled[0],
      player2: shuffled[1],
      type: '1. MAÇ'
    };
    this.waitingPlayer = shuffled[2];
    this.currentPlayers = [shuffled[0], shuffled[1]];
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
    
    this.playerResults[playerId] = {
      elapsed,
      difference,
      timestamp: stopTime
    };

    if (Object.keys(this.playerResults).length >= 2) {
      return this.determineWinner();
    }
    
    return null;
  }

  determineWinner() {
    const players = Object.keys(this.playerResults);
    const p1 = players[0];
    const p2 = players[1];
    
    if (this.playerResults[p1].difference !== this.playerResults[p2].difference) {
      const winner = this.playerResults[p1].difference < this.playerResults[p2].difference ? p1 : p2;
      const loser = winner === p1 ? p2 : p1;
      return { winner, loser, results: this.playerResults };
    }
    
    const winner = this.playerResults[p1].elapsed < this.playerResults[p2].elapsed ? p1 : p2;
    const loser = winner === p1 ? p2 : p1;
    return { winner, loser, results: this.playerResults, tieBreak: true };
  }

  advanceRound(winner, loser) {
    if (this.step === 1) {
      this.match1 = { winner, loser };
      this.step = 2;
      this.currentMatch = {
        player1: loser,
        player2: this.waitingPlayer,
        type: '2. MAÇ'
      };
      this.currentPlayers = [loser, this.waitingPlayer];
      this.waitingPlayer = null;
    } else if (this.step === 2) {
      this.match2 = { winner, loser };
      this.step = 3;
      this.currentMatch = {
        player1: this.match1.winner,
        player2: winner,
        type: '3. MAÇ (Ara Final)'
      };
      this.currentPlayers = [this.match1.winner, winner];
    } else if (this.step === 3) {
      this.match3 = { winner, loser };
      this.step = 4;
      this.currentMatch = {
        player1: this.match2.loser,
        player2: loser,
        type: '4. MAÇ (Kaybedenler Finali)'
      };
      this.currentPlayers = [this.match2.loser, loser];
    } else if (this.step === 4) {
      this.match4 = { winner, loser };
      this.step = 5;
      this.currentMatch = {
        player1: this.match3.winner,
        player2: winner,
        type: '⭐ 5. MAÇ (SÜPER FİNAL)'
      };
      this.currentPlayers = [this.match3.winner, winner];
    } else if (this.step === 5) {
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
      step: this.step,
      currentMatch: this.currentMatch,
      waitingPlayer: this.waitingPlayer,
      currentPlayers: this.currentPlayers,
      targetTime: this.targetTime,
      timerStarted: this.timerStarted,
      timerStartTime: this.timerStartTime,
      match1: this.match1,
      match2: this.match2,
      match3: this.match3,
      match4: this.match4,
      champion: this.champion,
      allPlayers: this.allPlayers,
      useDecimal: this.useDecimal
    };
  }
}

io.on('connection', (socket) => {
  console.log('Yeni bağlantı:', socket.id);
  let currentRoom = null;
  let playerName = null;

  socket.on('createRoom', (data) => {
    const { playerName: name, settings = {} } = data;
    const code = generateRoomCode();
    const room = {
      code,
      host: socket.id,
      hostName: name,
      players: new Map(),
      tournament: null,
      isLocked: false,
      settings: {
        maxPlayers: settings.maxPlayers || 10,
        useDecimal: settings.useDecimal !== false,
        timerMin: settings.timerMin || 5,
        timerMax: settings.timerMax || 20
      },
      champions: []
    };
    
    room.players.set(socket.id, { id: socket.id, name, isHost: true });
    rooms.set(code, room);
    roomCodes.set(code, code);
    
    socket.join(code);
    currentRoom = code;
    playerName = name;
    
    socket.emit('roomCreated', { 
      code, 
      players: getPlayersList(room),
      settings: room.settings,
      champions: room.champions
    });
    console.log(`✅ Oda: ${code} - Host: ${name}`);
  });

  socket.on('joinRoom', (data) => {
    const { code, playerName: name } = data;
    const room = rooms.get(code.toUpperCase());
    
    if (!room) {
      socket.emit('error', 'Oda bulunamadı!');
      return;
    }
    
    if (room.players.size >= room.settings.maxPlayers) {
      socket.emit('error', `Oda dolu! Maksimum ${room.settings.maxPlayers} oyuncu`);
      return;
    }
    
    if (room.tournament && room.tournament.step > 0) {
      socket.emit('error', 'Turnuva devam ediyor! Bitmesini bekleyin');
      return;
    }
    
    room.players.set(socket.id, { id: socket.id, name, isHost: false });
    socket.join(code);
    currentRoom = code;
    playerName = name;
    
    io.to(code).emit('playerJoined', getPlayersList(room));
    socket.emit('joinSuccess', { 
      code, 
      players: getPlayersList(room),
      settings: room.settings,
      champions: room.champions
    });
    console.log(`👤 ${name} katıldı: ${code}`);
  });

  socket.on('kickPlayer', (data) => {
    const room = rooms.get(currentRoom);
    if (!room || room.host !== socket.id) return;
    
    const targetSocket = io.sockets.sockets.get(data.playerId);
    if (targetSocket) {
      targetSocket.leave(currentRoom);
      room.players.delete(data.playerId);
      targetSocket.emit('kicked');
      io.to(currentRoom).emit('playerKicked', getPlayersList(room));
    }
  });

  socket.on('startTournament', () => {
    const room = rooms.get(currentRoom);
    if (!room || room.host !== socket.id) return;
    
    const playerArray = Array.from(room.players.values()).map(p => p.name);
    if (playerArray.length < 3) {
      socket.emit('error', 'En az 3 oyuncu gerekli!');
      return;
    }
    
    room.tournament = new Tournament(playerArray, room.settings);
    const state = room.tournament.start();
    io.to(currentRoom).emit('tournamentStarted', state);
    console.log(`🏆 Turnuva başladı: ${currentRoom}`);
  });

  socket.on('startCountdown', () => {
    const room = rooms.get(currentRoom);
    if (!room || !room.tournament || room.host !== socket.id) return;
    
    let count = 3;
    io.to(currentRoom).emit('countdown', count);
    
    const countdownInterval = setInterval(() => {
      count--;
      if (count > 0) {
        io.to(currentRoom).emit('countdown', count);
      } else {
        clearInterval(countdownInterval);
        io.to(currentRoom).emit('countdown', 'BAŞLA!');
        // HEMEN başlat, bekleme yok!
        room.tournament.startTimer();
        io.to(currentRoom).emit('timerStarted', { 
          startTime: room.tournament.timerStartTime,
          targetTime: room.tournament.targetTime
        });
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
        const nextState = room.tournament.advanceRound(result.winner, result.loser);
        if (nextState.champion) {
          room.champions.push({
            name: nextState.champion,
            date: new Date().toLocaleString('tr-TR')
          });
          room.tournament = null;
          io.to(currentRoom).emit('tournamentEnd', { 
            champion: nextState.champion,
            champions: room.champions,
            players: getPlayersList(room)
          });
          console.log(`👑 Şampiyon: ${nextState.champion}`);
        } else {
          io.to(currentRoom).emit('nextRound', nextState);
        }
      }, 3000);
    } else {
      socket.emit('waitingForOpponent');
    }
  });

  socket.on('forceEndTournament', () => {
    const room = rooms.get(currentRoom);
    if (!room || room.host !== socket.id) return;
    
    if (room.tournament) {
      room.tournament = null;
    }
    io.to(currentRoom).emit('tournamentForceEnd', {
      message: 'Oyun ev sahibi tarafından sonlandırıldı!',
      players: getPlayersList(room),
      champions: room.champions
    });
  });

  socket.on('sendMessage', (data) => {
    if (currentRoom) {
      io.to(currentRoom).emit('newMessage', {
        player: playerName,
        message: data.message,
        timestamp: Date.now()
      });
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      const wasHost = room.host === socket.id;
      
      room.players.delete(socket.id);
      
      if (room.players.size === 0 || wasHost) {
        io.to(currentRoom).emit('roomClosed', { 
          message: wasHost ? 'Oda sahibi odadan ayrıldı! Oda kapatılıyor...' : 'Oda kapatıldı!'
        });
        rooms.delete(currentRoom);
        roomCodes.delete(currentRoom);
        console.log(`🗑️ Oda kapatıldı: ${currentRoom}`);
      } else {
        io.to(currentRoom).emit('playerLeft', getPlayersList(room));
      }
    }
  });
});

function getPlayersList(room) {
  return Array.from(room.players.values());
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════');
  console.log('🏆 TURNUVA SUNUCUSU BAŞLATILDI!');
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`📱 Ağ: http://10.220.14.176:${PORT}`);
  console.log('═══════════════════════════════════════');
});