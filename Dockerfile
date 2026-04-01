FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# ── System dependencies ────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    xvfb \
    x11-utils \
    xdotool \
    ffmpeg \
    pulseaudio \
    pulseaudio-utils \
    # RetroArch handles both SNES and NES via cores
    retroarch \
    libgtk-3-0 \
    libglu1-mesa \
    libgl1-mesa-glx \
    libgl1-mesa-dri \
    libasound2 \
    libpulse0 \
    libsdl2-2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# ── Download RetroArch cores for SNES and NES ─────────────────────────
# snes9x core for SNES, nestopia for NES
RUN mkdir -p /root/.config/retroarch/cores && \
    curl -L "https://buildbot.libretro.com/nightly/linux/x86_64/latest/snes9x_libretro.so.zip" \
      -o /tmp/snes9x.zip && \
    unzip /tmp/snes9x.zip -d /root/.config/retroarch/cores/ && \
    curl -L "https://buildbot.libretro.com/nightly/linux/x86_64/latest/nestopia_libretro.so.zip" \
      -o /tmp/nestopia.zip && \
    unzip /tmp/nestopia.zip -d /root/.config/retroarch/cores/ && \
    rm /tmp/snes9x.zip /tmp/nestopia.zip

# ── RetroArch config for headless operation ───────────────────────────
RUN mkdir -p /root/.config/retroarch && cat > /root/.config/retroarch/retroarch.cfg << 'EOF'
video_driver = "gl"
audio_driver = "pulse"
video_fullscreen = "true"
video_windowed_fullscreen = "false"
video_window_width = "256"
video_window_height = "224"
video_vsync = "false"
fps_show = "false"
menu_driver = "null"
EOF

# ── Node.js 20 ─────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── App setup ──────────────────────────────────────────────────────────
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

COPY default.pa /etc/pulse/default.pa

EXPOSE 8080

CMD ["bash", "start.sh"]
