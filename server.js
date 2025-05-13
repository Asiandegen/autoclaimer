// File: server.js

// Import necessary modules
const WebSocket = require('ws');
const http = require('http');

// --- Configuration ---
const PORT = 8765; // Port the WebSocket server will listen on
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

log('INFO', `WebSocket server starting on port ${PORT}...`);

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
    // log('DEBUG', `[${ws.id}] Pong received.`); // Keep debug logs minimal
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
      ws.close(1003, 'Invalid data format'); // 1003: Unsupported Data
      return;
    }

    const clientDesc = getClientDescription(ws); // Get description like "[Monitor: <id>]" or "[User: <name>]"

    // --- Message Type Handling ---
    switch (data.type) {
      case 'identify':
        handleIdentification(ws, data, remoteAddress); // Pass remote address for logging
        break;

      case 'new_code':
        // CRITICAL: Only accept codes from the identified Telegram Monitor
        if (ws !== telegramMonitorSocket) {
          log('WARN', `${clientDesc} Received 'new_code' from non-monitor client. Ignoring.`);
          return;
        }
        const code = data.code;
        if (!code || typeof code !== 'string') {
          log('WARN', `${clientDesc} Received invalid 'new_code' payload from monitor:`, data);
          return;
        }
        // Log reception before broadcasting
        log('INFO', `${clientDesc} Received code: "${code}". Broadcasting...`);
        broadcastCodeToUserscripts(code, clientDesc);
        // Optional: Send acknowledgment back to monitor
        // try { ws.send(JSON.stringify({ type: 'ack', code: code })); } catch (e) { log('ERROR', `${clientDesc} Failed to send ack:`, e); }
        break;

      case 'ping': // Handle client-initiated pings if needed
         log('DEBUG', `${clientDesc} Received client-initiated ping. Sending pong.`);
         try {
             ws.send(JSON.stringify({ type: 'pong' }));
         } catch (e) { log('ERROR', `${clientDesc} Failed to send pong:`, e); }
         break;

      default:
        log('WARN', `${clientDesc} Received unknown message type: ${data.type}`);
        // Consider closing connection for unexpected messages if strict protocol is desired
        // ws.close(1008, 'Unknown message type'); // 1008: Policy Violation
    }
  });

  // Handle client disconnection
  ws.on('close', (code, reasonBuffer) => {
    const reason = reasonBuffer && reasonBuffer.length > 0 ? reasonBuffer.toString('utf-8') : 'No reason';
    const clientDesc = getClientDescription(ws, true); // Get description even if client is gone
    log('INFO', `${clientDesc} Client disconnected. Code: ${code}, Reason: "${reason}"`);
    cleanupClient(ws); // Perform cleanup actions
    // Log remaining counts after cleanup
    log('INFO', `[SERVER] State update -> Monitor: ${telegramMonitorSocket ? 'Connected' : 'Disconnected'}, UserScripts: ${userScriptSockets.size}`);
  });

  // Handle WebSocket errors
  ws.on('error', (error) => {
    const clientDesc = getClientDescription(ws, true);
    log('ERROR', `${clientDesc} WebSocket error:`, error);
    // Don't cleanup here, 'close' event usually follows and handles cleanup
    // Ensure the socket is terminated if it's still open after an error
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
    }
  });
});

// --- Helper Functions ---

// Gets a descriptive string for logging based on client type and ID/username
function getClientDescription(ws, includeIdEvenIfTyped = false) {
    if (!ws) return '[UnknownClient]';
    const baseId = `[ID: ${ws.id}]`; // Use ws.id as fallback identifier
    if (ws === telegramMonitorSocket) {
        return `[Monitor: ${telegramMonitorId || ws.id}]`;
    } else if (ws.clientType === 'userscript') {
        return `[User: ${ws.username || ws.id}]`;
    } else {
        // Unidentified or unknown
        return includeIdEvenIfTyped ? baseId : '[UnidentifiedClient]';
    }
}

// Handles the 'identify' message from a new client
function handleIdentification(ws, data, remoteAddress) {
  const currentDesc = getClientDescription(ws); // Get current description (likely Unidentified)
  if (ws.clientType) { // Check if already identified
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
    userScriptSockets.set(ws.id, ws); // Add to our map of userscripts
    log('INFO', `✅ [User: ${ws.username}] Identified successfully (ID: ${ws.id}). Total Users: ${userScriptSockets.size}`);
    // Send status update to other *userscripts*, exclude self
    broadcastServerStatus(`User ${ws.username} connected.`, ws.id);

  } else {
    log('WARN', `[${ws.id}] Invalid identification payload received. Closing connection. Payload:`, data);
    ws.close(1008, 'Invalid identification payload');
  }
}

