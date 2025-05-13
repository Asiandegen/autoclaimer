// File: server.js

// Import necessary modules
const WebSocket = require('ws');
const http = require('http');

// --- Configuration ---
const PORT = 8765; // Port the WebSocket server will listen on
const HOST = '0.0.0.0'; // Listen on all available IPv4 interfaces
const PING_INTERVAL = 30000; // Interval for sending pings (milliseconds)
// --- End Configuration ---

// --- Logging Helper ---
const log = (level, message, ...optionalParams) => {
  const timestamp = new Date().toISOString();
  const levelUpper = level.toUpperCase();
  const logFunc = console[levelUpper === 'WARN' ? 'warn' : levelUpper === 'ERROR' ? 'error' : 'log'] || console.log;
  logFunc(`[${timestamp}] ${levelUpper}: ${message}`, ...optionalParams);
};

// Create an HTTP server (useful for health checks)
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'ok',
        monitorConnected: !!telegramMonitorSocket,
        userscriptCount: userScriptSockets.size,
        uptime: process.uptime()
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`WebSocket Server active. Monitor: ${telegramMonitorSocket ? 'Connected' : 'Disconnected'}. Userscripts: ${userScriptSockets.size}. Try /health for JSON status.`);
  }
});

// Create a WebSocket server attached to the HTTP server
const wss = new WebSocket.Server({ server });

// --- Client Management ---
let telegramMonitorSocket = null; // Holds the single allowed Telegram monitor connection
let telegramMonitorId = null; // Store the ID the monitor provides
const userScriptSockets = new Map(); // Stores connected userscript clients (ws.id -> ws)

// --- WebSocket Event Handling ---

