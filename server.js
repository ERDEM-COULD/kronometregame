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

// ============ YENİ TURNUVA SİSTEMİ (3-20 oyuncu) ============
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
    this.bracket = null; // Turnuva bracket'i
    this.roundName = '';
    this.eliminated = []; // Elenen oyuncular
    
    // Turnuva bracket'ini oluştur
    this.buildBracket();
  }

  buildBracket() {
    const n = this.playerCount;
    
    if (n === 3) {
      // 3 kişilik özel sistem
      this.bracket = {
        type: 'special3',
        matches: []
      };
    } else if (n === 4) {
      // 4 kişilik: 2 yarı final + final + süper final
      this.bracket = {
        type: '4players',
        round1: [], // Yarı finaller
        final: null,
        loserFinal: null,
        superFinal: null
      };
    } else {
      // 5+ kişilik: Eleme turları
      this.bracket = {
        type: 'elimination',
        rounds: [],
        currentRound: 0,
        losersBracket: []
      };
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
      
      // Eşleştirmeleri yap
      while (shuffled.length >= 2) {
        let p1 = shuffled.shift();
        let p2 = shuffled.shift();
        roundMatches.push({
          player1: p1,
          player2: p2,
          winner: null,
          loser: null
        });
      }
      
      // Bay geçen varsa
      if (shuffled.length === 1) {
        winners.push(shuffled[0]); // Direkt üst tura
      }
      
      this.bracket.rounds.push({
        number: roundNum,
        matches: roundMatches,
        winners: winners
      });
      
      remaining = []; // Üst tur için kazananları bekleyeceğiz
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
    if (this.playerCount === 3) {
      return this.start3PlayerMode();
    } else {
      return this.startMultiPlayerMode();
    }
  }

  start3PlayerMode() {
    const shuffled = [...this.players].sort(() => Math.random() - 0.5);
    this.currentMatch = {
      player1: shuffled[0],
      player2: shuffled[1],
      type: '1. MAÇ',
      round: 1
    };
    this.currentPlayers = [shuffled[0], shuffled[1]];
    this.waitingPlayer = shuffled[2];
    this.targetTime = this.generateTargetTime();
    this.timerStarted = false;
    this.playerResults = {};
    this.roundName = '1. MAÇ';
    return this.getState();
  }

  startMultiPlayerMode() {
    if (this.playerCount === 4) {
      // 4 kişilik: 2 yarı final
      const shuffled = [...this.players].sort(() => Math.random() - 0.5);
      this.bracket.round1 = [
        { player1: shuffled[0], player2: shuffled[1], winner: null, loser: null },
        { player1: shuffled[2], player2: shuffled[3], winner: null, loser: null }
      ];
      this.currentMatchIndex = 0;
      this.currentMatch = {
        player1: shuffled[0],
        player2: shuffled[1],
        type: 'YARI FİNAL 1',
        round: 1
      };
      this.currentPlayers = [shuffled[0], shuffled[1]];
      this.roundName = 'YARI FİNAL 1';
    } else {
      // 5+ kişilik
      const firstRound = this.bracket.rounds[0];
      if (firstRound.matches.length > 0) {
        const match = firstRound.matches[0];
        this.currentMatch = {
          player1: match.player1,
          player2: match.player2,
          type: `TUR 1 - MAÇ 1`,
          round: 1
        };
        this.currentPlayers = [match.player1, match.player2];
        this.currentMatchIndex = 0;
        this.currentRoundMatches = firstRound.matches;
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
    if (this.playerCount === 3) {
      return this.advance3Player(winner, loser);
    } else if (this.playerCount === 4) {
      return this.advance4Player(winner, loser);
    } else {
      return this.advanceMultiPlayer(winner, loser);
    }
  }

  advance3Player(winner, loser) {
    if (this.step === 1) {
      this.match1 = { winner, loser };
      this.step = 2;
      this.currentMatch = {
        player1: loser,
        player2: this.waitingPlayer,
        type: '2. MAÇ',
        round: 2
      };
      this.currentPlayers = [loser, this.waitingPlayer];
      this.waitingPlayer = null;
      this.roundName = '2. MAÇ';
    } else if (this.step === 2) {
      this.match2 = { winner, loser };
      this.step = 3;
      this.currentMatch = {
        player1: this.match1.winner,
        player2: winner,
        type: '3. MAÇ (Ara Final)',
        round: 3
      };
      this.currentPlayers = [this.match1.winner, winner];
      this.roundName = 'ARA FİNAL';
    } else if (this.step === 3) {
      this.match3 = { winner, loser };
      this.step = 4;
      this.currentMatch = {
        player1: this.match2.loser,
        player2: loser,
        type: '4. MAÇ (Kaybedenler Finali)',
        round: 4
      };
      this.currentPlayers = [this.match2.loser, loser];
      this.roundName = 'KAYBEDENLER FİNALİ';
    } else if (this.step === 4) {
      this.match4 = { winner, loser };
      this.step = 5;
      this.currentMatch = {
        player1: this.match3.winner,
        player2: winner,
        type: '⭐ 5. MAÇ (SÜPER FİNAL)',
        round: 5
      };
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

  advance4Player(winner, loser) {
    const currentMatchIdx = this.currentMatchIndex;
    const match = this.bracket.round1[currentMatchIdx];
    match.winner = winner;
    match.loser = loser;
    
    if (currentMatchIdx === 0) {
      // İlk yarı final bitti, ikinciye geç
      this.currentMatchIndex = 1;
      const nextMatch = this.bracket.round1[1];
      this.currentMatch = {
        player1: nextMatch.player1,
        player2: nextMatch.player2,
        type: 'YARI FİNAL 2',
        round: 1
      };
      this.currentPlayers = [nextMatch.player1, nextMatch.player2];
      this.roundName = 'YARI FİNAL 2';
    } else {
      // İki yarı final de bitti, final zamanı
      const finalist1 = this.bracket.round1[0].winner;
      const finalist2 = this.bracket.round1[1].winner;
      const loser1 = this.bracket.round1[0].loser;
      const loser2 = this.bracket.round1[1].loser;
      
      if (!this.bracket.final) {
        // Final
        this.bracket.final = { player1: finalist1, player2: finalist2, winner: null, loser: null };
        this.currentMatch = {
          player1: finalist1,
          player2: finalist2,
          type: '🏆 FİNAL',
          round: 2
        };
        this.currentPlayers = [finalist1, finalist2];
        this.roundName = 'FİNAL';
      } else if (!this.bracket.loserFinal) {
        // Kaybedenler finali
        this.bracket.final.winner = winner;
        this.bracket.final.loser = loser;
        this.bracket.loserFinal = { player1: loser1, player2: loser2, winner: null, loser: null };
        this.currentMatch = {
          player1: loser1,
          player2: loser2,
          type: '🥉 KAYBEDENLER FİNALİ',
          round: 3
        };
        this.currentPlayers = [loser1, loser2];
        this.roundName = 'KAYBEDENLER FİNALİ';
      } else {
        // Süper final
        this.bracket.loserFinal.winner = winner;
        const superFinalist1 = this.bracket.final.winner;
        const superFinalist2 = this.bracket.loserFinal.winner;
        this.currentMatch = {
          player1: superFinalist1,
          player2: superFinalist2,
          type: '⭐ SÜPER FİNAL',
          round: 4
        };
        this.currentPlayers = [superFinalist1, superFinalist2];
        this.roundName = 'SÜPER FİNAL';
        this.step = 99; // Final adımı
      }
    }
    
    this.targetTime = this.generateTargetTime();
    this.timerStarted = false;
    this.playerResults = {};
    return this.getState();
  }

  advanceMultiPlayer(winner, loser) {
    // Mevcut round'un kazananını kaydet
    const currentRound = this.bracket.rounds[this.bracket.currentRound];
    if (currentRound && this.currentMatchIndex < currentRound.matches.length) {
      currentRound.matches[this.currentMatchIndex].winner = winner;
      currentRound.matches[this.currentMatchIndex].loser = loser;
    }
    
    // Sonraki maça geç
    this.currentMatchIndex++;
    
    if (currentRound && this.currentMatchIndex < currentRound.matches.length) {
      // Aynı turda sonraki maç
      const nextMatch = currentRound.matches[this.currentMatchIndex];
      this.currentMatch = {
        player1: nextMatch.player1,
        player2: nextMatch.player2,
        type: `TUR ${currentRound.number} - MAÇ ${this.currentMatchIndex + 1}`,
        round: currentRound.number
      };
      this.currentPlayers = [nextMatch.player1, nextMatch.player2];
      this.roundName = `${currentRound.number}. TUR`;
    } else {
      // Tur bitti, kazananları topla
      let winners = currentRound.winners || [];
      currentRound.matches.forEach(m => {
        if (m.winner) winners.push(m.winner);
      });
      
      // Bir üst tur oluştur
      this.bracket.currentRound++;
      
      if (winners.length === 1) {
        this.champion = winners[0];
        return { champion: winners[0] };
      }
      
      if (winners.length === 2) {
        // Final
        this.currentMatch = {
          player1: winners[0],
          player2: winners[1],
          type: '🏆 FİNAL',
          round: 999
        };
        this.currentPlayers = [winners[0], winners[1]];
        this.roundName = 'FİNAL';
        this.step = 98;
      } else {
        // Yeni tur
        const newRound = {
          number: this.bracket.currentRound + 1,
          matches: [],
          winners: []
        };
        
        let shuffled = [...winners].sort(() => Math.random() - 0.5);
        while (shuffled.length >= 2) {
          let p1 = shuffled.shift();
          let p2 = shuffled.shift();
          newRound.matches.push({ player1: p1, player2: p2, winner: null, loser: null });
        }
        if (shuffled.length === 1) {
          newRound.winners.push(shuffled[0]);
        }
        
        this.bracket.rounds.push(newRound);
        this.currentMatchIndex = 0;
        
        if (newRound.matches.length > 0) {
          const match = newRound.matches[0];
          this.currentMatch = {
            player1: match.player1,
            player2: match.player2,
            type: `TUR ${newRound.number} - MAÇ 1`,
            round: newRound.number
          };
          this.currentPlayers = [match.player1, match.player2];
          this.roundName = `${newRound.number}. TUR`;
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
      step: this.step,
      playerCount: this.playerCount,
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
      useDecimal: this.useDecimal,
      roundName: this.roundName,
      bracket: this.bracket
    };
  }
}

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
  console.log('Yeni bağlantı:', socket.id);
  let currentRoom = null;
  let playerName = null;
  let trainingMode = false;
  let trainingTimer = null;

  // ============ ODA İŞLEMLERİ ============
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
      champions: [],
      chatMessages: [],
      gameHistory: []
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
      champions: room.champions,
      gameHistory: room.gameHistory
    });
    console.log(`✅ Oda: ${code} - Host: ${name} (${room.settings.maxPlayers} kişilik)`);
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
    
    if (room.tournament && room.tournament.step > 0 && room.tournament.champion === null) {
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
      champions: room.champions,
      gameHistory: room.gameHistory
    });
    console.log(`👤 ${name} katıldı: ${code} (${room.players.size}/${room.settings.maxPlayers})`);
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
    if (playerArray.length < 2) {
      socket.emit('error', 'En az 2 oyuncu gerekli!');
      return;
    }
    
    if (playerArray.length === 2) {
      socket.emit('error', 'En az 3 oyuncu gerekli! Antrenman modunu kullanın.');
      return;
    }
    
    room.tournament = new Tournament(playerArray, room.settings);
    const state = room.tournament.start();
    io.to(currentRoom).emit('tournamentStarted', state);
    console.log(`🏆 Turnuva başladı: ${currentRoom} (${playerArray.length} oyuncu)`);
  });

  // ============ KRONOMETRE İŞLEMLERİ ============
  socket.on('startCountdown', () => {
    const room = rooms.get(currentRoom);
    if (!room || !room.tournament || room.host !== socket.id) return;
    
    let count = 3;
    io.to(currentRoom).emit('countdown', { count, timestamp: Date.now() });
    
    const countdownInterval = setInterval(() => {
      count--;
      if (count > 0) {
        io.to(currentRoom).emit('countdown', { count, timestamp: Date.now() });
      } else {
        clearInterval(countdownInterval);
        io.to(currentRoom).emit('countdown', { count: 'BAŞLA!', timestamp: Date.now() });
        room.tournament.startTimer();
        // Anında başlat, gecikme yok
        io.to(currentRoom).emit('timerStarted', { 
          startTime: room.tournament.timerStartTime,
          targetTime: room.tournament.targetTime,
          serverTimestamp: Date.now()
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
        if (nextState && nextState.champion) {
          room.champions.push({
            name: nextState.champion,
            date: new Date().toLocaleString('tr-TR')
          });
          room.gameHistory.push({
            champion: nextState.champion,
            players: room.tournament.allPlayers,
            date: new Date().toISOString()
          });
          room.tournament = null;
          io.to(currentRoom).emit('tournamentEnd', { 
            champion: nextState.champion,
            champions: room.champions,
            players: getPlayersList(room),
            gameHistory: room.gameHistory
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
      champions: room.champions,
      gameHistory: room.gameHistory
    });
  });

  // ============ ANTRENMAN MODU ============
  socket.on('startTraining', (settings) => {
    trainingMode = true;
    const targetTime = Math.floor(Math.random() * (settings.timerMax - settings.timerMin + 1) + settings.timerMin) * 1000;
    
    socket.emit('trainingStarted', {
      targetTime,
      useDecimal: settings.useDecimal,
      timerMin: settings.timerMin,
      timerMax: settings.timerMax
    });
  });

  socket.on('startTrainingCountdown', () => {
    if (!trainingMode) return;
    
    let count = 3;
    socket.emit('trainingCountdown', { count });
    
    const countdownInterval = setInterval(() => {
      count--;
      if (count > 0) {
        socket.emit('trainingCountdown', { count });
      } else {
        clearInterval(countdownInterval);
        const startTime = Date.now();
        socket.emit('trainingCountdown', { count: 'BAŞLA!' });
        socket.emit('trainingTimerStarted', { startTime });
      }
    }, 1000);
  });

  socket.on('stopTraining', (data) => {
    if (!trainingMode) return;
    trainingMode = false;
    const elapsed = data.stopTime - data.startTime;
    const difference = Math.abs(elapsed - data.targetTime);
    socket.emit('trainingResult', { elapsed, difference, targetTime: data.targetTime });
  });

  // ============ CHAT ============
  socket.on('sendMessage', (data) => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      const msg = {
        player: playerName,
        message: data.message,
        timestamp: Date.now()
      };
      if (room) {
        room.chatMessages.push(msg);
        if (room.chatMessages.length > 100) room.chatMessages.shift();
      }
      io.to(currentRoom).emit('newMessage', msg);
    }
  });

  // ============ BAĞLANTI KOPMA ============
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
    trainingMode = false;
  });

  // ============ PING (gecikme ölçümü) ============
  socket.on('ping-check', (data) => {
    socket.emit('pong-check', { clientTime: data.clientTime, serverTime: Date.now() });
  });
});

function getPlayersList(room) {
  return Array.from(room.players.values());
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════');
  console.log('🏆 KRONOMETRE TURNUVA SİSTEMİ');
  console.log(`📍 Port: ${PORT}`);
  console.log('✅ 3-20 oyuncu desteği');
  console.log('✅ Antrenman modu');
  console.log('✅ Gecikme düzeltmeleri');
  console.log('✅ Ses efektleri');
  console.log('═══════════════════════════════════════');
});
