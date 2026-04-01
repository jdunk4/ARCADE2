FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# ── System dependencies ────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    unzip \
    xvfb \
    x11-utils \
    xdotool \
    ffmpeg \
    pulseaudio \
    pulseaudio-utils \
    retroarch \
    # Software rendering (no GPU needed)
    libgl1-mesa-dri \
    libgl1-mesa-glx \
    mesa-utils \
    libegl1-mesa \
    libgles2-mesa \
    # Other libs
    libgtk-3-0 \
    libglu1-mesa \
    libasound2 \
    libpulse0 \
    libsdl2-2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# ── Download RetroArch cores for SNES and NES ─────────────────────────
RUN mkdir -p /root/.config/retroarch/cores && \
    curl -L "https://buildbot.libretro.com/nightly/linux/x86_64/latest/snes9x_libretro.so.zip" \
      -o /tmp/snes9x.zip && \
    unzip /tmp/snes9x.zip -d /root/.config/retroarch/cores/ && \
    curl -L "https://buildbot.libretro.com/nightly/linux/x86_64/latest/nestopia_libretro.so.zip" \
      -o /tmp/nestopia.zip && \
    unzip /tmp/nestopia.zip -d /root/.config/retroarch/cores/ && \
    rm /tmp/snes9x.zip /tmp/nestopia.zip

# ── RetroArch config — software renderer, no GPU required ────────────
RUN mkdir -p /root/.config/retroarch && cat > /root/.config/retroarch/retroarch.cfg << 'EOF'
video_driver = "sdl2"
audio_driver = "pulse"
video_fullscreen = "true"
video_windowed_fullscreen = "false"
video_window_width = "256"
video_window_height = "224"
video_vsync = "false"
fps_show = "false"
menu_driver = "null"
video_gpu_record = "false"
video_shared_context = "false"
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
