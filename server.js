const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] }
});

// rooms: Map<roomCode, roomObj>
const rooms = new Map();

function normRoom(x) {
  return String(x || "").trim().toUpperCase();
}

function now() {
  return new Date().toISOString();
}

function newGameState(playerAName, playerBName) {
  return {
    started: false,
    turn: "A", // "A" or "B"
    players: {
      A: { name: playerAName || "PlayerA", hp: 30, defending: false },
      B: { name: playerBName || "PlayerB", hp: 30, defending: false }
    },
    log: [
      { t: now(), msg: "Room created. Waiting to start…" }
    ]
  };
}

function pushLog(room, msg) {
  room.game.log.push({ t: now(), msg });
  // keep log reasonable
  if (room.game.log.length > 60) room.game.log.shift();
}

function emitState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit("state", {
    room: roomCode,
    game: room.game
  });
}

function emitError(socket, msg) {
  socket.emit("errorMsg", msg);
}

io.on("connection", (socket) => {
  socket.emit("serverHello", { ok: true });

  // Create / host a room
  socket.on("hostRoom", ({ room, pass }) => {
    const roomCode = normRoom(room);
    const password = String(pass || "").trim();

    if (!roomCode) return emitError(socket, "Room code missing.");
    if (!password) return emitError(socket, "Password missing.");

    // Create new room (overwrite protection)
    if (rooms.has(roomCode)) {
      return emitError(socket, "Room already exists. Choose another code.");
    }

    const roomObj = {
      pass: password,
      hostId: socket.id,
      createdAt: now(),
      seats: { A: null, B: null }, // socket ids
      watchers: new Set(),
      game: newGameState("PlayerA", "PlayerB")
    };

    rooms.set(roomCode, roomObj);
    socket.join(roomCode);
    socket.data.room = roomCode;
    socket.data.role = "HOST";

    pushLog(roomObj, `Host connected (${socket.id}).`);
    socket.emit("joined", { room: roomCode, role: "HOST" });
    emitState(roomCode);
  });

  // Join as player (A or B)
  socket.on("joinPlayer", ({ room, pass, seat, name }) => {
    const roomCode = normRoom(room);
    const password = String(pass || "").trim();
    const s = (seat === "A" || seat === "B") ? seat : null;
    const playerName = String(name || "").trim().slice(0, 20);

    const roomObj = rooms.get(roomCode);
    if (!roomObj) return emitError(socket, "Room not found.");
    if (roomObj.pass !== password) return emitError(socket, "Wrong password.");
    if (!s) return emitError(socket, "Seat must be A or B.");

    if (roomObj.seats[s] && roomObj.seats[s] !== socket.id) {
      return emitError(socket, `Seat ${s} is already taken.`);
    }

    // If this socket was in another role in same room, clean old role
    if (socket.data.room === roomCode && socket.data.role) {
      // nothing special needed here
    }

    roomObj.seats[s] = socket.id;

    socket.join(roomCode);
    socket.data.room = roomCode;
    socket.data.role = `PLAYER_${s}`;
    socket.data.seat = s;

    // update name
    if (playerName) roomObj.game.players[s].name = playerName;

    pushLog(roomObj, `Player ${s} joined as "${roomObj.game.players[s].name}".`);
    socket.emit("joined", { room: roomCode, role: `PLAYER_${s}`, seat: s });
    emitState(roomCode);
  });

  // Join as spectator
  socket.on("spectateRoom", ({ room, pass }) => {
    const roomCode = normRoom(room);
    const password = String(pass || "").trim();

    const roomObj = rooms.get(roomCode);
    if (!roomObj) return emitError(socket, "Room not found.");
    if (roomObj.pass !== password) return emitError(socket, "Wrong password.");

    roomObj.watchers.add(socket.id);

    socket.join(roomCode);
    socket.data.room = roomCode;
    socket.data.role = "SPECTATOR";

    pushLog(roomObj, `Spectator connected (${socket.id}).`);
    socket.emit("joined", { room: roomCode, role: "SPECTATOR" });
    emitState(roomCode);
  });

  // Host starts game and sets names
  socket.on("startGame", ({ room, playerAName, playerBName }) => {
    const roomCode = normRoom(room);
    const roomObj = rooms.get(roomCode);
    if (!roomObj) return emitError(socket, "Room not found.");

    if (socket.id !== roomObj.hostId) {
      return emitError(socket, "Only host can start the game.");
    }

    const aName = String(playerAName || "").trim().slice(0, 20) || roomObj.game.players.A.name;
    const bName = String(playerBName || "").trim().slice(0, 20) || roomObj.game.players.B.name;

    roomObj.game = newGameState(aName, bName);
    roomObj.game.started = true;
    pushLog(roomObj, `Game started! ${aName} vs ${bName}. Turn: A`);
    emitState(roomCode);
  });

  // Player action: attack / heal / defend
  socket.on("action", ({ room, type }) => {
    const roomCode = normRoom(room);
    const roomObj = rooms.get(roomCode);
    if (!roomObj) return emitError(socket, "Room not found.");
    if (!roomObj.game.started) return emitError(socket, "Game not started.");

    const role = socket.data.role;
    if (role !== "PLAYER_A" && role !== "PLAYER_B") {
      return emitError(socket, "Only players can act.");
    }

    const seat = socket.data.seat; // "A" or "B"
    if (roomObj.seats[seat] !== socket.id) {
      return emitError(socket, "You are not bound to that seat anymore.");
    }

    // Turn check
    if (roomObj.game.turn !== seat) {
      return emitError(socket, "Not your turn.");
    }

    const me = roomObj.game.players[seat];
    const otherSeat = seat === "A" ? "B" : "A";
    const them = roomObj.game.players[otherSeat];

    // reset defending flag when a player starts their turn? (simple model)
    // We'll clear defending on the acting player at the start of their move,
    // and clear defending on opponent when they have acted previously.
    // For clarity: defending only reduces next incoming attack.
    // So we do NOT clear opponent defending until it is used.
    me.defending = false;

    if (type === "defend") {
      me.defending = true;
      pushLog(roomObj, `${me.name} braces for impact (DEFEND).`);
    } else if (type === "heal") {
      const heal = 5;
      me.hp = Math.min(30, me.hp + heal);
      pushLog(roomObj, `${me.name} heals +${heal} HP.`);
    } else if (type === "attack") {
      let dmg = 6;
      if (them.defending) {
        dmg = 3;
        them.defending = false; // consumed
        pushLog(roomObj, `${them.name} defended! Damage reduced.`);
      }
      them.hp = Math.max(0, them.hp - dmg);
      pushLog(roomObj, `${me.name} attacks for ${dmg} damage.`);
    } else {
      return emitError(socket, "Unknown action.");
    }

    // check win
    if (them.hp <= 0) {
      pushLog(roomObj, `🏆 ${me.name} wins!`);
      roomObj.game.started = false; // stop further actions
      emitState(roomCode);
      return;
    }

    // next turn
    roomObj.game.turn = otherSeat;
    pushLog(roomObj, `Turn: ${roomObj.game.turn}`);
    emitState(roomCode);
  });

  // Clean up on disconnect
  socket.on("disconnect", () => {
    const roomCode = socket.data.room;
    if (!roomCode) return;

    const roomObj = rooms.get(roomCode);
    if (!roomObj) return;

    // remove from seats
    if (roomObj.seats.A === socket.id) roomObj.seats.A = null;
    if (roomObj.seats.B === socket.id) roomObj.seats.B = null;

    // remove spectator
    roomObj.watchers.delete(socket.id);

    // if host left -> close room
    if (roomObj.hostId === socket.id) {
      io.to(roomCode).emit("errorMsg", "Host left. Room closed.");
      rooms.delete(roomCode);
      return;
    }

    pushLog(roomObj, `User disconnected (${socket.id}).`);
    emitState(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
