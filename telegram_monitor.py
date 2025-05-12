import re
import asyncio
import websockets
import json
import time
from telethon import TelegramClient, events

# --- Configuration ---
API_ID = 25418282  # Replace with your API ID
API_HASH = "bdd62f61361dd807c13559f4352a5c3a" # Replace with your API Hash
PHONE_NUMBER = '+60149032373' # Replace with your phone number
SESSION_NAME = "stake_monitor"
TARGET_CHATS = [-1002140237447, -1001768427488] # Replace with your target chat IDs
CODE_REGEX = re.compile(r'\bcode:\s*([a-zA-Z0-9]+)\b', re.IGNORECASE)
SERVER_URI = "ws://localhost:8765/" # WebSocket URI for your Node.js server
CLIENT_ID = "TelegramMonitor_Stake" # Identifier for this script
RECONNECT_DELAY = 5 # Seconds to wait before attempting reconnect
# --- End Configuration ---

sent_codes = set()
websocket_connection = None # Global variable to hold the connection

# --- WebSocket Functions ---

async def connect_to_server():
    """Establishes and maintains the WebSocket connection."""
    global websocket_connection
    while True:
        try:
            async with websockets.connect(SERVER_URI) as ws:
                websocket_connection = ws
                print("WebSocket connected to server.")
                # Send identification message
                await ws.send(json.dumps({"type": "identify", "client_type": "telegram_monitor", "id": CLIENT_ID}))
                print("Identification sent to server.")
                # Keep the connection alive by waiting for messages (server pings)
                # Or implement periodic pings from client if server expects them
                async for message in ws:
                    # Handle messages from server if needed (e.g., acknowledgements, pings)
                    # print(f"Received from server: {message}") # Optional
                    try:
                        data = json.loads(message)
                        if data.get("type") == "pong": # Example: if server sends pings
                             await ws.send(json.dumps({"type": "ping"}))
                    except Exception:
                        pass # Ignore non-JSON or unexpected messages
        except (websockets.exceptions.ConnectionClosedError, websockets.exceptions.ConnectionClosedOK) as e:
            print(f"WebSocket connection closed: {e}. Reconnecting in {RECONNECT_DELAY} seconds...")
        except Exception as e:
            print(f"WebSocket connection error: {e}. Reconnecting in {RECONNECT_DELAY} seconds...")
        finally:
            websocket_connection = None
            await asyncio.sleep(RECONNECT_DELAY)

async def send_code_via_websocket(code):
    """Sends the detected code over the WebSocket connection."""
    global websocket_connection
    if code in sent_codes:
        # print(f"Code {code} already sent recently. Skipping.")
        return
    sent_codes.add(code)

    # *** MODIFICATION START ***
    # Check if the connection exists and is *not* closed
    if websocket_connection and not websocket_connection.closed:
    # *** MODIFICATION END ***
        try:
            message = json.dumps({"type": "new_code", "code": code})
            await websocket_connection.send(message)
            print(f"Sent code {code} via WebSocket.")
        except Exception as e:
            print(f"Error sending code {code} via WebSocket: {e}")
            # Optional: Handle send error, maybe queue code for later?
    else:
        print(f"WebSocket not connected. Cannot send code {code}.")
        # Optional: Queue the code to be sent upon reconnection?
        # Be careful not to queue indefinitely if connection fails persistently.

# --- Telegram Functions ---

async def telegram_main():
    """Initializes Telethon client and handles new messages."""
    client = TelegramClient(SESSION_NAME, API_ID, API_HASH)

    @client.on(events.NewMessage(chats=TARGET_CHATS))
    async def handler(event):
        message_text = event.message.message
        match = CODE_REGEX.search(message_text)
        if match:
            code = match.group(1)
            print(f"Detected code: {code} in chat {event.chat_id}")
            await send_code_via_websocket(code) # Send via WebSocket

    print("Starting Telegram client...")
    await client.start(phone=PHONE_NUMBER)
    print("Telegram client started successfully.")
    await client.run_until_disconnected()

# --- Main Execution ---

async def main():
    # Run WebSocket connection handler and Telegram client concurrently
    websocket_task = asyncio.create_task(connect_to_server())
    telegram_task = asyncio.create_task(telegram_main())

    # Keep tasks running
    await asyncio.gather(websocket_task, telegram_task)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Script stopped by user.")
