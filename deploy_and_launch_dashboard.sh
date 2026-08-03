#!/bin/bash
set -e

# Define color variables
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color (Reset)

echo "######################################################"
echo -e "${BLUE}DEPLOYING TO FIREBASE HOSTING & LAUNCHING CLIENT${NC}"
echo "######################################################"

# 1. Resolve Firebase Project URL
FIREBASE_RC=".firebaserc"
if [ ! -f "$FIREBASE_RC" ]; then
    echo -e "${RED}ERROR:${NC} .firebaserc not found. Ensure you are in the project root."
    exit 1
fi

PROJECT_ID=$(grep -o '"default": "[^"]*' "$FIREBASE_RC" | cut -d'"' -f4)
if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}ERROR:${NC} Could not parse default project ID from .firebaserc"
    exit 1
fi

HOSTED_URL="${PROJECT_ID}.web.app"
echo -e "Resolved Firebase Project ID: ${GREEN}${PROJECT_ID}${NC}"
echo -e "Resolved Firebase Hosted URL:  ${GREEN}https://${HOSTED_URL}${NC}"
echo ""

# 2. Compile Production Assets
echo -e "${BLUE}1. Building production assets...${NC}"
npm run build
echo -e "${GREEN}✓ Production build complete${NC}"
echo ""

# 3. Deploy Static Files to Firebase Hosting
echo -e "${BLUE}2. Deploying to Firebase Hosting...${NC}"
if ! command -v firebase &> /dev/null; then
    echo -e "${YELLOW}Warning: Global 'firebase' CLI not found. Trying local npx firebase...${NC}"
    npx firebase deploy --only hosting
else
    firebase deploy --only hosting
fi
echo -e "${GREEN}✓ Deployment successful!${NC}"
echo ""

# Stop and delete PM2 processes to ensure a clean standby state
echo "Clearing all running PM2 web server and browser processes..."
pm2 stop all 2>/dev/null || true
pm2 delete all 2>/dev/null || true

# Kill the systemd daemon process so it restarts cleanly and updates its state to standby
echo "Refreshing the background systemd daemon..."
pkill -f stretch_firebase_daemon.js || true

echo ""
echo "######################################################"
echo -e "${GREEN}SUCCESS! DAEMON REFRESHED & DASHBOARD DEPLOYED!${NC}"
echo -e "The robot status has been reset to: ${YELLOW}standby${NC}"
echo ""
echo -e "To start the session, go to the dashboard:"
echo -e "  ${BLUE}https://${HOSTED_URL}/${NC}"
echo -e "And click ${GREEN}Launch Interface${NC} to spin up ROS and the client browser!"
echo "######################################################"
echo ""