// Broadcasts a code message to all connected userscripts
function broadcastCodeToUserscripts(code, senderDescription) {
    const message = JSON.stringify({ type: 'new_code', code: code });
    let broadcastCount = 0;

    userScriptSockets.forEach((clientWs, clientId) => {
        // Check if client is still connected and ready
        if (clientWs.readyState === WebSocket.OPEN) {
            try {
                clientWs.send(message);
                broadcastCount++;
            } catch (e) {
                log('ERROR', `[User: ${clientWs.username || clientId}] Error sending code broadcast:`, e);
                // Consider terminating client if send fails repeatedly?
            }
        } else {
            // Log and potentially clean up sockets that aren't open but weren't caught by 'close' yet
            log('WARN', `[User: ${clientWs.username || clientId}] Found non-open socket during broadcast. Will be cleaned up.`);
            // Optional: Force cleanup immediately userScriptSockets.delete(clientId);
        }
    });
    // Log summary after attempting broadcast
    log('INFO', `[SERVER] Code "${code}" broadcast attempt finished. Sent to ${broadcastCount} userscript(s).`);
}

// Broadcasts server status messages (like connect/disconnect) to userscripts
function broadcastServerStatus(messageText, excludeWsId = null) {
    const message = JSON.stringify({ type: 'server_status_update', message: messageText });
    let count = 0;
    userScriptSockets.forEach((clientWs, clientId) => {
        // Check exclude ID and readiness
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

// Cleans up resources associated with a disconnected client
function cleanupClient(ws) {
  if (ws === telegramMonitorSocket) {
    telegramMonitorSocket = null;
    telegramMonitorId = null;
    // Status update broadcast happens in 'close' handler *after* cleanup
  } else if (userScriptSockets.has(ws.id)) {
    userScriptSockets.delete(ws.id);
    // Status update broadcast happens in 'close' handler *after* cleanup
  }
  // If client never identified, no specific cleanup needed beyond socket closure
}

// --- Ping Interval for Keepalive ---
// Regularly check if clients are still responsive
const interval = setInterval(() => {
    // Use wss.clients which includes all connected clients (monitor + userscripts)
    wss.clients.forEach(ws => {
        // Skip sockets that are closing or already closed
        if (ws.readyState !== WebSocket.OPEN) return;

        const clientDesc = getClientDescription(ws, true); // Get description including ID

        if (ws.isAlive === false) {
            log('WARN', `${clientDesc} No pong response received within interval. Terminating connection.`);
            return ws.terminate(); // Force close; 'close' event will handle cleanup
        }

        // Mark as potentially unresponsive, expecting a pong before next interval
        ws.isAlive = false;
        // Send ping request
        ws.ping((err) => {
            if (err) {
                log('ERROR', `${clientDesc} Error sending ping:`, err);
            } else {
                // log('DEBUG', `${clientDesc} Ping sent.`);
            }
        });
    });
}, PING_INTERVAL);

wss.on('close', () => {
  log('INFO', "[SERVER] WebSocket server instance shutting down. Clearing ping interval.");
  clearInterval(interval);
});

// --- Start the HTTP Server ---
server.listen(PORT, () => {
  log('INFO', `🚀 HTTP server listening on port ${PORT}`);
  log('INFO', `🚀 WebSocket server available at ws://<your_vps_ip>:${PORT}`);
});

// --- Graceful Shutdown Handling ---
const shutdown = (signal) => {
    log('INFO', `\n[SERVER] Received ${signal}. Shutting down gracefully...`);
    clearInterval(interval); // Stop sending pings

    log('INFO', '[SERVER] Closing all WebSocket client connections...');
    const closePromises = Array.from(wss.clients).map(client =>
        new Promise(resolve => {
            if (client.readyState === WebSocket.OPEN) {
                client.on('close', resolve); // Wait for the close event
                client.close(1001, 'Server shutting down'); // 1001: Going Away
                // Add a timeout in case 'close' event doesn't fire
                setTimeout(() => {
                     if (client.readyState !== WebSocket.CLOSED) {
                         log('WARN', `[SERVER] Force terminating client ${getClientDescription(client, true)} during shutdown.`);
                         client.terminate();
                     }
                     resolve();
                 }, 1000); // 1 second timeout per client
            } else {
                resolve(); // Already closed or closing
            }
        })
    );

    // Wait for all clients to close, with a total timeout
    Promise.all(closePromises).then(() => {
        log('INFO', "[SERVER] All WebSocket clients closed or terminated.");
        wss.close(() => { log('INFO', '[SERVER] WebSocket server instance closed.'); });
        server.close(() => {
            log('INFO', '[SERVER] HTTP server closed.');
            process.exit(0); // Exit cleanly
        });
    }).catch(err => {
         log('ERROR', "[SERVER] Error during client shutdown:", err);
         process.exit(1); // Exit with error code
    });

    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
        log('ERROR', '[SERVER] Graceful shutdown timed out. Forcing exit.');
        process.exit(1);
    }, 5000); // 5-second overall timeout
};

// Listen for termination signals
process.on('SIGINT', () => shutdown('SIGINT')); // Ctrl+C
process.on('SIGTERM', () => shutdown('SIGTERM')); // systemd stop, kill command
