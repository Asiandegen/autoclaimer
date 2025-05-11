const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let clients = [];

wss.on("connection", (ws) => {
  console.log("Client connected");
  clients.push(ws);

  ws.on("close", () => {
    clients = clients.filter((c) => c !== ws);
    console.log("Client disconnected");
  });
});

app.post("/send-code", (req, res) => {
  const code = req.body.code;
  if (!code) return res.status(400).send("Missing 'code'");

  console.log("Forwarding code:", code);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(code);
    }
  });

  res.send("Code sent");
});

const PORT = 8765;
server.listen(PORT, () => {
  console.log("WebSocket + HTTP server running at http://localhost:" + PORT);
});
