const express   = require("express");
const http      = require("http");
const { WebSocketServer } = require("ws");
const puppeteer = require("puppeteer");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// URL of your existing game.html on GitHub Pages
// Puppeteer loads this exactly as a player's browser would
const GAME_URL = process.env.GAME_URL || "https://jdunk4.github.io/ARCADE1/game.html";

// Target frame rate for screenshot streaming
// 20fps = good balance of responsiveness vs Railway CPU/bandwidth cost
// Each JPEG frame at quality 0.6 ≈ 8-15KB → ~200KB/s per session
const TARGET_FPS = 20;
const FRAME_MS   = 1000 / TARGET_FPS;

// SNES viewport — match EmulatorJS canvas size
const VIEWPORT_W = 512;
const VIEWPORT_H = 448;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/", (req, res) => res.send("SNES Puppeteer streaming server ✅"));

// ── Key map — client sends string names, we send CDP key codes ────────────────
// Puppeteer uses KeyboardEvent key names (same as browser KeyboardEvent.key)
const KEY_MAP = {
  up:     "ArrowUp",
  down:   "ArrowDown",
  left:   "ArrowLeft",
  right:  "ArrowRight",
  a:      "z",       // EmulatorJS default: Z = A button
  b:      "x",       // EmulatorJS default: X = B button
  x:      "a",       // EmulatorJS default: A = X button
  y:      "s",       // EmulatorJS default: S = Y button
  start:  "Enter",
  select: "Shift",
  l:      "q",
  r:      "w",
};

// ── Session manager ───────────────────────────────────────────────────────────
const sessions = new Map(); // ws → { browser, page, frameInterval, wallet, romId }

async function createSession(ws, romId, wallet) {
  console.log(`[session] creating: rom=${romId} wallet=${wallet}`);

  // ── Launch headless Chrome ────────────────────────────────────────────
  const browser = await puppeteer.launch({
    headless: "new",          // use new headless mode (Chrome 112+)
    args: [
      "--no-sandbox",         // required on Railway/Linux containers
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",  // prevents /dev/shm from filling up
      "--disable-gpu",            // no GPU in Railway container
      "--autoplay-policy=no-user-gesture-required", // allow audio autoplay
    ],
  });

  const page = await browser.newPage();

  // Set viewport to match EmulatorJS canvas
  await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });

  // Pass wallet and romId into game.html via URL params
  // game.html already reads ?wallet= from URL params
  const gameUrl = `${GAME_URL}?wallet=${encodeURIComponent(wallet)}&rom=${encodeURIComponent(romId)}`;
  console.log(`[session] navigating to: ${gameUrl}`);

  await page.goto(gameUrl, { waitUntil: "networkidle0", timeout: 30000 });

  // ── Wait for EmulatorJS canvas to appear ─────────────────────────────
  // EmulatorJS renders into a canvas — wait up to 15s for it to mount
  try {
    await page.waitForSelector("canvas", { timeout: 15000 });
    console.log(`[session] canvas found — emulator loaded`);
  } catch (e) {
    console.warn(`[session] canvas not found within 15s — proceeding anyway`);
  }

  // ── Click canvas once to satisfy browser autoplay/focus requirement ──
  // This is the "click to start" that you'd normally do manually
  await page.click("canvas").catch(() => {
    // Canvas may not exist yet — that's fine, EmulatorJS will start anyway
    console.warn("[session] canvas click failed — emulator may need manual start");
  });

  console.log(`[session] starting frame loop at ${TARGET_FPS}fps`);

  // ── Frame loop — screenshot → base64 JPEG → WebSocket ────────────────
  const frameInterval = setInterval(async () => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(frameInterval);
      return;
    }

    try {
      // Capture only the canvas element, not the whole page
      // This avoids capturing browser chrome / scrollbars
      const canvasEl = await page.$("canvas");
      let imageBase64;

      if (canvasEl) {
        // Screenshot just the canvas bounding box
        imageBase64 = await canvasEl.screenshot({
          type: "jpeg",
          quality: 65,       // 65 = good visual quality, small file size
          encoding: "base64",
        });
      } else {
        // Fallback: screenshot full viewport
        imageBase64 = await page.screenshot({
          type: "jpeg",
          quality: 65,
          encoding: "base64",
        });
      }

      // Send as data URI so arcade-b.html can set it directly on m-image src
      const dataUri = "data:image/jpeg;base64," + imageBase64;
      ws.send(JSON.stringify({ image: dataUri }), (err) => {
        if (err) console.warn("[session] send error:", err.message);
      });

    } catch (e) {
      // Page may have crashed or navigated away — destroy session
      console.error("[session] screenshot failed:", e.message);
      clearInterval(frameInterval);
      destroySession(ws);
    }

  }, FRAME_MS);

  const session = { browser, page, frameInterval, wallet, romId };
  sessions.set(ws, session);
  console.log(`[session] live: ${wallet} / ${romId}`);
}

async function destroySession(ws) {
  const session = sessions.get(ws);
  if (!session) return;

  clearInterval(session.frameInterval);

  try {
    await session.browser.close();
  } catch (e) {
    console.warn("[session] browser close error:", e.message);
  }

  sessions.delete(ws);
  console.log(`[session] destroyed: ${session.wallet} / ${session.romId}`);
}

// ── WebSocket handler ─────────────────────────────────────────────────────────
wss.on("connection", async (ws, req) => {
  const url    = new URL(req.url, "http://localhost");
  const romId  = url.searchParams.get("rom")    || "kaizo-mario-world-1";
  const wallet = url.searchParams.get("wallet") || "anonymous";

  console.log(`[ws] connected: rom=${romId} wallet=${wallet}`);

  // Notify client we're booting up (Puppeteer takes ~3-5s to launch)
  ws.send(JSON.stringify({ type: "status", message: "Launching emulator..." }));

  try {
    await createSession(ws, romId, wallet);
    ws.send(JSON.stringify({ type: "status", message: "Emulator running" }));
  } catch (e) {
    console.error("[ws] session creation failed:", e.message);
    ws.send(JSON.stringify({ type: "error", message: "Failed to start emulator: " + e.message }));
    ws.close();
    return;
  }

  // ── Input handler ─────────────────────────────────────────────────────
  ws.on("message", async (data) => {
    const session = sessions.get(ws);
    if (!session) return;

    try {
      const msg = JSON.parse(data);
      const key = KEY_MAP[msg.key];
      if (!key) return;

      if (msg.type === "keyDown") {
        await session.page.keyboard.down(key);
      } else if (msg.type === "keyUp") {
        await session.page.keyboard.up(key);
      }
    } catch (e) {
      console.warn("[ws] input error:", e.message);
    }
  });

  ws.on("close", () => {
    console.log(`[ws] disconnected: ${wallet}`);
    destroySession(ws);
  });

  ws.on("error", (e) => {
    console.error("[ws] error:", e.message);
    destroySession(ws);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8081;
server.listen(PORT, () => {
  console.log(`Puppeteer SNES server on port ${PORT}`);
  console.log(`Streaming: ${TARGET_FPS}fps JPEG from ${GAME_URL}`);
});
```

---

### Key things to know before deploying

**Railway environment variables to set:**
```
GAME_URL=https://jdunk4.github.io/ARCADE1/game.html
PORT=8081
