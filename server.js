const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

const rooms = {};

// Game Constants
const MAX_HP = 100;
const MAX_STAMINA = 100;
const STAMINA_COSTS = { left_slash: 10, right_slash: 10, overhead: 20, stab: 20, block: 30, none: 0 };
const DAMAGE = { left_slash: 10, right_slash: 10, overhead: 20, stab: 20, block: 0, none: 0 };

io.on('connection', (socket) => {
    socket.on('join_room', ({ username, roomCode }) => {
        if (!rooms[roomCode]) {
            rooms[roomCode] = { players: {}, state: 'waiting', turnCount: 0 };
        }
        
        const room = rooms[roomCode];
        if (Object.keys(room.players).length >= 2) {
            return socket.emit('error', 'Room is full!');
        }

        room.players[socket.id] = {
            username, id: socket.id, hp: MAX_HP, stamina: MAX_STAMINA, move: 'none', stunned: false
        };
        socket.join(roomCode);

        if (Object.keys(room.players).length === 2) {
            io.to(roomCode).emit('game_start', Object.values(room.players));
            startGameLoop(roomCode);
        } else {
            socket.emit('waiting', 'Waiting for opponent...');
        }
    });

    socket.on('submit_move', ({ roomCode, move }) => {
        const room = rooms[roomCode];
        if (room && room.state === 'action' && !room.players[socket.id].stunned) {
            room.players[socket.id].move = move;
        }
    });

    socket.on('disconnect', () => {
        for (const code in rooms) {
            if (rooms[code].players[socket.id]) {
                io.to(code).emit('error', 'Opponent disconnected. Refresh to play again.');
                delete rooms[code];
            }
        }
    });
});

function startGameLoop(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    room.turnCount++;
    const countdownTime = room.turnCount === 1 ? 3 : 2;
    room.state = 'countdown';
    
    // Send updated stats at start of turn
    io.to(roomCode).emit('update_stats', Object.values(room.players));
    io.to(roomCode).emit('countdown', countdownTime);

    setTimeout(() => {
        room.state = 'action';
        io.to(roomCode).emit('action_phase'); // Players have 1 sec to move

        setTimeout(() => resolveTurn(roomCode), 1000);
    }, countdownTime * 1000);
}

function resolveTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    room.state = 'resolve';

    const pKeys = Object.keys(room.players);
    const p1 = room.players[pKeys[0]];
    const p2 = room.players[pKeys[1]];

    let clash = false;
    // Check for Counter/Clash (0 Stamina, 0 Damage)
    if (p1.move === 'overhead' && p2.move === 'overhead') clash = true;
    if (p1.move === 'stab' && p2.move === 'stab') clash = true;
    if ((p1.move === 'left_slash' && p2.move === 'right_slash') || (p1.move === 'right_slash' && p2.move === 'left_slash')) clash = true;

    if (clash) {
        p1.move = 'none'; p2.move = 'none';
        io.to(roomCode).emit('clash_event', 'CLASH! Zero Stamina Drained.');
    } else {
        // Apply stamina costs
        p1.stamina = Math.max(0, p1.stamina - STAMINA_COSTS[p1.move]);
        p2.stamina = Math.max(0, p2.stamina - STAMINA_COSTS[p2.move]);

        // Apply damage (Block prevents incoming damage)
        let p1Dmg = p1.move === 'block' ? 0 : DAMAGE[p2.move];
        let p2Dmg = p2.move === 'block' ? 0 : DAMAGE[p1.move];
        
        p1.hp = Math.max(0, p1.hp - p1Dmg);
        p2.hp = Math.max(0, p2.hp - p2Dmg);
    }

    // Recover stamina passively (+10 per turn)
    p1.stamina = Math.min(MAX_STAMINA, p1.stamina + 10);
    p2.stamina = Math.min(MAX_STAMINA, p2.stamina + 10);

    // Stun logic if stamina hits 0
    p1.stunned = p1.stamina <= 0;
    p2.stunned = p2.stamina <= 0;

    // Send results
    io.to(roomCode).emit('turn_result', {
        p1: { id: p1.id, move: p1.move, hp: p1.hp, stamina: p1.stamina, stunned: p1.stunned },
        p2: { id: p2.id, move: p2.move, hp: p2.hp, stamina: p2.stamina, stunned: p2.stunned }
    });

    // Reset moves for next turn
    p1.move = 'none'; p2.move = 'none';

    if (p1.hp === 0 || p2.hp === 0) {
        let winner = p1.hp > 0 ? p1.username : (p2.hp > 0 ? p2.username : 'Draw');
        io.to(roomCode).emit('game_over', winner);
        delete rooms[roomCode];
    } else {
        setTimeout(() => startGameLoop(roomCode), 2000); // Show results for 2 seconds before next countdown
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
