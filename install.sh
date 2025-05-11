#!/data/data/com.termux/files/usr/bin/bash

# Update packages
pkg update -y
pkg upgrade -y

# Install Node.js and Python
pkg install -y nodejs python git

# Install pip packages
pip install requests telethon

# Install Node modules
npm install express ws

echo ""
echo "✅ Setup complete. Now run:"
echo "1. node server.js (in one session)"
echo "2. python telegram_monitor.py (in another session)"
