#!/bin/bash

# Ensure the script is run with root privileges
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script as root using sudo."
  exit 1
fi

# Determine the user who ran sudo, fallback to current user
TARGET_USER=${SUDO_USER:-$(whoami)}
TARGET_HOME=$(eval echo "~$TARGET_USER")
WORKSPACE_DIR="$TARGET_HOME/ament_ws/src/stretch4_web_teleop"
SERVICE_PATH="/etc/systemd/system/stretch-web-teleop-daemon.service"

echo "Installing service for user: $TARGET_USER"
echo "Using workspace directory: $WORKSPACE_DIR"

# Generate the systemd service file dynamically
cat << EOF > "$SERVICE_PATH"
[Unit]
Description=Stretch Web Teleop Onboard Firebase Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$TARGET_USER
WorkingDirectory=$WORKSPACE_DIR
ExecStart=/usr/bin/node $WORKSPACE_DIR/scripts/stretch_firebase_daemon.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd, enable, and start the service
echo "Reloading systemd daemon..."
systemctl daemon-reload

echo "Enabling stretch-web-teleop-daemon.service..."
systemctl enable stretch-web-teleop-daemon.service

echo "Starting stretch-web-teleop-daemon.service..."
systemctl start stretch-web-teleop-daemon.service

echo "Installation complete. The stretch-web-teleop-daemon service is now running."
echo "You can check its status using: sudo systemctl status stretch-web-teleop-daemon.service"
