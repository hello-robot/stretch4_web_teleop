#!/bin/bash
set -o pipefail

# Define color variables
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color (Reset)

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FEATURE_VOICE_CONTROL_INTERFACE="$(node "$REPO_DIR/feature-flags.js" voice_control_interface)" || exit 1
export FEATURE_VOICE_CONTROL_INTERFACE

while getopts m:t:f opt; do
	case $opt in
	m)
		# Usage: ./launch_interface.sh -m $HELLO_FLEET_PATH/maps/<map_name>.yaml
		if [[ -f $OPTARG ]]; then
			MAP="-m $OPTARG"
		fi
		;;
	f)
		# Usage: ./launch_interface.sh -f
		FIREBASE="-f"
		;;
	esac
done

timestamp='stretch4_web_teleop_'$(date '+%Y%m%d%H%M')
logdir="$HOME/stretch_user/log/web_teleop/$timestamp"
logfile_ros="$logdir/start_ros2.txt"
logfile_node="$logdir/start_web_server_and_robot_browser.txt"
logzip="$logdir/stretch4_web_teleop_logs.zip"
mkdir -p $logdir
# Stable pointer at this run's timestamped $logdir (mirrors ROS's own
# ~/.ros/log/latest convention) so tools started outside this script — e.g.
# `terminator -g tools/terminator/config`'s watch-* panes, which have no
# REDIRECT_LOGDIR of their own — tail the current run instead of a stale one.
ln -sfn "$logdir" "$HOME/stretch_user/log/web_teleop/latest_run"

echo ""
echo "#############################################"
echo -e "${GREEN}STRETCH VOICE CONTROL (SVC)${NC}"
echo "#############################################"
echo ""

# Voice JSONL logs and audio-snippet clips (when voice_input_recording is
# enabled) are written under this run's own timestamped $logdir — see
# voiceInteractionLogger.js's getLogDir/getVoiceAudioDir. Nothing accumulates
# in a separate persistent directory across runs, so there is no pre-run disk
# usage to report here.
web_teleop_du=$(du -sh "$HOME/stretch_user/log/web_teleop" 2>/dev/null | awk '{print $1}')
echo -e "${BLUE}web_teleop logs total size:${NC} ${web_teleop_du:-0} in $HOME/stretch_user/log/web_teleop (not auto-purged; purge old run folders manually if desired)"

# Validate web teleop installation
function validate_installation {
	local cert_dir="$HOME/ament_ws/src/stretch4_web_teleop/certificates"
	local env_file="$HOME/ament_ws/src/stretch4_web_teleop/.env"

	echo -e "Validating web teleop installation..."

	# Check certificates folder exists
	if [ ! -d "$cert_dir" ]; then
		echo -e "${RED}ERROR:${NC} Certificates folder not found at $cert_dir"
		echo "       Update your ROS workspace: https://docs.hello-robot.com/0.3/installation/ros_workspace/"
		return 1
	fi

	# Check .env file exists
	if [ ! -f "$env_file" ]; then
		echo -e "${RED}ERROR:${NC} .env file not found at $env_file"
		echo "       Update your ROS workspace: https://docs.hello-robot.com/0.3/installation/ros_workspace/"
		return 1
	fi

	# Check certificate files exist with correct naming
	local certfile_name="${HELLO_FLEET_ID}+6.pem"
	local keyfile_name="${HELLO_FLEET_ID}+6-key.pem"

	if [ ! -f "$cert_dir/$certfile_name" ]; then
		echo -e "${RED}ERROR:${NC} Certificate file not found at $cert_dir/$certfile_name"
		echo "       Update your ROS workspace: https://docs.hello-robot.com/0.3/installation/ros_workspace/"
		return 1
	fi

	if [ ! -f "$cert_dir/$keyfile_name" ]; then
		echo -e "${RED}ERROR:${NC} Key file not found at $cert_dir/$keyfile_name"
		echo "       Update your ROS workspace: https://docs.hello-robot.com/0.3/installation/ros_workspace/"
		return 1
	fi

	# Validate .env file contains correct paths
	local env_certfile=$(grep '^certfile=' "$env_file" | cut -d'=' -f2)
	local env_keyfile=$(grep '^keyfile=' "$env_file" | cut -d'=' -f2)

	if [ "$env_certfile" != "$certfile_name" ]; then
		echo -e "${RED}ERROR:${NC} .env certfile is set to '$env_certfile' but should be '$certfile_name'"
		echo "       Update your ROS workspace: https://docs.hello-robot.com/0.3/installation/ros_workspace/"
		return 1
	fi

	if [ "$env_keyfile" != "$keyfile_name" ]; then
		echo -e "${RED}ERROR:${NC} .env keyfile is set to '$env_keyfile' but should be '$keyfile_name'"
		echo "       Update your ROS workspace: https://docs.hello-robot.com/0.3/installation/ros_workspace/"
		return 1
	fi

	# Check node_modules folder exists
	local node_modules_dir="$HOME/ament_ws/src/stretch4_web_teleop/node_modules"
	if [ ! -d "$node_modules_dir" ]; then
		echo -e "${RED}ERROR:${NC} node_modules folder not found at $node_modules_dir"
		echo "       Run 'npm install --force' to install dependencies OR update your ROS workspace https://docs.hello-robot.com/0.3/installation/ros_workspace/"
		return 1
	fi

	# Check npm dependencies have no errors
	cd "$HOME/ament_ws/src/stretch4_web_teleop"
	npm list --depth=0 >/dev/null 2>&1
	if [ $? -ne 0 ]; then
		echo -e "${RED}ERROR:${NC} npm dependencies have errors. "
		echo "       Run 'npm install --force' to fix OR update your ROS workspace https://docs.hello-robot.com/0.3/installation/ros_workspace/"
		return 1
	fi

	echo -e "${GREEN}✓ Installation validation passed${NC}"
	return 0
}

