# Termux Setup – Stake Bonus Code Claimer

This version runs directly inside Termux (no Docker required).

## How to Use

1. Install Termux from F-Droid or Play Store

2. Run setup script:

    chmod +x install.sh
    ./install.sh

3. Edit telegram_monitor.py and add your Telegram API_ID and API_HASH

4. Open 2 sessions in Termux:

- Session 1:
    node server.js

- Session 2:
    python telegram_monitor.py

5. In your browser with Tampermonkey, set WebSocket URL to:
    ws://<your-phone-IP>:8765

Or use it locally with browser on the same phone.

