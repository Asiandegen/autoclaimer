#!/data/data/com.termux/files/usr/bin/bash

# Ensure Termux is running as the expected user
if [ "$(whoami)" == "root" ]; then
  echo "This script should not be run as root in Termux."
  exit 1
fi

echo "-------------------------------------"
echo "Updating Termux package lists..."
echo "-------------------------------------"
pkg update -y

echo "-------------------------------------"
echo "Upgrading installed packages..."
echo "-------------------------------------"
# Handle potential dpkg prompts during upgrade non-interactively
pkg upgrade -y -o Dpkg::Options::="--force-confnew"

echo "------------------------------------------------------------------------"
echo "Installing core dependencies: Node.js, Python, pip, Git, build tools..."
echo "------------------------------------------------------------------------"
# Install nodejs, python, pip (via python-pip package), git
# Also install build-essential for compiling native modules if needed by pip/npm
# Add common dependencies for cryptography (used by telethon) and other native modules
# Added 'rust' because it was needed for 'oxc-parser' in Nuxt setup, might help elsewhere too.
pkg install nodejs python python-pip git build-essential libffi openssl rust nano -y

# Check if installations were successful (basic check)
if ! command -v node &> /dev/null || ! command -v python &> /dev/null || ! command -v pip &> /dev/null; then
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "ERROR: Failed to install core dependencies (Node.js/Python/pip)."
    echo "Please check network connection and run 'pkg update && pkg upgrade' again."
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    exit 1
fi

# Clear pip cache (optional, can sometimes resolve issues)
# echo "Clearing pip cache..."
# pip cache purge

echo "-------------------------------------------------------"
echo "Installing Python dependencies for telegram_monitor.py..."
echo "-------------------------------------------------------"
# Ensure pip is up-to-date
pip install --upgrade pip
# Install necessary Python libraries for the script
echo "Installing telethon and websockets..."
pip install telethon websockets

# Verify Python packages (basic check)
if ! pip show telethon &> /dev/null || ! pip show websockets &> /dev/null; then
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "ERROR: Failed to install Python dependencies."
    echo "Check pip output above for errors."
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    # Don't exit, maybe user wants to proceed anyway
fi

echo ""
echo "-------------------------------------"
echo "✅ System dependencies installed."
echo "-------------------------------------"
echo ""
echo "NEXT STEPS:"
echo "====================================="
echo "1. Ensure you have your project files (server.js, telegram_monitor.py)"
echo "   in your project directory (e.g., '~/autoclaimer')."
echo "   If not, navigate to it ('cd ~/autoclaimer') or create them."
echo ""
echo "2. Navigate into your project directory:"
echo "   cd ~/autoclaimer"
echo ""
echo "3. Install Node.js dependencies for server.js:"
echo "   If you don't have a 'package.json', create one first:"
echo "     npm init -y"
echo "   Then install the libraries:"
echo "     npm install express ws"
echo "   (or if using pnpm: pnpm add express ws)"
echo ""
echo "4. Configure 'telegram_monitor.py':"
echo "   Edit the file (e.g., 'nano telegram_monitor.py') and enter your"
echo "   Telegram API_ID, API_HASH, PHONE_NUMBER, and TARGET_CHATS."
echo ""
echo "5. Run the services (each in a separate Termux session):"
echo "   Session 1: node server.js"
echo "   Session 2: python telegram_monitor.py"
echo "====================================="
echo ""
echo "IMPORTANT: Remember to run 'npm install' (or 'pnpm add') *inside* your project directory!"
echo ""
