const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files (index.html)
app.use(express.static("public"));

let rooms = {};

// SOCKET CONNECTION
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // HOST ROOM
  socket.on("hostRoom", ({ room, pass }) => {
    rooms[room] = { password: pass };

    socket.join(room);

    console.log("Hosting room:", room);

    socket.emit("message", "✅ Hosting room: " + room);
  });

  // SPECTATE ROOM
  socket.on("spectateRoom", ({ room, pass }) => {
    if (!rooms[room]) {
      socket.emit("message", "❌ Room does not exist.");
      return;
    }

    if (rooms[room].password !== pass) {
      socket.emit("message", "❌ Wrong password.");
      return;
    }

    socket.join(room);

    console.log("Spectating room:", room);

    socket.emit("message", "👀 Watching room: " + room);
  });

  // MATCH RESULT SEND
  socket.on("matchResult", ({ room, password, result }) => {
    if (!rooms[room]) return;

    if (rooms[room].password !== password) {
      socket.emit("message", "❌ Wrong password.");
      return;
    }

    console.log("Result sent to room:", room);

    // Broadcast to everyone in the room
    io.to(room).emit("battleResult", result);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// START SERVER
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
