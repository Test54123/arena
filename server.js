const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
});

const rooms = new Map();

function normRoom(x) {
  return String(x || "").trim().toUpperCase();
}

function clamp(n, min, max) {
  n = Number(n);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function makePlayer({ name, hp, atk, def, heal }, socketId) {
  const maxHp = clamp(hp, 10, 9999);
  return {
    name: String(name || "Player").slice(0, 30),
    hp: maxHp,
    maxHp,
    atk: clamp(atk, 1, 999),
    def: clamp(def, 0, 999),
    heal: clamp(heal, 0, 999),
    shield: 0,      // reduces next damage
    socketId,
  };
}

function roomStatePublic(room) {
  // only the safe state for clients
  return {
    code: room.code,
    started: room.started,
    turn: room.turn, // "A" or "B"
    players: {
      A: room.players.A
        ? {
            name: room.players.A.name,
            hp: room.players.A.hp,
            maxHp: room.players.A.maxHp,
            atk: room.players.A.atk,
            def: room.players.A.def,
            heal: room.players.A.heal,
            shield: room.players.A.shield,
          }
        : null,
      B: room.players.B
        ? {
            name: room.players.B.name,
            hp: room.players.B.hp,
            maxHp: room.players.B.maxHp,
            atk: room.players.B.atk,
            def: room.players.B.def,
            heal: room.players.B.heal,
            shield: room.players.B.shield,
          }
        : null,
    },
    winner: room.winner, // "A" | "B" | null
  };
}

function emitState(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit("state", roomStatePublic(room));
}

function logToRoom(code, msg) {
  io.to(code).emit("log", msg);
}

function ensureRoom(code, pass) {
  code = normRoom(code);
  if (!code) return { ok: false, error: "Missing room code." };

  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      pass: String(pass || ""),
      hostId: null,
      spectators: new Set(),
      players: { A: null, B: null },
      started: false,
      turn: "A",
      winner: null,
    };
    rooms.set(code, room);
  }
  // if room exists, verify password
  if (room.pass !== String(pass || "")) {
    return { ok: false, error: "Wrong password." };
  }
  return { ok: true, room };
}

function seatOf(socketId, room) {
  if (room.players.A?.socketId === socketId) return "A";
  if (room.players.B?.socketId === socketId) return "B";
  return null;
}

function otherSeat(seat) {
  return seat === "A" ? "B" : "A";
}

function canAct(room) {
  return (
    room.started &&
    !room.winner &&
    room.players.A &&
    room.players.B &&
    (room.turn === "A" || room.turn === "B")
  );
}

function endIfDead(room) {
  const A = room.players.A;
  const B = room.players.B;
  if (!A || !B) return;

  if (A.hp <= 0 && B.hp <= 0) {
    // draw -> choose none (or you can decide)
    room.winner = null;
    room.started = false;
    return;
  }
  if (A.hp <= 0) {
    room.winner = "B";
    room.started = false;
  } else if (B.hp <= 0) {
    room.winner = "A";
    room.started = false;
  }
}

