import re
import requests
from telethon import TelegramClient, events

API_ID = 123456  # replace with your API ID
API_HASH = "your_api_hash"
SESSION_NAME = "stake_monitor"

TARGET_CHATS = [-1002140237447, -1001768427488]
CODE_REGEX = re.compile(r'\bcode:\s*([a-zA-Z0-9]+)\b', re.IGNORECASE)

sent_codes = set()

client = TelegramClient(SESSION_NAME, API_ID, API_HASH)

def send_code(code):
    if code in sent_codes:
        return
    sent_codes.add(code)
    try:
        res = requests.post("http://localhost:8765/send-code", json={"code": code})
        print(f"Sent: {code} | Status: {res.status_code}")
    except Exception as e:
        print("Error sending code:", e)

@client.on(events.NewMessage(chats=TARGET_CHATS))
async def handler(event):
    message = event.message.message
    match = CODE_REGEX.search(message)
    if match:
        code = match.group(1)
        print("Detected code:", code)
        send_code(code)

print("Starting Telegram client...")
client.start()
client.run_until_disconnected()