function echo_failure_help {
	zip -r $logzip $logdir/ >/dev/null
	echo ""
	echo "#############################################"
	echo -e "${RED}FAILURE. COULD NOT LAUNCH WEB TELEOP.${NC}"
	echo "Look at the troubleshooting guide for solutions to common issues: https://docs.hello-robot.com/0.3/getting_started/demos_web_teleop/#troubleshooting"
	echo "or contact Hello Robot support and include $logzip"
	echo "#############################################"
	echo ""
	exit 1
}

function print_interface_urls {
	ifconfig | awk '
	  /^[^ \t]/ {
	    iface=$1
	    sub(/:$/, "", iface)
	    next
	  }
	  /inet / {
	    ip=""
	    for (i=1; i<=NF; i++) {
	      if ($i ~ /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/) {
	        ip=$i
	        break
	      }
	    }
	    if (ip == "" || ip == "127.0.0.1") next

	    if (iface == "tailscale0") {
	      print "Tailscale: https://" ip "/operator"
	    } else if (iface ~ /^(wlan|wl)/) {
	      print "WiFi: https://" ip "/operator"
	    } else if (iface ~ /^(eth|en)/) {
	      print "Ethernet: https://" ip "/operator"
	    } else {
	      print iface ": https://" ip "/operator"
	    }
	  }'
}

echo ""
echo "#############################################"
echo "LAUNCHING WEB TELEOP"
echo "#############################################"

echo "Feature Flags:"
while IFS='=' read -r var value; do
	if [[ "$value" -eq 1 ]]; then
		echo -e "  ${GREEN}$var=$value${NC}"
	else
		echo -e "  ${RED}$var=$value${NC}"
	fi
done < <(node "$REPO_DIR/feature-flags.js" --all)

validate_installation
if [ $? -ne 0 ]; then
	echo_failure_help
fi

cd $HOME/ament_ws/src/stretch4_web_teleop
./start_ros2.sh -l $logdir $MAP |& tee $logfile_ros
if [ $? -ne 0 ]; then
	echo_failure_help
fi

# echo ""
cd $HOME/ament_ws/src/stretch4_web_teleop
./start_web_server_and_robot_browser.sh -l $logdir -o $logfile_node $FIREBASE |& tee -a $logfile_node
if [ $? -ne 0 ]; then
	echo_failure_help
fi

zip -r $logzip $logdir/ >/dev/null

echo ""
echo "#############################################"
echo -e "${GREEN}DONE! WEB TELEOP IS UP!${NC}"
echo "Visit the appropriate URL(s) below to see web teleop:"
if [ "$FIREBASE" = "-f" ]; then
	echo "https://web.hello-robot.com/"
else
	echo "Localhost: https://localhost/operator"
	print_interface_urls
fi
echo "#############################################"
echo ""
