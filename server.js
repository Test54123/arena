const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
});

const rooms = new Map(); // roomCode -> { password, hostId, lastResult, createdAt }

function normRoom(x) {
  return String(x || "").trim().toUpperCase();
}
function normPass(x) {
  return String(x || "").trim();
}

function getRoom(roomCode) {
  const r = rooms.get(roomCode);
  if (!r) return null;
  return r;
}

function cleanupRoomIfEmpty(roomCode) {
  const r = rooms.get(roomCode);
  if (!r) return;
  const socketsInRoom = io.sockets.adapter.rooms.get(roomCode);
  if (!socketsInRoom || socketsInRoom.size === 0) {
    rooms.delete(roomCode);
  }
}

io.on("connection", (socket) => {
  socket.data.room = null;
  socket.data.role = null; // "host" | "spectator"

  socket.on("join", ({ room, password, role }) => {
    const roomCode = normRoom(room);
    const pw = normPass(password);
    const r = role === "host" ? "host" : "spectator";

    if (!roomCode) {
      socket.emit("errorMsg", { error: "Room code missing." });
      return;
    }

    // If room doesn't exist: only host can create it
    if (!rooms.has(roomCode)) {
      if (r !== "host") {
        socket.emit("errorMsg", { error: "Host must join first." });
        return;
      }
      rooms.set(roomCode, {
        password: pw,
        hostId: socket.id,
        lastResult: null,
        createdAt: Date.now(),
      });
    }

    const roomObj = getRoom(roomCode);
    if (!roomObj) {
      socket.emit("errorMsg", { error: "Room not available." });
      return;
    }

    // Password check (host can set it on first create; afterwards it must match)
    if (roomObj.password !== pw) {
      socket.emit("errorMsg", { error: "Wrong password." });
      return;
    }

    // If a second host tries to join: block (keeps it simple + safe)
    if (r === "host" && roomObj.hostId && roomObj.hostId !== socket.id) {
      socket.emit("errorMsg", { error: "Host already present." });
      return;
    }

    socket.join(roomCode);
    socket.data.room = roomCode;
    socket.data.role = r;

    if (r === "host") roomObj.hostId = socket.id;

    socket.emit("joined", { role: r });

    // If spectator joins and we already have a last result, send it
    if (r === "spectator" && roomObj.lastResult) {
      socket.emit("matchResult", roomObj.lastResult);
    }
  });

  socket.on("matchResult", ({ room, password, result }) => {
    const roomCode = normRoom(room);
    const pw = normPass(password);
    const roomObj = getRoom(roomCode);
    if (!roomObj) return;

    // Only host can broadcast results
    if (socket.id !== roomObj.hostId) return;
    if (roomObj.password !== pw) return;

    roomObj.lastResult = result || null;
    io.to(roomCode).emit("matchResult", result);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.room;
    const role = socket.data.role;

    if (roomCode && rooms.has(roomCode)) {
      const roomObj = rooms.get(roomCode);

      // If host leaves, delete the room (simple + prevents stale rooms)
      if (role === "host" && roomObj && roomObj.hostId === socket.id) {
        rooms.delete(roomCode);
      } else {
        cleanupRoomIfEmpty(roomCode);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  // Kein Tracking, nur Minimal-Startmeldung:
  console.log("Server running on port", PORT);
});
