const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

/**
 * Arena settings
 */
const W = 12;
const H = 12;
const CORNER_ZONE = 3; // 3x3 in each corner

// ✅ UPDATED: 4 minutes total, mods every 1 minute
const MATCH_DURATION_MS = 4 * 60 * 1000;
const MOD_INTERVAL_MS = 1 * 60 * 1000;

const COOLDOWNS_BASE = {
  attack: 1200,
  heal: 8000,
  defend: 8000,
};

const rooms = new Map();

function normRoom(x) {
  return String(x || "").trim().toUpperCase();
}
function normPass(x) {
  return String(x || "").trim();
}
function clamp(n, min, max) {
  n = Number(n);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}
function now() {
  return Date.now();
}

function cornerToSpawn(corner) {
  // TL: (0..2,0..2) TR: (9..11,0..2) BL: (0..2,9..11) BR: (9..11,9..11)
  if (corner === "TL") return { x: 1, y: 1 };
  if (corner === "TR") return { x: W - 2, y: 1 };
  if (corner === "BL") return { x: 1, y: H - 2 };
  return { x: W - 2, y: H - 2 }; // BR default
}

function newPlayer({ id, name, corner, stats }) {
  const s = cornerToSpawn(corner);
  return {
    id,
    name: String(name || "Player").slice(0, 20),
    corner,
    x: s.x,
    y: s.y,
    hpMax: clamp(stats?.hpMax ?? 100, 10, 9999),
    hp: clamp(stats?.hpMax ?? 100, 1, 9999),
    atk: clamp(stats?.atk ?? 20, 1, 999),
    def: clamp(stats?.def ?? 8, 0, 999),
    heal: clamp(stats?.heal ?? 15, 0, 999),
    power: clamp(stats?.power ?? 10000, 0, 999999999),

    // skill uses
    healLeft: 6,
    defendLeft: 6,

    // status
    shield: 0,
    stink: false,
    noDamageUntil: 0,
    halfDamageUntil: 0,
    skillSpeedMultUntil: 0, // <1 => faster, >1 => slower
    powerPenaltyUntil: 0, // power reduced
    cooldownMultUntil: 0, // affects cooldowns
  };
}

function dist(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); // manhattan
}

function roomPublic(room) {
  return {
    code: room.code,
    started: room.started,
    endsAt: room.endsAt,
    nextModAt: room.nextModAt,
    tick: room.tick,
    map: {
      w: W,
      h: H,
      cornerZone: CORNER_ZONE,
      windows: room.windows, // for tomato/rose animations
    },
    players: {
      A: room.players.A
        ? {
            name: room.players.A.name,
            corner: room.players.A.corner,
            x: room.players.A.x,
            y: room.players.A.y,
            hp: room.players.A.hp,
            hpMax: room.players.A.hpMax,
            atk: room.players.A.atk,
            def: room.players.A.def,
            heal: room.players.A.heal,
            power: room.players.A.power,
            healLeft: room.players.A.healLeft,
            defendLeft: room.players.A.defendLeft,
            shield: room.players.A.shield,
            stink: room.players.A.stink,
          }
        : null,
      B: room.players.B
        ? {
            name: room.players.B.name,
            corner: room.players.B.corner,
            x: room.players.B.x,
            y: room.players.B.y,
            hp: room.players.B.hp,
            hpMax: room.players.B.hpMax,
            atk: room.players.B.atk,
            def: room.players.B.def,
            heal: room.players.B.heal,
            power: room.players.B.power,
            healLeft: room.players.B.healLeft,
            defendLeft: room.players.B.defendLeft,
            shield: room.players.B.shield,
            stink: room.players.B.stink,
          }
        : null,
    },
    winner: room.winner,
    loser: room.loser,
    stomp: room.stomp, // show gorilla stomp overlay
    log: room.log.slice(-30),
  };
}

function emitState(room) {
  io.to(room.code).emit("state", roomPublic(room));
}

function pushLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 120) room.log.shift();
  io.to(room.code).emit("log", msg);
}

function makeRoom(code, pass) {
  // 4 “windows” positions for tomato/rose throws (purely visual)
  const windows = [
    { side: "L", x: 0, y: 3 },
    { side: "L", x: 0, y: 8 },
    { side: "R", x: W - 1, y: 3 },
    { side: "R", x: W - 1, y: 8 },
  ];

  return {
    code,
    pass,
    hostId: null,
    started: false,
    endsAt: 0,
    nextModAt: 0,
    tick: 0,
    sockets: { A: null, B: null }, // socket ids
    spectators: new Set(),
    players: { A: null, B: null },
    winner: null,
    loser: null,
    stomp: null,
    windows,
    log: [],
  };
}

