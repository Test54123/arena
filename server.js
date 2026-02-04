const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ---------- GAME CONFIG ----------
const GRID_W = 4;
const GRID_H = 4;
const GAME_DURATION_MS = 4 * 60 * 1000; // 4 minutes
const EVENT_INTERVAL_MS = 60 * 1000; // every minute
const MAX_DEFEND = 6;
const MAX_HEAL = 6;

function clampInt(n, min, max, fallback) {
  const x = Number.parseInt(n, 10);
  if (Number.isNaN(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

function now() {
  return Date.now();
}

function cornerType(x, y) {
  if (x === 0 && y === 0) return "NW";
  if (x === GRID_W - 1 && y === 0) return "NE";
  if (x === 0 && y === GRID_H - 1) return "SW";
  if (x === GRID_W - 1 && y === GRID_H - 1) return "SE";
  return null;
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// --- Kraft helpers (server stores kraft for display) ---
function parseKraftValue(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).replace(/\./g, "").replace(/\s/g, "").trim();
  const x = Number.parseInt(s, 10);
  return Number.isFinite(x) ? x : 0;
}

function normalizeKraft(k) {
  const squad = parseKraftValue(k?.squad);
  const build = parseKraftValue(k?.build);
  const tech = parseKraftValue(k?.tech);
  const gov = parseKraftValue(k?.gov);
  const hero = parseKraftValue(k?.hero);
  const pet = parseKraftValue(k?.pet);
  const total = squad + build + tech + gov + hero + pet;
  return { squad, build, tech, gov, hero, pet, total };
}

function initialPlayerState(seat, name, stats) {
  const pos = seat === "A" ? { x: 0, y: 0 } : { x: GRID_W - 1, y: GRID_H - 1 };
  const kraft = normalizeKraft(stats?.kraft || {});
  return {
    seat,
    name: name || (seat === "A" ? "Player A" : "Player B"),
    connected: true,
    hpMax: clampInt(stats.hpMax, 10, 200, 50),
    atk: clampInt(stats.atk, 1, 50, 10),
    def: clampInt(stats.def, 0, 50, 5),
    kraft,
    hp: clampInt(stats.hpMax, 10, 200, 50),
    pos,
    usedDefend: 0,
    usedHeal: 0,
    shield: 0,
    socketId: null,
  };
}

const rooms = {};

function safeStateForClients(room) {
  const r = rooms[room];
  if (!r) return null;

  function packPlayer(p) {
    if (!p) return null;
    return {
      name: p.name,
      connected: p.connected,
      hp: p.hp,
      hpMax: p.hpMax,
      atk: p.atk,
      def: p.def,
      pos: p.pos,
      usedDefend: p.usedDefend,
      usedHeal: p.usedHeal,
      shield: p.shield,
      kraft: p.kraft || { squad: 0, build: 0, tech: 0, gov: 0, hero: 0, pet: 0, total: 0 },
    };
  }

  return {
    room,
    grid: { w: GRID_W, h: GRID_H },
    started: r.started,
    startTime: r.startTime,
    endTime: r.endTime,
    timeLeftMs: r.started ? Math.max(0, r.endTime - now()) : null,
    lastEvent: r.lastEvent || null,
    log: r.log.slice(-60),
    host: { connected: !!r.hostId },
    players: {
      A: packPlayer(r.players.A),
      B: packPlayer(r.players.B),
    },
  };
}

function emitState(room) {
  const state = safeStateForClients(room);
  if (!state) return;
  io.to(room).emit("state", state);
}

function roomLog(room, msg) {
  const r = rooms[room];
  if (!r) return;
  const stamp = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  r.log.push(`[${stamp}] ${msg}`);
  emitState(room);
}

function ensureRoom(room, pass) {
  if (!rooms[room]) {
    rooms[room] = {
      pass,
      hostId: null,
      players: { A: null, B: null },
      started: false,
      startTime: null,
      endTime: null,
      lastEvent: null,
      log: [],
      timers: { event: null, tick: null },
    };
  }
}

function stopTimers(room) {
  const r = rooms[room];
  if (!r) return;
  if (r.timers.event) clearInterval(r.timers.event);
  if (r.timers.tick) clearInterval(r.timers.tick);
  r.timers.event = null;
  r.timers.tick = null;
}

function resetGame(room) {
  const r = rooms[room];
  if (!r) return;

  r.started = false;
  r.startTime = null;
  r.endTime = null;
  r.lastEvent = null;
  stopTimers(room);

  ["A", "B"].forEach((seat) => {
    if (r.players[seat]) {
      const p = r.players[seat];
      p.hp = p.hpMax;
      p.usedDefend = 0;
      p.usedHeal = 0;
      p.shield = 0;
      p.pos = seat === "A" ? { x: 0, y: 0 } : { x: GRID_W - 1, y: GRID_H - 1 };
      p.connected = true;
    }
  });

  roomLog(room, "🔄 Game reset.");
}

function endGame(room, reason) {
  const r = rooms[room];
  if (!r) return;
  r.started = false;
  stopTimers(room);
  roomLog(room, `⏱️ Game ended: ${reason}`);
}

function applyMinuteEvent(room, minuteIndex) {
  const r = rooms[room];
  if (!r || !r.started) return;

  const events = [
    { id: "atkUpA", text: "✨ Player A +2 ATK", fn: () => { if (r.players.A) r.players.A.atk += 2; } },
    { id: "atkUpB", text: "✨ Player B +2 ATK", fn: () => { if (r.players.B) r.players.B.atk += 2; } },
    { id: "defUpA", text: "🛡️ Player A +2 DEF", fn: () => { if (r.players.A) r.players.A.def += 2; } },
    { id: "defUpB", text: "🛡️ Player B +2 DEF", fn: () => { if (r.players.B) r.players.B.def += 2; } },
    { id: "atkDownBoth", text: "💀 Both -1 ATK", fn: () => {
      if (r.players.A) r.players.A.atk = Math.max(1, r.players.A.atk - 1);
      if (r.players.B) r.players.B.atk = Math.max(1, r.players.B.atk - 1);
    }},
    { id: "defDownBoth", text: "💀 Both -1 DEF", fn: () => {
      if (r.players.A) r.players.A.def = Math.max(0, r.players.A.def - 1);
      if (r.players.B) r.players.B.def = Math.max(0, r.players.B.def - 1);
    }},
    { id: "healBoth", text: "🌿 Both heal +5 HP", fn: () => {
      if (r.players.A) r.players.A.hp = Math.min(r.players.A.hpMax, r.players.A.hp + 5);
      if (r.players.B) r.players.B.hp = Math.min(r.players.B.hpMax, r.players.B.hp + 5);
    }},
  ];

  const pick = events[Math.floor(Math.random() * events.length)];
  pick.fn();
  r.lastEvent = { minute: minuteIndex, text: pick.text, id: pick.id };
  roomLog(room, `⏳ Minute event #${minuteIndex}: ${pick.text}`);
}

function startGame(room) {
  const r = rooms[room];
  if (!r) return;

  if (!r.players.A || !r.players.B) {
    roomLog(room, "⚠️ Need both Player A and Player B to start.");
    return;
  }

  resetGame(room);
  r.started = true;
  r.startTime = now();
  r.endTime = r.startTime + GAME_DURATION_MS;

  roomLog(room, "🚀 Game started! Duration: 4:00");

  let minuteIndex = 0;

  r.timers.event = setInterval(() => {
    if (!r.started) return;
    minuteIndex += 1;
    applyMinuteEvent(room, minuteIndex);
  }, EVENT_INTERVAL_MS);

  r.timers.tick = setInterval(() => {
    if (!r.started) return;

    const A = r.players.A;
    const B = r.players.B;
    if (A && A.hp <= 0) return endGame(room, "Player B wins (Player A defeated) 🏆");
    if (B && B.hp <= 0) return endGame(room, "Player A wins (Player B defeated) 🏆");

    if (now() >= r.endTime) {
      const aHp = A ? A.hp : 0;
      const bHp = B ? B.hp : 0;
      if (aHp > bHp) endGame(room, "Time up — Player A wins 🏆");
      else if (bHp > aHp) endGame(room, "Time up — Player B wins 🏆");
      else endGame(room, "Time up — Draw 🤝");
    }

    emitState(room);
  }, 500);

  emitState(room);
}

// ---------- room helpers ----------
function validateRoomCode(room) {
  if (typeof room !== "string") return null;
  const r = room.trim();
  if (!r) return null;
  if (r.length > 20) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(r)) return null;
  return r;
}

function checkPass(r, pass) {
  return r.pass === pass;
}

function socketRoleInRoom(socket, room) {
  const r = rooms[room];
  if (!r) return { role: "none", seat: null };

  if (r.hostId === socket.id) return { role: "host", seat: null };
  if (r.players.A && r.players.A.socketId === socket.id) return { role: "player", seat: "A" };
  if (r.players.B && r.players.B.socketId === socket.id) return { role: "player", seat: "B" };
  return { role: "spectator", seat: null };
}

// ---------- SOCKETS ----------
io.on("connection", (socket) => {
  socket.emit("hello", { ok: true });

  socket.on("hostRoom", ({ room, pass }) => {
    const code = validateRoomCode(room);
    if (!code) return socket.emit("errorMsg", "Invalid room code.");
    const p = String(pass || "").trim();
    if (!p) return socket.emit("errorMsg", "Password required.");

    if (!rooms[code]) {
      ensureRoom(code, p);
      roomLog(code, `🏠 Room created by host.`);
    } else {
      if (!checkPass(rooms[code], p)) return socket.emit("errorMsg", "Wrong password.");
    }

    rooms[code].hostId = socket.id;

    socket.join(code);
    socket.data.room = code;

    // host role
    socket.emit("role", { role: "host" });

    roomLog(code, `🎮 Host connected.`);
    emitState(code);
  });

  socket.on("spectateRoom", ({ room, pass }) => {
    const code = validateRoomCode(room);
    if (!code) return socket.emit("errorMsg", "Invalid room code.");
    const r = rooms[code];
    if (!r) return socket.emit("errorMsg", "Room does not exist.");
    if (!checkPass(r, String(pass || "").trim())) return socket.emit("errorMsg", "Wrong password.");

    socket.join(code);
    socket.data.room = code;
    socket.emit("role", { role: "spectator" });
    roomLog(code, `👀 Spectator joined.`);
    emitState(code);
  });

  socket.on("joinSeat", ({ room, pass, seat, name, stats }) => {
    const code = validateRoomCode(room);
    if (!code) return socket.emit("errorMsg", "Invalid room code.");
    const r = rooms[code];
    if (!r) return socket.emit("errorMsg", "Room does not exist.");
    if (!checkPass(r, String(pass || "").trim())) return socket.emit("errorMsg", "Wrong password.");
    if (seat !== "A" && seat !== "B") return socket.emit("errorMsg", "Seat must be A or B.");

    if (r.players[seat] && r.players[seat].socketId && r.players[seat].socketId !== socket.id) {
      return socket.emit("errorMsg", `Seat ${seat} already taken.`);
    }

    const cleanName = String(name || "").trim().slice(0, 20) || (seat === "A" ? "PlayerA" : "PlayerB");
    const st = stats || {};
    const player = r.players[seat]
      ? r.players[seat]
      : initialPlayerState(seat, cleanName, st);

    if (!r.started) {
      player.name = cleanName;
      player.hpMax = clampInt(st.hpMax, 10, 200, player.hpMax);
      player.atk = clampInt(st.atk, 1, 50, player.atk);
      player.def = clampInt(st.def, 0, 50, player.def);
      player.hp = player.hpMax;
      player.kraft = normalizeKraft(st.kraft || {});
    }

    player.socketId = socket.id;
    player.connected = true;
    r.players[seat] = player;

    socket.join(code);
    socket.data.room = code;

    // IMPORTANT FIX:
    // If this socket is also the host, keep role as "host" (and send seat info).
    if (r.hostId === socket.id) {
      socket.emit("role", { role: "host", seat });
    } else {
      socket.emit("role", { role: "player", seat });
    }

    roomLog(code, `🧍 Player ${seat} joined as "${player.name}".`);
    emitState(code);
  });

  socket.on("hostStartReset", ({ room, pass, action }) => {
    const code = validateRoomCode(room);
    if (!code) return;
    const r = rooms[code];
    if (!r) return;
    if (!checkPass(r, String(pass || "").trim())) return;
    if (r.hostId !== socket.id) return socket.emit("errorMsg", "Only host can do that.");

    if (action === "start") {
      startGame(code);
    } else if (action === "reset") {
      resetGame(code);
      emitState(code);
    }
  });

  socket.on("move", ({ room, pass, dir }) => {
    const code = validateRoomCode(room);
    if (!code) return;
    const r = rooms[code];
    if (!r) return;
    if (!checkPass(r, String(pass || "").trim())) return;

    const role = socketRoleInRoom(socket, code);
    if (role.role !== "player") return;

    if (!r.started) return socket.emit("errorMsg", "Game not started.");

    const p = r.players[role.seat];
    if (!p) return;

    const delta = {
      up: { x: 0, y: -1 },
      down: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    }[dir];

    if (!delta) return;

    const nx = p.pos.x + delta.x;
    const ny = p.pos.y + delta.y;

    if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) return;

    const otherSeat = role.seat === "A" ? "B" : "A";
    const o = r.players[otherSeat];
    if (o && o.pos.x === nx && o.pos.y === ny) {
      return socket.emit("errorMsg", "Tile occupied.");
    }

    p.pos = { x: nx, y: ny };
    const corner = cornerType(nx, ny);
    if (corner) roomLog(code, `📍 ${p.name} reached corner ${corner}.`);

    emitState(code);
  });

  socket.on("action", ({ room, pass, type }) => {
    const code = validateRoomCode(room);
    if (!code) return;
    const r = rooms[code];
    if (!r) return;
    if (!checkPass(r, String(pass || "").trim())) return;

    const role = socketRoleInRoom(socket, code);
    if (role.role !== "player") return;

    if (!r.started) return socket.emit("errorMsg", "Game not started.");

    const me = r.players[role.seat];
    const them = r.players[role.seat === "A" ? "B" : "A"];
    if (!me || !them) return;

    if (type === "defend") {
      if (me.usedDefend >= MAX_DEFEND) return socket.emit("errorMsg", "Defend limit reached.");
      me.usedDefend += 1;
      me.shield = 1;
      roomLog(code, `🛡️ ${me.name} uses DEFEND (${me.usedDefend}/${MAX_DEFEND}).`);
      return emitState(code);
    }

    if (type === "heal") {
      if (me.usedHeal >= MAX_HEAL) return socket.emit("errorMsg", "Heal limit reached.");
      me.usedHeal += 1;
      const amount = 10;
      me.hp = Math.min(me.hpMax, me.hp + amount);
      roomLog(code, `✨ ${me.name} heals +${amount} (${me.usedHeal}/${MAX_HEAL}).`);
      return emitState(code);
    }

    if (type === "attack") {
      if (manhattan(me.pos, them.pos) !== 1) return socket.emit("errorMsg", "You must be adjacent to attack.");

      let dmg = Math.max(1, me.atk - them.def);
      if (them.shield > 0) {
        dmg = Math.max(1, Math.floor(dmg / 2));
        them.shield = 0;
        roomLog(code, `🛡️ ${them.name}'s shield reduces damage!`);
      }

      them.hp -= dmg;
      roomLog(code, `⚔️ ${me.name} attacks ${them.name} for ${dmg} damage.`);
      if (them.hp <= 0) {
        them.hp = 0;
        endGame(code, `${me.name} wins 🏆`);
      }
      return emitState(code);
    }
  });

  socket.on("requestState", ({ room }) => {
    const code = validateRoomCode(room);
    if (!code) return;
    emitState(code);
  });

  socket.on("disconnect", () => {
    const room = socket.data.room;
    if (!room || !rooms[room]) return;

    const r = rooms[room];

    if (r.hostId === socket.id) {
      r.hostId = null;
      roomLog(room, "🎮 Host disconnected.");
    }

    ["A", "B"].forEach((seat) => {
      if (r.players[seat] && r.players[seat].socketId === socket.id) {
        r.players[seat].connected = false;
        r.players[seat].socketId = null;
        roomLog(room, `🧍 Player ${seat} disconnected.`);
      }
    });

    emitState(room);
  });
});

server.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
