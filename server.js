const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();
const RESULT_WINDOW_MS = 10 * 60 * 1000;

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(room, obj) {
  if (room.host) send(room.host, obj);
  for (const sp of room.spectators) send(sp, obj);
}

function cleanupRoom(code) {
  rooms.delete(code);
}

wss.on("connection", (ws) => {
  let roomCode = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join") {
      roomCode = String(msg.room || "").trim().toUpperCase();
      const role = msg.role === "host" ? "host" : "spectator";
      const pw = String(msg.password || "");

      if (!rooms.has(roomCode)) {
        if (role !== "host") {
          return send(ws, { type:"error", error:"Host must join first." });
        }

        rooms.set(roomCode, {
          password: pw,
          host: ws,
          spectators: new Set(),
          lastState: null,
          locked: false
        });

        return send(ws, { type:"joined", role:"host" });
      }

      const room = rooms.get(roomCode);

      if (room.password !== pw) {
        return send(ws, { type:"error", error:"Wrong password." });
      }

      if (role === "spectator") {
        room.spectators.add(ws);
        send(ws, { type:"joined", role:"spectator" });

        if (room.lastState) {
          send(ws, { type:"state", state: room.lastState });
        }
      }

      if (role === "host") {
        room.host = ws;
        send(ws, { type:"joined", role:"host" });
      }
    }

    if (msg.type === "state") {
      const room = rooms.get(roomCode);
      if (!room) return;

      room.lastState = msg.state;
      for (const sp of room.spectators) {
        send(sp, { type:"state", state: msg.state });
      }
    }

    if (msg.type === "end_match") {
      const room = rooms.get(roomCode);
      if (!room) return;

      room.locked = true;
      room.lastState = msg.state;

      broadcast(room, { type:"match_ended", state: msg.state });

      setTimeout(() => cleanupRoom(roomCode), RESULT_WINDOW_MS);
    }
  });

  ws.on("close", () => {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.spectators.delete(ws);
    if (room.host === ws) room.host = null;

    if (!room.host && room.spectators.size === 0) {
      rooms.delete(roomCode);
    }
  });
});

server.listen(process.env.PORT || 3000);