function canMoveTo(x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  return true;
}

function applyMod(room) {
  // Every minute: pick random bonus or malus, apply to random player
  const targetSeat = Math.random() < 0.5 ? "A" : "B";
  const p = room.players[targetSeat];
  if (!p) return;

  const isBonus = Math.random() < 0.5;
  const modType = Math.floor(Math.random() * 3) + 1; // 1..3

  // choose a random window to throw from (visual)
  const win = room.windows[Math.floor(Math.random() * room.windows.length)];
  const throwType = isBonus ? "rose" : "tomato";
  io.to(room.code).emit("throw", { throwType, from: win, toSeat: targetSeat });

  const until = now() + MOD_INTERVAL_MS;

  if (!isBonus) {
    if (modType === 1) {
      // -5000 power for 1 minute
      p.powerPenaltyUntil = until;
      pushLog(room, `🍅 MALUS: ${p.name} loses 5000 power for 1 minute!`);
    } else if (modType === 2) {
      // slower skills for 1 minute (cooldown multiplier)
      p.cooldownMultUntil = until;
      pushLog(room, `🍅 MALUS: ${p.name}'s skills recharge slower for 1 minute!`);
    } else {
      // stink clouds for 1 minute
      p.stink = true;
      pushLog(room, `🍅 MALUS: Stink clouds surround ${p.name} for 1 minute!`);
      setTimeout(() => {
        const r = rooms.get(room.code);
        if (!r?.players[targetSeat]) return;
        r.players[targetSeat].stink = false;
        emitState(r);
      }, MOD_INTERVAL_MS);
    }
  } else {
    if (modType === 1) {
      // random hits deal 0 damage for 1 minute (noDamageUntil)
      p.noDamageUntil = until;
      pushLog(room, `🌹 BONUS: ${p.name} gets a chance for NO DAMAGE on hits for 1 minute!`);
    } else if (modType === 2) {
      // faster skills for 1 minute
      p.skillSpeedMultUntil = until;
      pushLog(room, `🌹 BONUS: ${p.name}'s skills recharge faster for 1 minute!`);
    } else {
      // teleport away + half damage on being hit for 1 minute
      p.halfDamageUntil = until;
      pushLog(room, `🌹 BONUS: ${p.name} may teleport away and take HALF damage for 1 minute!`);
    }
  }

  emitState(room);
}

function effectiveCooldownMult(p) {
  // slower skills malus overrides speed bonus for simplicity
  const t = now();
  if (p.cooldownMultUntil > t) return 1.5; // slower
  if (p.skillSpeedMultUntil > t) return 0.6; // faster
  return 1.0;
}

function effectivePower(p) {
  const t = now();
  if (p.powerPenaltyUntil > t) return Math.max(0, p.power - 5000);
  return p.power;
}

function resolveAttack(room, attackerSeat) {
  const a = room.players[attackerSeat];
  const bSeat = attackerSeat === "A" ? "B" : "A";
  const d = room.players[bSeat];
  if (!a || !d) return;

  if (dist(a, d) > 1) {
    pushLog(room, `⚠️ ${a.name} is too far to attack.`);
    return;
  }

  // base damage
  let dmg = Math.max(1, Math.round(a.atk - d.def / 2));

  // defender shield reduces
  if (d.shield > 0) {
    const blocked = Math.min(dmg, d.shield);
    dmg -= blocked;
    d.shield = Math.max(0, d.shield - blocked);
    pushLog(room, `🛡 ${d.name} blocks ${blocked} damage (shield left ${d.shield}).`);
  }

  // bonus: sometimes no damage (on attacker)
  const t = now();
  if (a.noDamageUntil > t && Math.random() < 0.35) {
    dmg = 0;
    pushLog(room, `🌹 ${a.name} triggers NO DAMAGE hit!`);
  }

  // half damage + teleport bonus (on defender)
  if (d.halfDamageUntil > t) {
    dmg = Math.round(dmg / 2);
    // teleport chance
    if (Math.random() < 0.35) {
      // move defender to a random safe tile
      const nx = clamp(d.x + (Math.random() < 0.5 ? -3 : 3), 1, W - 2);
      const ny = clamp(d.y + (Math.random() < 0.5 ? -3 : 3), 1, H - 2);
      d.x = nx;
      d.y = ny;
      pushLog(room, `✨ ${d.name} TELEPORTS away!`);
    }
  }

  d.hp = Math.max(0, d.hp - dmg);
  pushLog(room, `⚔️ ${a.name} hits ${d.name} for ${dmg} dmg. (${d.hp}/${d.hpMax})`);

  if (d.hp <= 0) {
    room.winner = attackerSeat;
    room.loser = bSeat;
    room.started = false;
    room.stomp = { loserName: d.name, at: now() };
    pushLog(room, `🏆 Winner: ${a.name}`);
    pushLog(room, `🦍 Gorilla stomp: ${d.name} gets squashed!`);
  }
}

