const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);

// Socket.IO (Render/HTTPS-safe)
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
});

const rooms = new Map(); // roomCode -> { hostSocketId, spectators:Set(socketId), password, lastResult }

function normRoom(x) {
  return String(x || "").trim().toUpperCase();
}
function normPass(x) {
  return String(x || "").trim();
}

function getOrCreateRoom(roomCode, password) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      hostSocketId: null,
      spectators: new Set(),
      password,
      lastResult: null,
    });
  }
  return rooms.get(roomCode);
}

function cleanupRoomIfEmpty(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const hasHost = !!room.hostSocketId;
  const hasSpectators = room.spectators.size > 0;
  if (!hasHost && !hasSpectators) rooms.delete(roomCode);
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // HOST creates/joins room
  socket.on("hostRoom", ({ room, pass }) => {
    const r = normRoom(room);
    const p = normPass(pass);

    if (!r) return;

    const existing = rooms.get(r);
    if (existing && existing.password !== p) {
      socket.emit("errorMsg", "❌ Wrong password for this room.");
      return;
    }

    const roomObj = getOrCreateRoom(r, p);
    roomObj.hostSocketId = socket.id;

    socket.join(r);
    socket.data.room = r;
    socket.data.role = "host";

    socket.emit("statusMsg", `🎮 Hosting room: ${r}`);

    // If we already have a lastResult, host can re-send later; spectators will get it on join
  });

  // SPECTATOR joins room
  socket.on("spectateRoom", ({ room, pass }) => {
    const r = normRoom(room);
    const p = normPass(pass);

    const roomObj = rooms.get(r);
    if (!roomObj) {
      socket.emit("errorMsg", "❌ Room not found. Host must create it first.");
      return;
    }
    if (roomObj.password !== p) {
      socket.emit("errorMsg", "❌ Wrong password.");
      return;
    }

    roomObj.spectators.add(socket.id);

    socket.join(r);
    socket.data.room = r;
    socket.data.role = "spectator";

    socket.emit("statusMsg", `👀 Watching room: ${r}`);

    // Send last result immediately if available
    if (roomObj.lastResult) {
      socket.emit("matchResult", roomObj.lastResult);
    }
  });

  // Host sends result to server, server broadcasts to room
  socket.on("matchResult", ({ room, password, result }) => {
    const r = normRoom(room);
    const p = normPass(password);

    const roomObj = rooms.get(r);
    if (!roomObj) return;

    // Only allow correct password
    if (roomObj.password !== p) return;

    // Optional: only host may send
    if (roomObj.hostSocketId !== socket.id) return;

    roomObj.lastResult = result;

    io.to(r).emit("matchResult", result);
    console.log("Broadcast result to room:", r);
  });

  socket.on("disconnect", () => {
    const r = socket.data.room;
    const role = socket.data.role;

    if (r && rooms.has(r)) {
      const roomObj = rooms.get(r);

      if (role === "host" && roomObj.hostSocketId === socket.id) {
        roomObj.hostSocketId = null;
      }
      if (role === "spectator") {
        roomObj.spectators.delete(socket.id);
      }

      cleanupRoomIfEmpty(r);
    }

    console.log("Disconnected:", socket.id);
  });
});

// Render Port
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