wss.on('connection', (ws, req) => {
  // Assign a unique ID to each connection
  ws.id = `ws_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  ws.isAlive = true; // Flag for ping/pong keepalive
  ws.clientType = null; // Determined by 'identify' message
  ws.username = null; // Specific to userscripts
  const remoteAddress = req.socket.remoteAddress || req.headers['x-forwarded-for']; // Get client IP

  log('INFO', `[${ws.id}] Client connected from ${remoteAddress}. Waiting for identification...`);

  // Handle 'pong' responses to keep connection alive
  ws.on('pong', () => {
    ws.isAlive = true;
    // log('DEBUG', `[${ws.id}] Pong received.`);
  });

  // Handle messages received from clients
  ws.on('message', (messageBuffer) => {
    let messageString = '<Buffer>';
    let data;
    try {
      messageString = messageBuffer.toString('utf-8');
      data = JSON.parse(messageString);
    } catch (e) {
      log('ERROR', `[${ws.id}] Failed to parse JSON message: ${e.message}. Message: ${messageString.substring(0, 100)}`);
      ws.close(1003, 'Invalid data format');
      return;
    }

    const clientDesc = getClientDescription(ws);

    // --- Message Type Handling ---
    switch (data.type) {
      case 'identify':
        handleIdentification(ws, data, remoteAddress);
        break;

      case 'new_code':
        if (ws !== telegramMonitorSocket) {
          log('WARN', `${clientDesc} Received 'new_code' from non-monitor client. Ignoring.`);
          return;
        }
        const code = data.code;
        if (!code || typeof code !== 'string') {
          log('WARN', `${clientDesc} Received invalid 'new_code' payload from monitor:`, data);
          return;
        }
        log('INFO', `${clientDesc} Received code: "${code}". Broadcasting...`);
        broadcastCodeToUserscripts(code, clientDesc);
        break;

      case 'ping':
         log('DEBUG', `${clientDesc} Received client-initiated ping. Sending pong.`);
         try {
             ws.send(JSON.stringify({ type: 'pong' }));
         } catch (e) { log('ERROR', `${clientDesc} Failed to send pong:`, e); }
         break;

      default:
        log('WARN', `${clientDesc} Received unknown message type: ${data.type}`);
    }
  });

  // Handle client disconnection
  ws.on('close', (code, reasonBuffer) => {
    const reason = reasonBuffer && reasonBuffer.length > 0 ? reasonBuffer.toString('utf-8') : 'No reason';
    const clientDesc = getClientDescription(ws, true);
    log('INFO', `${clientDesc} Client disconnected. Code: ${code}, Reason: "${reason}"`);
    cleanupClient(ws);
    log('INFO', `[SERVER] State update -> Monitor: ${telegramMonitorSocket ? 'Connected' : 'Disconnected'}, UserScripts: ${userScriptSockets.size}`);
  });

  // Handle WebSocket errors
  ws.on('error', (error) => {
    const clientDesc = getClientDescription(ws, true);
    log('ERROR', `${clientDesc} WebSocket error:`, error);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
    }
  });
});

// --- Helper Functions ---

function getClientDescription(ws, includeIdEvenIfTyped = false) {
    if (!ws) return '[UnknownClient]';
    const baseId = `[ID: ${ws.id}]`;
    if (ws === telegramMonitorSocket) {
        return `[Monitor: ${telegramMonitorId || ws.id}]`;
    } else if (ws.clientType === 'userscript') {
        return `[User: ${ws.username || ws.id}]`;
    } else {
        return includeIdEvenIfTyped ? baseId : '[UnidentifiedClient]';
    }
}

function handleIdentification(ws, data, remoteAddress) {
  const currentDesc = getClientDescription(ws);
  if (ws.clientType) {
    log('WARN', `${getClientDescription(ws)} Attempted to identify again as ${data.client_type}. Ignoring.`);
    return;
  }

  log('INFO', `[${ws.id}] Identification attempt from ${remoteAddress}: ${JSON.stringify(data)}`);

  if (data.client_type === 'telegram_monitor' && data.id) {
    if (telegramMonitorSocket) {
      log('WARN', `[${ws.id}] Denied: Attempted connection from a second Telegram Monitor (${data.id}). Closing.`);
      ws.close(1008, 'Telegram monitor already connected');
      return;
    }
    ws.clientType = 'telegram_monitor';
    telegramMonitorSocket = ws;
    telegramMonitorId = data.id;
    log('INFO', `✅ [Monitor: ${telegramMonitorId}] Identified successfully (ID: ${ws.id})`);
    broadcastServerStatus(`Telegram Monitor connected (${telegramMonitorId}).`);

  } else if (data.client_type === 'userscript' && data.username) {
    ws.clientType = 'userscript';
    ws.username = data.username;
    userScriptSockets.set(ws.id, ws);
    log('INFO', `✅ [User: ${ws.username}] Identified successfully (ID: ${ws.id}). Total Users: ${userScriptSockets.size}`);
    broadcastServerStatus(`User ${ws.username} connected.`, ws.id);

  } else {
    log('WARN', `[${ws.id}] Invalid identification payload received. Closing connection. Payload:`, data);
    ws.close(1008, 'Invalid identification payload');
  }
}

function broadcastCodeToUserscripts(code, senderDescription) {
    const message = JSON.stringify({ type: 'new_code', code: code });
    let broadcastCount = 0;
    userScriptSockets.forEach((clientWs, clientId) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            try {
                clientWs.send(message);
                broadcastCount++;
            } catch (e) {
                log('ERROR', `[User: ${clientWs.username || clientId}] Error sending code broadcast:`, e);
            }
        } else {
            log('WARN', `[User: ${clientWs.username || clientId}] Found non-open socket during broadcast. Will be cleaned up.`);
        }
    });
    log('INFO', `[SERVER] Code "${code}" broadcast attempt finished. Sent to ${broadcastCount} userscript(s).`);
}

function broadcastServerStatus(messageText, excludeWsId = null) {
    const message = JSON.stringify({ type: 'server_status_update', message: messageText });
    let count = 0;
    userScriptSockets.forEach((clientWs, clientId) => {
        if (clientId !== excludeWsId && clientWs.readyState === WebSocket.OPEN) {
            try {
                clientWs.send(message);
                count++;
            } catch (e) {
                log('ERROR', `[User: ${clientWs.username || clientId}] Error sending status update:`, e);
            }
        }
    });
     if (count > 0) {
        log('INFO', `[SERVER] Broadcasted status update "${messageText.substring(0,50)}..." to ${count} users.`);
     }
}

function cleanupClient(ws) {
  if (ws === telegramMonitorSocket) {
    telegramMonitorSocket = null;
    telegramMonitorId = null;
  } else if (userScriptSockets.has(ws.id)) {
    userScriptSockets.delete(ws.id);
  }
}

// --- Ping Interval for Keepalive ---
const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const clientDesc = getClientDescription(ws, true);
        if (ws.isAlive === false) {
            log('WARN', `${clientDesc} No pong response received within interval. Terminating connection.`);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping((err) => {
            if (err) {
                log('ERROR', `${clientDesc} Error sending ping:`, err);
            }
        });
    });
}, PING_INTERVAL);

wss.on('close', () => {
  log('INFO', "[SERVER] WebSocket server instance shutting down. Clearing ping interval.");
  clearInterval(interval);
});

// --- Start the HTTP Server ---
// The HOST '0.0.0.0' makes it listen on all available IPv4 interfaces.
server.listen(PORT, HOST, () => {
  log('INFO', `🚀 HTTP server listening on ${HOST}:${PORT}`);
  // Replace <your_vps_ip_or_domain> with your actual VPS IP or configured hostname (e.g., code.stake69.site)
  log('INFO', `🚀 WebSocket server accessible via ws://<your_vps_ip_or_domain>:${PORT}`);
});

// --- Graceful Shutdown Handling ---
const shutdown = (signal) => {
    log('INFO', `\n[SERVER] Received ${signal}. Shutting down gracefully...`);
    clearInterval(interval);
    log('INFO', '[SERVER] Closing all WebSocket client connections...');
    const closePromises = Array.from(wss.clients).map(client =>
        new Promise(resolve => {
            if (client.readyState === WebSocket.OPEN) {
                client.on('close', resolve);
                client.close(1001, 'Server shutting down');
                setTimeout(() => {
                     if (client.readyState !== WebSocket.CLOSED) {
                         log('WARN', `[SERVER] Force terminating client ${getClientDescription(client, true)} during shutdown.`);
                         client.terminate();
                     }
                     resolve();
                 }, 1000);
            } else {
                resolve();
            }
        })
    );

    Promise.all(closePromises).then(() => {
        log('INFO', "[SERVER] All WebSocket clients closed or terminated.");
        wss.close(() => { log('INFO', '[SERVER] WebSocket server instance closed.'); });
        server.close(() => {
            log('INFO', '[SERVER] HTTP server closed.');
            process.exit(0);
        });
    }).catch(err => {
         log('ERROR', "[SERVER] Error during client shutdown:", err);
         process.exit(1);
    });

    setTimeout(() => {
        log('ERROR', '[SERVER] Graceful shutdown timed out. Forcing exit.');
        process.exit(1);
    }, 5000);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
