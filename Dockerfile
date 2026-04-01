FROM node:18-slim

RUN apt-get update && apt-get install -y \
    chromium \
    libgl1-mesa-dri \
    libgl1-mesa-glx \
    libegl1-mesa \
    libgles2-mesa \
    mesa-utils \
    xvfb \
    pulseaudio \
    pulseaudio-utils \
    ffmpeg \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV DISPLAY=:99
ENV PULSE_SERVER=unix:/tmp/pulse/native

COPY . .

EXPOSE 8081

# Boot sequence:
# 1. Start PulseAudio in system mode with null sink (virtual audio device)
# 2. Wait for PulseAudio socket to be ready
# 3. Load null sink module so Chrome has somewhere to output audio
# 4. Start Xvfb virtual display
# 5. Start Node server
CMD Xvfb :99 -screen 0 1024x768x24 -ac +extension GLX +render -noreset & \
    sleep 2 && \
    mkdir -p /tmp/pulse && \
    pulseaudio --system \
               --disallow-module-loading=false \
               --disallow-exit \
               --daemonize=true && \
    sleep 5 && \
    pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description=VirtualSpeaker && \
    pactl set-default-sink virtual_speaker && \
    echo "PulseAudio ready with virtual_speaker sink" && \
    node server-b.js