io.on("connection", (socket) => {
  socket.emit("log", "✅ Connected to server!");

  socket.on("hostRoom", ({ room, pass }) => {
    const code = normRoom(room);
    const res = ensureRoom(code, pass);
    if (!res.ok) return socket.emit("errorMsg", res.error);

    const r = res.room;
    r.hostId = socket.id;

    socket.join(code);
    socket.emit("role", { role: "host", seat: null, room: code });
    logToRoom(code, "🎮 Host joined room: " + code);
    emitState(code);
  });

  socket.on("spectateRoom", ({ room, pass }) => {
    const code = normRoom(room);
    const res = ensureRoom(code, pass);
    if (!res.ok) return socket.emit("errorMsg", res.error);

    const r = res.room;
    r.spectators.add(socket.id);

    socket.join(code);
    socket.emit("role", { role: "spectator", seat: null, room: code });
    logToRoom(code, "👀 Spectator joined: " + code);
    emitState(code);
  });

  socket.on("joinSeat", ({ room, pass, seat, name, hp, atk, def, heal }) => {
    const code = normRoom(room);
    const res = ensureRoom(code, pass);
    if (!res.ok) return socket.emit("errorMsg", res.error);

    const r = res.room;
    const s = seat === "B" ? "B" : "A";

    // kick from previous seat if same socket
    const prev = seatOf(socket.id, r);
    if (prev) r.players[prev] = null;

    // seat already taken by another socket?
    if (r.players[s] && r.players[s].socketId !== socket.id) {
      return socket.emit("errorMsg", `Seat ${s} already taken.`);
    }

    r.players[s] = makePlayer({ name, hp, atk, def, heal }, socket.id);

    socket.join(code);
    socket.emit("role", { role: "player", seat: s, room: code });
    logToRoom(code, `🪑 ${r.players[s].name} joined seat ${s}`);
    emitState(code);
  });

  socket.on("startGame", ({ room, pass, aName, bName }) => {
    const code = normRoom(room);
    const res = ensureRoom(code, pass);
    if (!res.ok) return socket.emit("errorMsg", res.error);

    const r = res.room;

    if (r.hostId !== socket.id) {
      return socket.emit("errorMsg", "Only host can start/reset.");
    }
    if (!r.players.A || !r.players.B) {
      return socket.emit("errorMsg", "Need Player A and Player B first.");
    }

    // optional override names from host inputs
    if (aName) r.players.A.name = String(aName).slice(0, 30);
    if (bName) r.players.B.name = String(bName).slice(0, 30);

    // reset combat state
    r.players.A.hp = r.players.A.maxHp;
    r.players.B.hp = r.players.B.maxHp;
    r.players.A.shield = 0;
    r.players.B.shield = 0;
    r.turn = "A";
    r.winner = null;
    r.started = true;

    logToRoom(code, "🔄 Game started / reset!");
    logToRoom(code, `➡️ Turn: ${r.players.A.name} (A)`);
    emitState(code);
  });

  socket.on("action", ({ room, pass, type }) => {
    const code = normRoom(room);
    const res = ensureRoom(code, pass);
    if (!res.ok) return socket.emit("errorMsg", res.error);

    const r = res.room;
    const seat = seatOf(socket.id, r);
    if (!seat) return socket.emit("errorMsg", "You are not a player seat.");
    if (!canAct(r)) return socket.emit("errorMsg", "Game not ready.");
    if (r.turn !== seat) return socket.emit("errorMsg", "Not your turn.");

    const me = r.players[seat];
    const oppSeat = otherSeat(seat);
    const them = r.players[oppSeat];

    if (!me || !them) return;

    // clear my shield only when I get hit (so no change here)
    // action logic
    if (type === "defend") {
      // shield reduces next damage by (def + 10) capped
      me.shield = clamp(me.def + 10, 5, 200);
      logToRoom(code, `🛡 ${me.name} defends (shield +${me.shield})`);
    } else if (type === "heal") {
      const amount = clamp(me.heal, 0, 999);
      if (amount <= 0) {
        logToRoom(code, `✨ ${me.name} tried to heal, but heal is 0.`);
      } else {
        const before = me.hp;
        me.hp = clamp(me.hp + amount, 0, me.maxHp);
        const gained = me.hp - before;
        logToRoom(code, `✨ ${me.name} heals +${gained} HP`);
      }
    } else {
      // attack default
      // base damage: atk - defender.def/2
      let dmg = Math.max(1, Math.round(me.atk - them.def / 2));

      // apply defender shield if any
      if (them.shield > 0) {
        const blocked = Math.min(dmg, them.shield);
        dmg -= blocked;
        them.shield = Math.max(0, them.shield - blocked);
        logToRoom(code, `🛡 ${them.name} blocks ${blocked} dmg (shield left ${them.shield})`);
      }

      // still at least 0
      dmg = Math.max(0, dmg);
      them.hp = clamp(them.hp - dmg, 0, them.maxHp);

      logToRoom(code, `⚔️ ${me.name} attacks → ${them.name} takes ${dmg} dmg (HP ${them.hp}/${them.maxHp})`);
    }

    endIfDead(r);

    if (r.winner) {
      const winPlayer = r.players[r.winner];
      logToRoom(code, `🏆 Winner: ${winPlayer?.name || r.winner}`);
      emitState(code);
      return;
    }

    // switch turn
    r.turn = oppSeat;
    const next = r.players[r.turn];
    logToRoom(code, `➡️ Turn: ${next.name} (${r.turn})`);

    emitState(code);
  });

  socket.on("disconnect", () => {
    // remove socket from any rooms/roles
    for (const [code, r] of rooms.entries()) {
      if (r.hostId === socket.id) r.hostId = null;
      r.spectators.delete(socket.id);

      const s = seatOf(socket.id, r);
      if (s) {
        logToRoom(code, `👋 ${r.players[s]?.name || "A player"} left seat ${s}`);
        r.players[s] = null;
        r.started = false;
        r.winner = null;
      }

      emitState(code);

      // optional: clean empty rooms
      const hasAny =
        r.hostId || r.players.A || r.players.B || (r.spectators && r.spectators.size > 0);
      if (!hasAny) rooms.delete(code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
