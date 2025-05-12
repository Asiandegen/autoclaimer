const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.json()); // For potential fallback HTTP endpoint

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store clients separately for easier management
let userScriptClients = new Map(); // Map<clientId, ws> for browser userscripts
let telegramMonitorClient = null; // Can only have one monitor connected via WS
let telegramMonitorClientId = null; // Store the ID if needed

const PING_INTERVAL = 30000; // 30 seconds

console.log("Server starting...");

wss.on("connection", (ws) => {
  ws.id = Date.now() + "_" + Math.random().toString(36).substring(2, 7); // More unique ID
  ws.isAlive = true;
  ws.clientType = null; // Will be set upon identification
  ws.username = null; // For userscripts

  console.log(`WebSocket client attempting connection (ID: ${ws.id}). Waiting for identification...`);

  ws.on('message', function incoming(message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error(`Failed to parse JSON message from client (ID: ${ws.id}): ${String(message).substring(0,100)}... Closing connection.`);
      ws.close(1003, "Invalid JSON format");
      return;
    }

    // --- Identification Logic ---
    if (data.type === 'identify') {
      if (data.client_type === 'telegram_monitor' && data.id) {
        // --- Telegram Monitor Identification ---
        if (telegramMonitorClient) {
           console.warn(`Another Telegram Monitor tried to connect (ID: ${data.id}). Closing new connection.`);
           ws.close(1008, "Monitor already connected");
           return;
        }
        ws.clientType = 'telegram_monitor';
        telegramMonitorClient = ws;
        telegramMonitorClientId = data.id; // Store monitor's self-reported ID
        console.log(`✅ Telegram Monitor connected and identified (ID: ${ws.id}, ClientID: ${data.id}).`);
        // Optionally send status update to userscripts
        broadcastToUserScripts(JSON.stringify({ type: "server_status_update", message: "Telegram Monitor connected."}), null);

      } else if (data.client_type === 'userscript' && data.username) { // Expect 'userscript' type now
        // --- UserScript Identification ---
        ws.clientType = 'userscript';
        ws.username = data.username;
        userScriptClients.set(ws.id, ws); // Store using unique ws.id
        console.log(`✅ UserScript Client Identified: ${ws.username} (ID: ${ws.id}). Total UserScripts: ${userScriptClients.size}`);
        // Send status update to other *userscripts*
        broadcastToUserScripts(JSON.stringify({ type: "server_status_update", message: `User ${ws.username} connected.`}), ws.id); // Exclude self

      } else {
        console.warn(`Received invalid identification message from (ID: ${ws.id}):`, data);
        ws.close(1008, "Invalid identification format");
      }

      // Setup pong listener after successful identification
      ws.on('pong', () => {
        ws.isAlive = true;
        // console.log(`Pong received from ${ws.clientType} ${ws.username || ws.id}`); // Optional: verbose logging
      });
      // Don't remove message listener here, we need it for codes from monitor now

    // --- Code Handling Logic (Only from Telegram Monitor) ---
    } else if (data.type === 'new_code' && data.code) {
      if (ws.clientType === 'telegram_monitor') {
        const code = data.code;
        console.log(`Received code "${code}" via WebSocket from Telegram Monitor (ID: ${ws.id}). Broadcasting...`);
        // Broadcast the code to all connected UserScripts
        const codeMessage = JSON.stringify({ type: "new_code", code: code });
        const sentCount = broadcastToUserScripts(codeMessage, null); // Send to all userscripts
        console.log(`Code "${code}" broadcasted to ${sentCount} UserScript client(s).`);
         // Optionally send ack back to monitor: ws.send(JSON.stringify({type: "ack", code: code}));
      } else {
        console.warn(`Received 'new_code' message from non-monitor client (Type: ${ws.clientType}, ID: ${ws.id}). Ignoring.`);
      }

    // --- Ping/Pong Handling (if client sends pings) ---
    } else if (data.type === 'ping') {
       // Client-initiated ping, respond with pong
       try {
            ws.send(JSON.stringify({type: "pong"}));
       } catch (e) { console.error(`Error sending pong to ${ws.id}:`, e);}

    } else {
       console.log(`Received unknown message type from (ID: ${ws.id}, Type: ${ws.clientType}):`, data);
    }
  }); // End on 'message'

  ws.on('close', (code, reason) => {
     const reasonStr = reason ? reason.toString() : 'No reason given';
    if (ws.clientType === 'telegram_monitor') {
       console.log(`🔌 Telegram Monitor disconnected (ID: ${ws.id}, ClientID: ${telegramMonitorClientId}). Code: ${code}, Reason: ${reasonStr}`);
       telegramMonitorClient = null;
       telegramMonitorClientId = null;
       broadcastToUserScripts(JSON.stringify({ type: "server_status_update", message: "Telegram Monitor disconnected."}), null);
    } else if (ws.clientType === 'userscript') {
       const username = ws.username || 'Unknown';
       userScriptClients.delete(ws.id); // Remove from map
       console.log(`🔌 UserScript Client disconnected: ${username} (ID: ${ws.id}). Code: ${code}, Reason: ${reasonStr}. Total UserScripts: ${userScriptClients.size}`);
       broadcastToUserScripts(JSON.stringify({ type: "server_status_update", message: `User ${username} disconnected.`}), null); // Inform remaining userscripts
    } else {
       console.log(`🔌 Unidentified client disconnected (ID: ${ws.id}). Code: ${code}, Reason: ${reasonStr}`);
    }
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error (ID: ${ws.id}, Type: ${ws.clientType}, User: ${ws.username}):`, err);
    // 'close' event usually follows
  });
}); // End on 'connection'

// Helper function to broadcast messages to UserScript clients
function broadcastToUserScripts(message, excludeClientId) {
  let sentCount = 0;
  userScriptClients.forEach((client, clientId) => {
    if (clientId !== excludeClientId && client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
        sentCount++;
      } catch (e) {
        console.error(`Error sending message to UserScript ${client.username || clientId}:`, e);
        // Optionally remove client if send fails repeatedly: clients.delete(clientId); client.terminate();
      }
    }
  });
  return sentCount;
}

// Interval to ping clients (both types)
const pingInterval = setInterval(() => {
    // console.log(`Pinging clients... Monitor: ${telegramMonitorClient ? 'Connected' : 'Not Connected'}, UserScripts: ${userScriptClients.size}`); // Verbose
    const clientsToPing = [];
    if (telegramMonitorClient) clientsToPing.push(telegramMonitorClient);
    userScriptClients.forEach(client => clientsToPing.push(client));

    clientsToPing.forEach(ws => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return; // Skip if client disconnected between loops

        if (ws.isAlive === false) {
            const clientDesc = ws.clientType === 'telegram_monitor' ? `Telegram Monitor (${telegramMonitorClientId})` : `UserScript (${ws.username || 'Unknown'})`;
            console.log(`Client ${clientDesc} (ID: ${ws.id}) did not respond to ping. Terminating.`);
            return ws.terminate(); // Close event will handle cleanup
        }
        ws.isAlive = false;
        ws.ping(() => {}); // Send ping, ws library handles pong listening internally
    });
}, PING_INTERVAL);

wss.on('close', function wssClose() {
  console.log("WebSocket server shutting down, clearing ping interval.");
  clearInterval(pingInterval);
});

// --- Fallback HTTP Endpoint (Optional) ---
// You can remove this if WebSocket is reliable enough
app.post("/send-code", (req, res) => {
  const code = req.body.code;
  if (!code) {
    console.log("[HTTP Fallback] Received POST without 'code'.");
    return res.status(400).send("Missing 'code' in request body");
  }
  console.warn(`[HTTP Fallback] Received code "${code}" via HTTP POST. Broadcasting... (Consider relying solely on WebSocket)`);
  const codeMessage = JSON.stringify({ type: "new_code", code: code });
  const sentCount = broadcastToUserScripts(codeMessage, null);
  console.warn(`[HTTP Fallback] Code "${code}" broadcasted to ${sentCount} UserScript client(s).`);
  res.status(200).send(`[HTTP Fallback] Code "${code}" forwarded to ${sentCount} client(s).`);
});

// Basic root route for health check
app.get("/", (req, res) => {
   res.status(200).send(`WebSocket/HTTP Server running. Monitor: ${telegramMonitorClient ? 'Connected' : 'Not Connected'}, UserScripts: ${userScriptClients.size}`);
});

const PORT = 8765;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT} and ws://localhost:${PORT}`);
  console.log(`   Waiting for connections from UserScripts and Telegram Monitor.`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nReceived SIGINT. Shutting down gracefully...');
    clearInterval(pingInterval); // Stop pings first
    const closePromises = [];
    // Close monitor connection
    if (telegramMonitorClient) {
        closePromises.push(new Promise(resolve => {
            telegramMonitorClient.on('close', resolve);
            telegramMonitorClient.close(1001, "Server shutting down");
            setTimeout(resolve, 1000); // Timeout if close hangs
        }));
    }
    // Close userscript connections
    userScriptClients.forEach(client => {
         closePromises.push(new Promise(resolve => {
            client.on('close', resolve);
            client.close(1001, "Server shutting down");
            setTimeout(resolve, 1000); // Timeout if close hangs
        }));
    });

    Promise.all(closePromises).then(() => {
        console.log("All WebSocket clients closed.");
        wss.close(() => { console.log('WebSocket server closed.'); });
        server.close(() => {
            console.log('HTTP server closed.');
            process.exit(0);
        });
    }).catch(err => {
         console.error("Error during graceful shutdown:", err);
         process.exit(1);
    });

    // Force exit if shutdown takes too long
    setTimeout(() => {
        console.error('Graceful shutdown timed out, forcing exit.');
        process.exit(1);
    }, 5000);
});
