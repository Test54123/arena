const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);

// Socket.IO Server
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] }
});

// rooms: Map(roomCode -> { password, hostId })
const rooms = new Map();

function normRoom(x) {
  return String(x || "").trim().toUpperCase();
}
function normPass(x) {
  return String(x || "").trim();
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // HOST creates/joins a room
  socket.on("hostRoom", ({ room, pass }) => {
    const r = normRoom(room);
    const p = normPass(pass);

    if (!r) return;

    // create room if not exists
    if (!rooms.has(r)) {
      rooms.set(r, { password: p, hostId: socket.id });
    } else {
      // overwrite hostId and password (optional)
      rooms.set(r, { password: p, hostId: socket.id });
    }

    // ✅ IMPORTANT: join room so host also receives broadcasts
    socket.join(r);

    console.log("Host joined room:", r);
    socket.emit("joined", { role: "host", room: r });
  });

  // SPECTATOR joins a room
  socket.on("spectateRoom", ({ room, pass }) => {
    const r = normRoom(room);
    const p = normPass(pass);

    const existing = rooms.get(r);
    if (!existing) {
      socket.emit("errorMsg", { error: "Room not found" });
      return;
    }
    if (existing.password !== p) {
      socket.emit("errorMsg", { error: "Wrong password" });
      return;
    }

    // ✅ IMPORTANT: spectator must join room
    socket.join(r);

    console.log("Spectator joined room:", r);
    socket.emit("joined", { role: "spectator", room: r });
  });

  // MATCH RESULT broadcast
  // accepts password OR pass (so frontend variations still work)
  socket.on("matchResult", ({ room, password, pass, result }) => {
    const r = normRoom(room);
    const p = normPass(password ?? pass);

    const existing = rooms.get(r);
    if (!existing) return;
    if (existing.password !== p) return;

    io.to(r).emit("matchResult", { result });

    console.log("Result broadcast to room:", r);
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    // cleanup rooms where this socket was host
    for (const [code, data] of rooms.entries()) {
      if (data.hostId === socket.id) {
        rooms.delete(code);
        console.log("Room removed (host left):", code);
      }
    }
  });
});

// Render uses process.env.PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
