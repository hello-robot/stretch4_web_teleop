#!/bin/bash

# Usage: ./configure_audio.sh -s <speaker_name> -m <mic_name>
#
# To get a list of valid speaker names, run:
#     pactl list short sinks
# To get a list of valid microphone names, run:
#     pactl list short sources
# Note that with a microphone, there is no need to specify a device name if there is
# only one external mic plugged in; that one will **always** be prioritized over the
# robot's built-in microphone. The only way to use the robot's built-in microphone
# is to disconnect all external microphones.

# Configure command line arguments
SPEAKER_NAME="alsa_output.pci-0000_00_1f.3.analog-stereo"
MIC_NAME=""
SPEAKER_OVERRIDDEN=false
while getopts ":s:m:" opt; do
	case $opt in
	s)
		SPEAKER_NAME="$OPTARG"
		SPEAKER_OVERRIDDEN=true
		;;
	m)
		MIC_NAME="$OPTARG"
		;;
	esac
done

echo "Configuring audio...Note that this script may not work if X-11 forwarding is enabled."

# ------------------------------------------------------------------------------
# 0. Daemon launch environment variables
# ------------------------------------------------------------------------------

# Ensure pactl can always find the user's PipeWire socket (for daemons / non-login shells)
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export PULSE_RUNTIME_PATH="${PULSE_RUNTIME_PATH:-$XDG_RUNTIME_DIR/pulse}"

# Clear any PULSE_SERVER override injected by xrdp or SSH X11 forwarding
# so teleop always configures the robot's local audio server
unset PULSE_SERVER

# ------------------------------------------------------------------------------
# 1. Recover ALSA hardware cards in PipeWire (if dropped by RDP / headless seat)
# ------------------------------------------------------------------------------
USB_CARD_ID="Phone"

if grep -q "\[$USB_CARD_ID" /proc/asound/cards 2>/dev/null; then
	# If PipeWire lost the USB Speaker Phone (e.g., stuck on auto_null after RDP),
	# reload the card into user-space PipeWire memory without needing sudo.
	if ! pactl list short sources 2>/dev/null | grep -qi "usb\|teleop_phone\|Phone"; then
		echo "    Recovering USB Speaker Phone ($USB_CARD_ID) into PipeWire..."
		pactl load-module module-alsa-card device_id="$USB_CARD_ID" card_name="teleop_phone" >/dev/null 2>&1 || true
		sleep 0.5
	fi
fi

# Also recover onboard PCI audio if PipeWire dropped it after an RDP session
if grep -q "\[PCH" /proc/asound/cards 2>/dev/null; then
	if ! pactl list short sinks 2>/dev/null | grep -qi "pci\|teleop_pci"; then
		echo "    Recovering onboard PCI audio into PipeWire..."
		pactl load-module module-alsa-card device_id="PCH" card_name="teleop_pci" >/dev/null 2>&1 || true
		sleep 0.5
	fi
fi

# ------------------------------------------------------------------------------
# 2. Set the default speaker (sink)
# ------------------------------------------------------------------------------
sinks=$(pactl list short sinks 2>/dev/null)

# If user didn't explicitly pass -s and the default PCI sink isn't present,
# fall back to the recovered PCI sink or the USB Speaker Phone sink.
if [ "$SPEAKER_OVERRIDDEN" = false ] && [[ $sinks != *"$SPEAKER_NAME"* ]]; then
	FALLBACK_SINK=$(echo "$sinks" | awk '/(usb|teleop_phone|Phone|pci|teleop_pci)/ && !/monitor/ {print $2; exit}')
	if [ -n "$FALLBACK_SINK" ]; then
		SPEAKER_NAME="$FALLBACK_SINK"
	fi
fi

if [[ -n "$SPEAKER_NAME" && $sinks == *"$SPEAKER_NAME"* ]]; then
	echo "    Setting speaker to $SPEAKER_NAME"
	pactl set-default-sink "$SPEAKER_NAME"
	pactl set-sink-mute "$SPEAKER_NAME" 0 2>/dev/null || true
	pactl set-sink-volume "$SPEAKER_NAME" 100% 2>/dev/null || true
else
	echo "    Speaker name '$SPEAKER_NAME' is invalid or unavailable"
	echo "    To get valid speaker names, run:"
	echo "        pactl list short sinks"
fi

# ------------------------------------------------------------------------------
# 3. Set the default microphone (source)
# ------------------------------------------------------------------------------
sources=$(pactl list short sources 2>/dev/null)

# Auto-prioritize external USB microphone if -m was not specified
if [ ${#MIC_NAME} -eq 0 ]; then
	AUTO_MIC=$(echo "$sources" | awk '/(usb|teleop_phone|Phone)/ && !/monitor/ {print $2; exit}')
	if [ -z "$AUTO_MIC" ]; then
		# Fallback to any non-monitor physical input source
		AUTO_MIC=$(echo "$sources" | awk '!/monitor/ && !/auto_null/ {print $2; exit}')
	fi
	MIC_NAME="$AUTO_MIC"
fi

if [ ${#MIC_NAME} -gt 0 ]; then
	if [[ $sources == *"$MIC_NAME"* ]]; then
		echo "    Setting microphone to $MIC_NAME"
		pactl set-default-source "$MIC_NAME"
		pactl set-source-mute "$MIC_NAME" 0 2>/dev/null || true
		pactl set-source-volume "$MIC_NAME" 100% 2>/dev/null || true
	else
		echo "    Microphone name '$MIC_NAME' is invalid"
		echo "    To get valid microphone names, run:"
		echo "        pactl list short sources"
	fi
else
	echo "    Warning: No valid microphone source found in PipeWire."
fi

# ------------------------------------------------------------------------------
# 4. Unmute and set volume to 100% across ALL hardware ALSA cards (PCI & USB)
# ------------------------------------------------------------------------------
amixer_devices=('Master' 'PCM' 'Speaker' 'Capture' 'Mic' 'Digital')

# Iterate through all active ALSA card numbers (e.g., 0 for PCH, 1 for Phone)
for card_num in $(awk '/^ *[0-9]+ \[/ {print $1}' /proc/asound/cards 2>/dev/null); do
	amixer_output=$(amixer -c "$card_num" scontrols 2>/dev/null)
	for device in "${amixer_devices[@]}"; do
		if [[ $amixer_output == *"'$device'"* ]]; then
			echo "    Unmuting '$device' on ALSA card $card_num"
			device_output=$(amixer -c "$card_num" get "$device" 2>/dev/null)
			if [[ $device_output == *"[off]"* ]]; then
				if [[ $device_output == *"Capture"* ]]; then
					amixer -c "$card_num" set "$device" cap -q 2>/dev/null || true
				else
					amixer -c "$card_num" set "$device" unmute -q 2>/dev/null || true
				fi
			fi

			echo "    Setting '$device' on ALSA card $card_num to 100%"
			amixer -c "$card_num" sset "$device" 100% unmute -q 2>/dev/null ||
				amixer -c "$card_num" sset "$device" 100% cap -q 2>/dev/null ||
				amixer -c "$card_num" sset "$device" 100% -q 2>/dev/null || true
		fi
	done
done

echo "Done configuring audio!"