function movePlayer(room, seat, dir) {
  const p = room.players[seat];
  if (!p) return;
  let nx = p.x, ny = p.y;
  if (dir === "U") ny--;
  if (dir === "D") ny++;
  if (dir === "L") nx--;
  if (dir === "R") nx++;

  if (!canMoveTo(nx, ny)) return;

  // prevent walking onto other player cell
  const other = room.players[seat === "A" ? "B" : "A"];
  if (other && other.x === nx && other.y === ny) return;

  p.x = nx;
  p.y = ny;
}

io.on("connection", (socket) => {
  socket.data.room = null;
  socket.data.role = null;
  socket.data.seat = null;
  socket.data.cooldowns = { attack: 0, heal: 0, defend: 0 };

  socket.on("hostCreate", ({ room, pass }) => {
    const code = normRoom(room);
    const pw = normPass(pass);
    if (!code) return socket.emit("errorMsg", "Missing room code.");
    if (!pw) return socket.emit("errorMsg", "Missing password.");

    let r = rooms.get(code);
    if (!r) {
      r = makeRoom(code, pw);
      rooms.set(code, r);
    } else {
      if (r.pass !== pw) return socket.emit("errorMsg", "Wrong password.");
    }

    r.hostId = socket.id;
    socket.join(code);
    socket.data.room = code;
    socket.data.role = "host";

    pushLog(r, `🎮 Host created/joined room ${code}`);
    socket.emit("role", { role: "host" });
    emitState(r);
  });

  socket.on("spectateRoom", ({ room, pass }) => {
    const code = normRoom(room);
    const pw = normPass(pass);
    const r = rooms.get(code);
    if (!r) return socket.emit("errorMsg", "Room not found.");
    if (r.pass !== pw) return socket.emit("errorMsg", "Wrong password.");

    r.spectators.add(socket.id);
    socket.join(code);
    socket.data.room = code;
    socket.data.role = "spectator";

    socket.emit("role", { role: "spectator" });
    pushLog(r, `👀 Spectator joined ${code}`);
    emitState(r);
  });

  socket.on("joinSeat", ({ room, pass, seat, name, corner, stats }) => {
    const code = normRoom(room);
    const pw = normPass(pass);
    const r = rooms.get(code);
    if (!r) return socket.emit("errorMsg", "Room not found.");
    if (r.pass !== pw) return socket.emit("errorMsg", "Wrong password.");

    const s = seat === "B" ? "B" : "A";
    const c = ["TL","TR","BL","BR"].includes(corner) ? corner : (s === "A" ? "TL" : "BR");

    // seat taken by other?
    if (r.sockets[s] && r.sockets[s] !== socket.id) {
      return socket.emit("errorMsg", `Seat ${s} is taken.`);
    }

    r.sockets[s] = socket.id;
    r.players[s] = newPlayer({ id: socket.id, name, corner: c, stats },);

    socket.join(code);
    socket.data.room = code;
    socket.data.role = "player";
    socket.data.seat = s;
    socket.data.cooldowns = { attack: 0, heal: 0, defend: 0 };

    socket.emit("role", { role: "player", seat: s });
    pushLog(r, `🪑 ${r.players[s].name} joined seat ${s} (${c})`);
    emitState(r);
  });

  socket.on("startMatch", ({ room, pass }) => {
    const code = normRoom(room);
    const pw = normPass(pass);
    const r = rooms.get(code);
    if (!r) return socket.emit("errorMsg", "Room not found.");
    if (r.pass !== pw) return socket.emit("errorMsg", "Wrong password.");
    if (r.hostId !== socket.id) return socket.emit("errorMsg", "Only host can start.");

    if (!r.players.A || !r.players.B) return socket.emit("errorMsg", "Need Player A and B.");

    // reset
    for (const seat of ["A","B"]) {
      const p = r.players[seat];
      p.hp = p.hpMax;
      p.shield = 0;
      p.stink = false;
      p.healLeft = 6;
      p.defendLeft = 6;
      p.noDamageUntil = 0;
      p.halfDamageUntil = 0;
      p.skillSpeedMultUntil = 0;
      p.powerPenaltyUntil = 0;
      p.cooldownMultUntil = 0;
      const sp = cornerToSpawn(p.corner);
      p.x = sp.x; p.y = sp.y;
    }

    r.winner = null;
    r.loser = null;
    r.stomp = null;
    r.started = true;
    r.endsAt = now() + MATCH_DURATION_MS;
    r.nextModAt = now() + MOD_INTERVAL_MS;
    r.tick = 0;

    pushLog(r, `🏁 Match started! Duration: 4 minutes. Mods every 1 minute.`);
    emitState(r);
  });

  socket.on("move", ({ room, dir }) => {
    const code = normRoom(room);
    const r = rooms.get(code);
    if (!r || !r.started) return;
    if (socket.data.role !== "player") return;
    const seat = socket.data.seat;
    if (!seat) return;

    movePlayer(r, seat, dir);
    emitState(r);
  });

  socket.on("action", ({ room, type }) => {
    const code = normRoom(room);
    const r = rooms.get(code);
    if (!r || !r.started) return;
    if (socket.data.role !== "player") return;
    const seat = socket.data.seat;
    if (!seat) return;

    const p = r.players[seat];
    if (!p) return;

    const t = now();
    const cdMult = effectiveCooldownMult(p);

    if (type === "attack") {
      const nextOk = socket.data.cooldowns.attack || 0;
      if (t < nextOk) return;
      socket.data.cooldowns.attack = t + Math.round(COOLDOWNS_BASE.attack * cdMult);
      resolveAttack(r, seat);
      emitState(r);
    }

    if (type === "heal") {
      const nextOk = socket.data.cooldowns.heal || 0;
      if (t < nextOk) return;
      if (p.healLeft <= 0) {
        pushLog(r, `⚠️ ${p.name} has no HEAL uses left.`);
        return;
      }
      p.healLeft -= 1;
      socket.data.cooldowns.heal = t + Math.round(COOLDOWNS_BASE.heal * cdMult);

      const amount = clamp(p.heal, 0, 999);
      p.hp = Math.min(p.hpMax, p.hp + amount);
      pushLog(r, `✨ ${p.name} heals +${amount} (uses left ${p.healLeft}).`);
      emitState(r);
    }

    if (type === "defend") {
      const nextOk = socket.data.cooldowns.defend || 0;
      if (t < nextOk) return;
      if (p.defendLeft <= 0) {
        pushLog(r, `⚠️ ${p.name} has no DEFEND uses left.`);
        return;
      }
      p.defendLeft -= 1;
      socket.data.cooldowns.defend = t + Math.round(COOLDOWNS_BASE.defend * cdMult);

      p.shield += clamp(p.def + 10, 5, 200);
      pushLog(r, `🛡 ${p.name} defends (uses left ${p.defendLeft}).`);
      emitState(r);
    }
  });

  socket.on("disconnect", () => {
    const code = socket.data.room;
    if (!code) return;
    const r = rooms.get(code);
    if (!r) return;

    if (r.hostId === socket.id) r.hostId = null;
    r.spectators.delete(socket.id);

    for (const seat of ["A","B"]) {
      if (r.sockets[seat] === socket.id) {
        r.sockets[seat] = null;
        r.players[seat] = null;
      }
    }
    emitState(r);
  });
});

