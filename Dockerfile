FROM node:18-slim

# Install Chromium + Mesa software WebGL renderer
# Mesa provides the GLctx/EGL support EmulatorJS needs
RUN apt-get update && apt-get install -y \
    chromium \
    libgl1-mesa-dri \
    libgl1-mesa-glx \
    libegl1-mesa \
    libgles2-mesa \
    mesa-utils \
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

# Use system Chromium — skip Puppeteer's bundled download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY . .

EXPOSE 8081

CMD ["node", "server-b.js"]
