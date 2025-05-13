# File: telegram_monitor.py (with inter-channel duplicate check)

import re
import asyncio
import websockets
import json
import time
import logging
from telethon import TelegramClient, events

# --- Configuration ---
# Get these from my.telegram.org
API_ID = 12345678  # Replace with your actual API ID (integer)
API_HASH = "your_api_hash_here"  # Replace with your actual API Hash (string)
PHONE_NUMBER = '+60149032373' # Replace with your phone number in international format (e.g., '+1234567890')

# Session file name (created automatically by Telethon)
SESSION_NAME = "telegram_stake_monitor_session_dup_check" # Updated session name

# List of chat IDs (integers) to monitor.
TARGET_CHATS = [-1002140237447, -1001768427488] # Your original IDs

# Regular expression to find the code.
CODE_REGEX = re.compile(r'\bcode:\s*([a-zA-Z0-9\-_]+)\b', re.IGNORECASE)

# WebSocket server details
SERVER_URI = "ws://localhost:8765/"
CLIENT_ID = "TelegramMonitor_VPS_v1_DupCheck" # Updated Client ID

# --- Behavior ---
RECONNECT_DELAY_SECONDS = 5
# Timeout (in seconds) for ignoring duplicate codes seen across any monitored channel
DUPLICATE_CODE_TIMEOUT_SECONDS = 60 * 5  # 300 seconds = 5 minutes (Adjust as needed)
# --- End Configuration ---

# --- Logging Setup ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S')
logger = logging.getLogger(__name__)

# --- Global State ---
websocket_connection = None
# Dictionary to track recently sent codes {code_string: timestamp_sent}
sent_codes = {}
# --- End Global State ---

# --- WebSocket Functions ---

async def connect_to_websocket_server():
    """Establishes and maintains the WebSocket connection to the Node.js server."""
    global websocket_connection
    while True:
        try:
            logger.info(f"[WS] Attempting connection to server: {SERVER_URI}")
            async with websockets.connect(SERVER_URI, ping_interval=None, open_timeout=10) as ws:
                websocket_connection = ws
                logger.info("[WS] Connection established successfully.")

                identify_message = json.dumps({
                    "type": "identify",
                    "client_type": "telegram_monitor",
                    "id": CLIENT_ID
                })
                await ws.send(identify_message)
                logger.info(f"[WS] Sent identification to server (ID: {CLIENT_ID}).")

                async for message in ws:
                    try:
                        data = json.loads(message)
                        logger.debug(f"[WS] Received message from server: {data}")
                        if data.get("type") == "pong": pass
                        elif data.get("type") == "ack": logger.info(f"[WS] Server acknowledged code: {data.get('code')}")
                    except json.JSONDecodeError: logger.warning(f"[WS] Received non-JSON message: {message[:100]}")
                    except Exception as e: logger.error(f"[WS] Error processing server message: {e}")

        except (websockets.exceptions.ConnectionClosedError, websockets.exceptions.ConnectionClosedOK) as e:
            reason = f"Reason: {e.reason}, Code: {e.code}" if hasattr(e, 'reason') else str(e)
            logger.warning(f"[WS] Connection closed ({reason}). Reconnecting in {RECONNECT_DELAY_SECONDS}s...")
        except ConnectionRefusedError: logger.error(f"[WS] Connection refused by server at {SERVER_URI}. Is it running? Retrying in {RECONNECT_DELAY_SECONDS}s...")
        except Exception as e: logger.error(f"[WS] Connection error: {type(e).__name__} - {e}. Reconnecting in {RECONNECT_DELAY_SECONDS}s...")
        finally:
            websocket_connection = None
            await asyncio.sleep(RECONNECT_DELAY_SECONDS)

# --- MODIFIED FUNCTION: Re-implements duplicate check ---
async def send_code_via_websocket(code):
    """Sends a detected code via WebSocket if not sent recently from any channel."""
    global websocket_connection, sent_codes

    current_time = time.time()

    # --- Duplicate Check Logic ---
    # Remove codes from tracking that are older than the timeout period
    codes_to_remove = [c for c, ts in sent_codes.items() if current_time - ts > DUPLICATE_CODE_TIMEOUT_SECONDS]
    for c in codes_to_remove:
        try:
            del sent_codes[c]
            logger.debug(f"Removed expired code '{c}' from duplicate tracking.")
        except KeyError:
            pass # Already removed somehow, ignore

    # Check if the code was sent recently (within the timeout)
    if code in sent_codes:
        time_since_sent = current_time - sent_codes[code]
        logger.info(f"Ignoring duplicate code '{code}'. Sent {time_since_sent:.0f}s ago (Timeout: {DUPLICATE_CODE_TIMEOUT_SECONDS}s).")
        return # Do not send
    # --- End Duplicate Check Logic ---

    # If not a recent duplicate, proceed to send
    if websocket_connection and not websocket_connection.closed:
        try:
            message = json.dumps({"type": "new_code", "code": code})
            await websocket_connection.send(message)
            # Log confirmation *after* successful send
            logger.info(f"[WS] -> Sent code '{code}' to server.")
            # Add the code to tracking *after* successful send
            sent_codes[code] = current_time
        except websockets.exceptions.ConnectionClosed:
             logger.warning(f"[WS] Attempted to send code '{code}' but connection was closed.")
        except Exception as e:
            logger.error(f"[WS] Failed to send code '{code}': {type(e).__name__} - {e}")
    else:
        logger.warning(f"[WS] Cannot send code '{code}'. Connection inactive.")

# --- Telegram Functions ---

async def setup_telegram_client():
    """Initializes the Telethon client and defines the message handler."""
    logger.info("[TG] Initializing Telegram client...")
    client = TelegramClient(SESSION_NAME, API_ID, API_HASH)

    @client.on(events.NewMessage(chats=TARGET_CHATS))
    async def new_message_handler(event):
        """Handles new messages in the target chats."""
        message_text = event.message.message
        try:
            chat_info = await event.get_chat()
            chat_name = getattr(chat_info, 'title', f"ChatID:{event.chat_id}")
        except Exception:
            chat_name = f"ChatID:{event.chat_id}"

        logger.debug(f"[TG] Received message in '{chat_name}'")

        if not message_text: return

        match = CODE_REGEX.search(message_text)
        if match:
            code = match.group(1)
            logger.info(f"[TG] Detected code '{code}' in '{chat_name}'. Checking recency...")
            # Call the send function, which now includes the duplicate check
            asyncio.create_task(send_code_via_websocket(code))

    return client

# --- Main Execution ---

async def main():
    """Runs the WebSocket connector and Telegram client concurrently."""
    websocket_task = asyncio.create_task(connect_to_websocket_server())
    telegram_client = await setup_telegram_client()
    logger.info("[SYSTEM] Starting Telegram client connection...")
    try:
        await telegram_client.start(phone=PHONE_NUMBER)
        logger.info("[SYSTEM] Telegram client started successfully.")
    except Exception as e:
        logger.critical(f"[SYSTEM] Failed to start Telegram client: {e}", exc_info=True)
        return # Exit if Telegram connection fails

    telegram_task = asyncio.create_task(telegram_client.run_until_disconnected())
    await asyncio.gather(websocket_task, telegram_task)

if __name__ == "__main__":
    logger.info("[SYSTEM] Monitor script starting (with duplicate check)...")
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("[SYSTEM] Script stopped by user (Ctrl+C).")
    except Exception as e:
         logger.critical(f"[SYSTEM] An unhandled exception occurred in main execution: {e}", exc_info=True)
    finally:
        logger.info("[SYSTEM] Monitor script finished.")