/**
 * Timer loop for each room: handle mods and match end.
 * We keep it very light.
 */
setInterval(() => {
  const t = now();
  for (const r of rooms.values()) {
    if (!r.started) continue;
    r.tick++;

    // apply mod each interval
    if (r.nextModAt && t >= r.nextModAt) {
      applyMod(r);
      r.nextModAt = t + MOD_INTERVAL_MS;
    }

    // end match
    if (r.endsAt && t >= r.endsAt) {
      r.started = false;

      // decide winner by remaining HP, tie by power
      const A = r.players.A;
      const B = r.players.B;
      if (A && B) {
        if (A.hp > B.hp) { r.winner = "A"; r.loser = "B"; }
        else if (B.hp > A.hp) { r.winner = "B"; r.loser = "A"; }
        else {
          const ap = effectivePower(A);
          const bp = effectivePower(B);
          if (ap >= bp) { r.winner = "A"; r.loser = "B"; }
          else { r.winner = "B"; r.loser = "A"; }
        }
        r.stomp = { loserName: r.players[r.loser].name, at: t };
        pushLog(r, `⏱️ Time! Winner: ${r.players[r.winner].name} — Loser stomped: ${r.players[r.loser].name}`);
      }
      emitState(r);
    }
  }
}, 250);

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
