#!/bin/bash
set -e

# Define color variables
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color (Reset)

INSTALL=false
REFRESH=false
DEPLOY=false

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --install) INSTALL=true ;;
        --refresh) REFRESH=true ;;
        --deploy) DEPLOY=true ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

# If no flags are passed, show usage
if [ "$INSTALL" = false ] && [ "$REFRESH" = false ] && [ "$DEPLOY" = false ]; then
    echo -e "${YELLOW}Usage: $0 [--install] [--refresh] [--deploy]${NC}"
    echo "  --install   Creates and starts the background daemon service"
    echo "  --refresh   Restarts any background processes"
    echo "  --deploy    Compiles the production assets and deploys to Firebase"
    exit 1
fi

echo "######################################################"
echo -e "${BLUE}STRETCH WEB TELEOP DASHBOARD UTILITY${NC}"
echo "######################################################"
echo ""

if [ "$INSTALL" = true ]; then
    echo -e "${BLUE}--- Installing and starting the background daemon ---${NC}"
    if [ -f "./scripts/install_daemon.sh" ]; then
        sudo ./scripts/install_daemon.sh
    else
        echo -e "${RED}ERROR:${NC} ./scripts/install_daemon.sh not found. Ensure you are in the project root."
        exit 1
    fi
    echo ""
fi

if [ "$REFRESH" = true ]; then
    echo -e "${BLUE}--- Refreshing background processes ---${NC}"
    echo "Clearing all running PM2 web server and browser processes..."
    pm2 stop all 2>/dev/null || true
    pm2 delete all 2>/dev/null || true

    echo "Restarting the background systemd daemon..."
    # Attempt to restart the systemd service. If it fails, fallback to pkill.
    if sudo systemctl restart stretch-web-teleop-daemon.service 2>/dev/null; then
        echo -e "${GREEN}✓ stretch-web-teleop-daemon.service restarted.${NC}"
    else
        echo -e "${YELLOW}Warning: Could not restart service via systemctl. Attempting pkill fallback...${NC}"
        pkill -f stretch_firebase_daemon.js || true
    fi

    echo -e "${GREEN}✓ Background processes refreshed!${NC}"
    echo -e "The robot status has been reset to: ${YELLOW}standby${NC}"
    echo ""
fi

if [ "$DEPLOY" = true ]; then
    echo -e "${BLUE}--- Deploying to Firebase ---${NC}"
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
    echo -e "${BLUE}Building production assets...${NC}"
    npm run build
    echo -e "${GREEN}✓ Production build complete${NC}"
    echo ""

    # 3. Deploy Static Files to Firebase Hosting
    echo -e "${BLUE}Deploying to Firebase...${NC}"
    if ! command -v firebase &> /dev/null; then
        echo -e "${YELLOW}Warning: Global 'firebase' CLI not found. Trying local npx firebase...${NC}"
        npx firebase deploy --only hosting
    else
        firebase deploy --only hosting
    fi
    echo -e "${GREEN}✓ Deployment successful!${NC}"
    echo ""
    
    echo "######################################################"
    echo -e "${GREEN}SUCCESS! DASHBOARD DEPLOYED!${NC}"
    echo -e "To start the session, go to the dashboard:"
    echo -e "  ${BLUE}https://${HOSTED_URL}/${NC}"
    echo -e "And click ${GREEN}Launch Interface${NC} to spin up ROS and the client browser!"
    echo "######################################################"
    echo ""
fi
