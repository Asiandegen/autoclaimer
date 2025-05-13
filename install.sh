#!/bin/bash

# This script prepares a Debian/Ubuntu VPS for running the
# Node.js WebSocket server and Python Telegram monitor.

echo "--- Updating System Packages ---"
sudo apt update && sudo apt upgrade -y

# Check if sudo is needed again might depend on session timeout
echo "--- Installing Dependencies (Git, Python3, Pip3, Curl) ---"
sudo apt install -y git python3 python3-pip curl

# Install Node.js LTS using NodeSource repository
# See: https://github.com/nodesource/distributions
echo "--- Installing Node.js (LTS) and npm ---"
# Check if Node.js is already installed (optional, avoids re-running NodeSource setup)
if ! command -v node > /dev/null; then
  echo "Node.js not found, installing..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt install -y nodejs
else
  echo "Node.js is already installed. Skipping NodeSource setup."
  # Optionally, ensure npm is installed if nodejs package didn't include it
  if ! command -v npm > /dev/null; then
     echo "npm not found, installing..."
     sudo apt install -y npm
  fi
fi


echo "--- Verifying Installations ---"
git --version
python3 --version
pip3 --version
node -v
npm -v

echo ""
echo "✅ Base dependencies installed successfully."
echo ""
echo "--- Next Steps ---"
echo "1. Clone your Git repository or upload your files (`server.js`, `telegram_monitor.py`) to the VPS."
echo "2. Navigate (`cd`) into your project directory."
echo "3. Install Node.js dependencies: npm install ws"
echo "4. Install Python dependencies: pip3 install telethon websockets"
echo "5. Configure API keys and chat IDs in 'telegram_monitor.py'."
echo "6. IMPORTANT: Update the WebSocket URL in your Tampermonkey userscripts to point to 'ws://<your_vps_ip_or_domain>:8765/'."
echo "7. Configure your VPS firewall to allow TCP traffic on port 8765 (e.g., 'sudo ufw allow 8765/tcp')."
echo "8. Run the scripts using a process manager like pm2:"
echo "   - sudo npm install -g pm2"
echo "   - pm2 start server.js --name stake-ws-server"
echo "   - pm2 start telegram_monitor.py --interpreter python3 --name stake-tg-monitor"
echo "   - pm2 startup # <-- Follow instructions"
echo "   - pm2 save"
echo "   - pm2 list"
echo "   - pm2 logs <name>"
