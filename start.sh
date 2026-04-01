#!/bin/bash
set -e

echo "=== Starting arcade2 server ==="

# Clean up stale Xvfb lock
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

# Start Xvfb
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1024x768x24 -ac +extension GLX +render -noreset &
sleep 2
echo "Xvfb started"

# Run PulseAudio as a regular user daemon (not --system)
# This avoids all the permission issues with system mode
echo "Starting PulseAudio as user daemon..."
mkdir -p /tmp/pulse

# Kill any existing pulseaudio
pulseaudio --kill 2>/dev/null || true
sleep 1

# Start as user daemon with explicit socket path
pulseaudio --daemonize=true \
           --exit-idle-time=-1 \
           --log-target=stderr \
           --load="module-native-protocol-unix auth-anonymous=1 socket=/tmp/pulse/native" \
           --load="module-null-sink sink_name=virtual_speaker" \
           || true

# Wait for socket
echo "Waiting for PulseAudio socket..."
for i in $(seq 1 15); do
  if [ -S "/tmp/pulse/native" ]; then
    echo "PulseAudio socket ready after ${i}s"
    break
  fi
  echo "  waiting... (${i}s)"
  sleep 1
done

export PULSE_SERVER="unix:/tmp/pulse/native"
echo "Using PULSE_SERVER=${PULSE_SERVER}"

# Set default sink
pactl set-default-sink virtual_speaker 2>/dev/null || true

# Verify sources
echo "=== PulseAudio sources ==="
pactl list short sources 2>/dev/null || true
echo "=== PulseAudio ready ==="

exec node server-b.js
