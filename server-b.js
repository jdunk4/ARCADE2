const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const puppeteer = require("puppeteer");
const { spawn } = require("child_process");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const GAME_BASE_URL     = process.env.GAME_URL    || "https://jdunk4.github.io/ARCADE1/game.html";
const LOADING_URL       = process.env.LOADING_URL || "https://jdunk4.github.io/ARCADE1/loading.html";
const TARGET_FPS        = 30;
const FRAME_MS          = 1000 / TARGET_FPS;
const VIEWPORT_W        = 512;
const VIEWPORT_H        = 448;
const JPEG_QUALITY      = 50;
const LOADING_SCREEN_MS = 20000;

// Path to Pokemon Insurgence Game.exe on the server
// Upload the game folder to Railway via volume or include in repo
const INSURGENCE_PATH = process.env.INSURGENCE_PATH || "/app/insurgence/Game.exe";
const DISPLAY         = process.env.DISPLAY          || ":99";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/", (req, res) => res.send("SNES Puppeteer streaming server OK"));

app.get("/debug-screenshot.jpg", (req, res) => {
  var p = "/tmp/debug-screenshot.jpg";
  if (fs.existsSync(p)) {
    res.setHeader("Content-Type", "image/jpeg");
    res.sendFile(p);
  } else {
    res.status(404).send("No screenshot yet");
  }
});

// Full virtual display capture — visit /debug-display.jpg while Wine game is running
app.get("/debug-display.jpg", function(req, res) {
  var execSync = require("child_process").execSync;
  try {
    execSync("ffmpeg -y -f x11grab -r 1 -s 1024x768 -i :99.0+0,0 -vframes 1 /tmp/debug-display.jpg 2>/dev/null || true");
    var p = "/tmp/debug-display.jpg";
    if (fs.existsSync(p)) {
      res.setHeader("Content-Type", "image/jpeg");
      res.sendFile(p);
    } else {
      res.status(404).send("No display screenshot — is a Wine session running?");
    }
  } catch(e) { res.status(500).send("Error: " + e.message); }
});

// ── Key maps ──────────────────────────────────────────────────────────────────

// For EmulatorJS (Puppeteer) sessions
const KEY_MAP = {
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  a: "z", b: "x", x: "a", y: "s",
  start: "Enter", select: "Shift", l: "q", r: "w"
};

// For Wine sessions — xdotool key names
const WINE_KEY_MAP = {
  up:     "Up",
  down:   "Down",
  left:   "Left",
  right:  "Right",
  a:      "z",        // confirm / interact
  b:      "x",        // cancel / back
  x:      "a",
  y:      "s",
  start:  "Return",
  select: "Shift_L",
  l:      "q",
  r:      "w"
};

const sessions = new Map();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WINE SESSION — Pokemon Insurgence
// Uses: wine Game.exe on virtual display, ffmpeg captures screen + audio
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function createWineSession(ws, romId, wallet) {
  console.log("[wine] creating session: id=" + romId + " wallet=" + wallet);

  ws.send(JSON.stringify({ type: "status", message: "Starting Pokemon Insurgence..." }));

  // ── Step 1: Launch Wine process ───────────────────────────────
  var wineProc = null;
  try {
    wineProc = spawn("wine", [INSURGENCE_PATH], {
      env: Object.assign({}, process.env, {
        DISPLAY: DISPLAY,
        WINEDEBUG: "-all"   // suppress wine debug spam
      }),
      stdio: ["ignore", "pipe", "pipe"]
    });

    wineProc.stdout.on("data", function(d) { console.log("[wine] " + d.toString().trim()); });
    wineProc.stderr.on("data", function(d) {
      var line = d.toString().trim();
      // Only log actual errors, not wine debug noise
      if (line.includes("err:") || line.includes("fixme:")) return;
      if (line.length > 0) console.log("[wine] " + line);
    });
    wineProc.on("close", function(code) {
      console.log("[wine] process exited code " + code);
      destroySession(ws);
    });
    wineProc.on("error", function(e) {
      console.error("[wine] failed to start: " + e.message);
      ws.send(JSON.stringify({ type: "error", message: "Wine failed: " + e.message }));
    });

    console.log("[wine] Game.exe launched (pid " + wineProc.pid + ")");

  } catch(e) {
    ws.send(JSON.stringify({ type: "error", message: "Could not launch Wine: " + e.message }));
    ws.close();
    return;
  }

  // ── Step 2: Wait for game window to appear ────────────────────
  console.log("[wine] waiting 8s for game window...");
  await new Promise(function(r) { setTimeout(r, 8000); });
  ws.send(JSON.stringify({ type: "status", message: "Loading game..." }));

  // ── Step 3: ffmpeg — capture screen frames from virtual display ─
  // Captures the full virtual display at TARGET_FPS, outputs MJPEG frames
  var ffmpegVideo = spawn("ffmpeg", [
    "-f", "x11grab",
    "-r", String(TARGET_FPS),
    "-s", "512x448",
    "-i", DISPLAY + ".0+0,0",         // game window at top-left of virtual display
    "-vf", "scale=" + VIEWPORT_W + ":" + VIEWPORT_H,
    "-c:v", "mjpeg",
    "-q:v", "5",                       // quality 1=best 31=worst, 5 is good balance
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  // Parse MJPEG stream into individual JPEG frames and send over WS
  var jpegBuffer = Buffer.alloc(0);
  var SOI = Buffer.from([0xFF, 0xD8]); // JPEG start marker
  var EOI = Buffer.from([0xFF, 0xD9]); // JPEG end marker

  ffmpegVideo.stdout.on("data", function(chunk) {
    jpegBuffer = Buffer.concat([jpegBuffer, chunk]);

    // Extract complete JPEG frames from the stream
    while (true) {
      var start = jpegBuffer.indexOf(SOI);
      if (start === -1) { jpegBuffer = Buffer.alloc(0); break; }
      var end = jpegBuffer.indexOf(EOI, start + 2);
      if (end === -1) break; // incomplete frame, wait for more data
      end += 2; // include EOI bytes

      var frame = jpegBuffer.slice(start, end);
      jpegBuffer = jpegBuffer.slice(end);

      if (ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({
            image: "data:image/jpeg;base64," + frame.toString("base64")
          }));
        } catch(e) { console.warn("[wine] frame send error: " + e.message); }
      }
    }
  });

  ffmpegVideo.stderr.on("data", function(d) {
    var line = d.toString().trim();
    if (line.includes("Error") || line.includes("error")) console.log("[ffmpeg-video] " + line);
  });
  ffmpegVideo.on("close", function(code) { console.log("[ffmpeg-video] exited code " + code); });
  ffmpegVideo.on("error", function(e) { console.warn("[ffmpeg-video] failed: " + e.message); });

  // ── Step 4: ffmpeg — audio capture (same as existing sessions) ─
  var ffmpegAudio = spawn("ffmpeg", [
    "-f", "pulse",
    "-i", "virtual_speaker.monitor",
    "-c:a", "libopus",
    "-b:a", "64k",
    "-vn",
    "-f", "webm",
    "-cluster_size_limit", "2M",
    "-cluster_time_limit", "100",
    "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  ffmpegAudio.stdout.on("data", function(chunk) {
    if (ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ type: "audio", data: chunk.toString("base64") })); }
    catch(e) { console.warn("[ffmpeg-audio] send error: " + e.message); }
  });
  ffmpegAudio.stderr.on("data", function(d) {
    var line = d.toString().trim();
    if (line.includes("Stream") || line.includes("Error") || line.includes("error")) {
      console.log("[ffmpeg-audio] " + line);
    }
  });
  ffmpegAudio.on("close", function(code) { console.log("[ffmpeg-audio] exited code " + code); });
  ffmpegAudio.on("error", function(e) { console.warn("[ffmpeg-audio] failed: " + e.message); });

  // Store wine session — no browser/page, just processes
  sessions.set(ws, {
    type: "wine",
    wineProc,
    ffmpegVideo,
    ffmpegAudio,
    frameInterval: null, // not used for wine sessions
    wallet,
    romId
  });

  ws.send(JSON.stringify({ type: "status", message: "" }));
  console.log("[wine] session live: " + wallet + " / " + romId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EMULATORJS SESSION — all other ROMs (unchanged)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function createSession(ws, romFile, romCore, romId, wallet) {
  console.log("[session] creating: rom=" + romFile + " core=" + romCore + " wallet=" + wallet);

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: false,
    defaultViewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    ignoreDefaultArgs: ["--mute-audio"],
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--enable-webgl",
      "--enable-webgl2",
      "--ignore-gpu-blocklist",
      "--ignore-gpu-blacklist",
      "--autoplay-policy=no-user-gesture-required",
      "--enable-features=SharedArrayBuffer",
      "--display=:99",
      "--use-fake-ui-for-media-stream"
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });

  await page.evaluateOnNewDocument(function() {
    Object.defineProperty(window, "crossOriginIsolated", { get: function() { return true; } });
    if (typeof SharedArrayBuffer === "undefined") window.SharedArrayBuffer = ArrayBuffer;
  });

  await page.setRequestInterception(true);
  page.on("request", function(req) {
    var url = req.url();
    if (url.includes("cdn.emulatorjs.org") && url.endsWith(".json")) {
      req.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: "{}" });
      return;
    }
    req.continue();
  });

  page.on("console", function(msg) {
    var text = msg.text();
    if (text.includes("Translation not found")) return;
    if (text.includes("Language set to")) return;
    console.log("[browser] " + msg.type() + ": " + text);
  });
  page.on("pageerror", function(err) { console.error("[browser] PAGE ERROR: " + err.message); });

  console.log("[session] showing loading screen: " + LOADING_URL);
  await page.goto(LOADING_URL, { waitUntil: "domcontentloaded", timeout: 10000 });

  var showingLoader = true;
  var loadingInterval = setInterval(async function() {
    if (ws.readyState !== 1) { clearInterval(loadingInterval); return; }
    if (!showingLoader) { clearInterval(loadingInterval); return; }
    try {
      var imageBase64 = await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY, encoding: "base64" });
      if (ws.readyState === 1) ws.send(JSON.stringify({ image: "data:image/jpeg;base64," + imageBase64 }));
    } catch(e) { clearInterval(loadingInterval); }
  }, FRAME_MS);

  await new Promise(function(r) { setTimeout(r, LOADING_SCREEN_MS); });
  showingLoader = false;
  clearInterval(loadingInterval);

  var gameUrl = GAME_BASE_URL
    + "?rom="    + encodeURIComponent(romFile)
    + "&core="   + encodeURIComponent(romCore)
    + "&id="     + encodeURIComponent(romId)
    + "&wallet=" + encodeURIComponent(wallet);

  console.log("[session] navigating to game: " + gameUrl);

  var keepalive = setInterval(function() {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "status", message: "Loading emulator..." }));
  }, 3000);

  await page.goto(gameUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  var canvasFound = false;
  try {
    await page.waitForSelector("canvas", { timeout: 60000 });
    canvasFound = true;
    console.log("[session] canvas found");
  } catch(e) {
    console.warn("[session] canvas not found within 60s");
    try { await page.screenshot({ path: "/tmp/debug-screenshot.jpg", type: "jpeg", quality: 80 }); } catch(se) {}
  }

  clearInterval(keepalive);

  if (!canvasFound) {
    ws.send(JSON.stringify({ type: "error", message: "Emulator failed to load" }));
    await browser.close();
    return;
  }

  await new Promise(function(r) { setTimeout(r, 8000); });

  var allClickable = await page.evaluate(function() {
    var results = [];
    var els = document.querySelectorAll("button, [role='button'], span, div");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var text = (el.innerText || "").trim();
      if (text && text.length < 30) {
        var rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          results.push({ text: text, x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2) });
        }
      }
    }
    return results.slice(0, 30);
  });

  var playEl = allClickable.find(function(el) { return el.text === "Play"; });
  if (playEl) {
    console.log("[session] clicking Play at " + playEl.x + "," + playEl.y);
    await page.mouse.click(playEl.x, playEl.y);
    await new Promise(function(r) { setTimeout(r, 1000); });
  }
  await page.mouse.click(VIEWPORT_W / 2, VIEWPORT_H / 2);
  await new Promise(function(r) { setTimeout(r, 500); });

  var ffmpegProc = null;
  try {
    console.log("[session] starting ffmpeg audio capture from PulseAudio...");
    ffmpegProc = spawn("ffmpeg", [
      "-f", "pulse",
      "-i", "virtual_speaker.monitor",
      "-c:a", "libopus",
      "-b:a", "64k",
      "-vn",
      "-f", "webm",
      "-cluster_size_limit", "2M",
      "-cluster_time_limit", "100",
      "pipe:1"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    ffmpegProc.stdout.on("data", function(chunk) {
      if (ws.readyState !== 1) return;
      try { ws.send(JSON.stringify({ type: "audio", data: chunk.toString("base64") })); }
      catch(e) { console.warn("[ffmpeg] send error: " + e.message); }
    });
    ffmpegProc.stderr.on("data", function(d) {
      var line = d.toString().trim();
      if (line.includes("Stream") || line.includes("Error") || line.includes("error")) {
        console.log("[ffmpeg] " + line);
      }
    });
    ffmpegProc.on("close", function(code) { console.log("[ffmpeg] exited code " + code); });
    ffmpegProc.on("error", function(e) { console.warn("[ffmpeg] failed: " + e.message); });
    console.log("[session] ffmpeg audio capture started");
  } catch(e) {
    console.warn("[session] ffmpeg setup failed: " + e.message);
  }

  var sendingFrame = false;
  var frameInterval = setInterval(async function() {
    if (ws.readyState !== 1) { clearInterval(frameInterval); return; }
    if (sendingFrame) return;
    sendingFrame = true;
    try {
      var canvasEl = await page.$("canvas");
      var imageBase64;
      if (canvasEl) {
        imageBase64 = await canvasEl.screenshot({ type: "jpeg", quality: JPEG_QUALITY, encoding: "base64" });
      } else {
        imageBase64 = await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY, encoding: "base64" });
      }
      ws.send(JSON.stringify({ image: "data:image/jpeg;base64," + imageBase64 }), function(err) {
        sendingFrame = false;
        if (err) console.warn("[session] send error: " + err.message);
      });
    } catch(e) {
      sendingFrame = false;
      console.error("[session] screenshot failed: " + e.message);
      clearInterval(frameInterval);
      destroySession(ws);
    }
  }, FRAME_MS);

  sessions.set(ws, { type: "emulator", browser, page, frameInterval, ffmpegProc, wallet, romId });
  console.log("[session] live: " + wallet + " / " + romId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DESTROY SESSION — handles both types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function destroySession(ws) {
  var session = sessions.get(ws);
  if (!session) return;

  if (session.type === "wine") {
    try { if (session.ffmpegVideo) session.ffmpegVideo.kill("SIGTERM"); } catch(e) {}
    try { if (session.ffmpegAudio) session.ffmpegAudio.kill("SIGTERM"); } catch(e) {}
    try { if (session.wineProc)    session.wineProc.kill("SIGTERM");    } catch(e) {}
  } else {
    clearInterval(session.frameInterval);
    try { if (session.ffmpegProc) session.ffmpegProc.kill("SIGTERM"); } catch(e) {}
    try { await session.browser.close(); } catch(e) {}
  }

  sessions.delete(ws);
  console.log("[session] destroyed: " + session.wallet + " / " + session.romId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEBSOCKET CONNECTION HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
wss.on("connection", async function(ws, req) {
  var url     = new URL(req.url, "http://localhost");
  var romFile = url.searchParams.get("rom")    || "Kaizo Mario (English).sfc";
  var romCore = url.searchParams.get("core")   || "snes";
  var romId   = url.searchParams.get("id")     || url.searchParams.get("rom") || "kaizo-mario-world-1";
  var wallet  = url.searchParams.get("wallet") || "anonymous";

  console.log("[ws] connected: rom=" + romFile + " core=" + romCore + " id=" + romId + " wallet=" + wallet);
  ws.send(JSON.stringify({ type: "status", message: "Launching..." }));

  try {
    // ── Route to Wine session if core=wine ──────────────────────
    if (romCore === "wine") {
      await createWineSession(ws, romId, wallet);
    } else {
      await createSession(ws, romFile, romCore, romId, wallet);
    }
    if (sessions.has(ws)) ws.send(JSON.stringify({ type: "status", message: "" }));
  } catch(e) {
    console.error("[ws] session creation failed: " + e.message);
    ws.send(JSON.stringify({ type: "error", message: "Failed to start: " + e.message }));
    ws.close();
    return;
  }

  ws.on("message", async function(data) {
    var session = sessions.get(ws);
    if (!session) return;
    try {
      var msg = JSON.parse(data);

      // ── Wine input: use xdotool to send keystrokes ────────────
      if (session.type === "wine") {
        var wineKey = WINE_KEY_MAP[msg.key];
        if (!wineKey) return;
        var action = msg.type === "keyDown" ? "keydown" : "keyup";
        spawn("xdotool", [action, "--clearmodifiers", wineKey], {
          env: Object.assign({}, process.env, { DISPLAY: DISPLAY })
        });
        return;
      }

      // ── Emulator input: send via Puppeteer keyboard ───────────
      var key = KEY_MAP[msg.key];
      if (!key) return;
      if (msg.type === "keyDown") await session.page.keyboard.down(key);
      else if (msg.type === "keyUp") await session.page.keyboard.up(key);

    } catch(e) { console.warn("[ws] input error: " + e.message); }
  });

  ws.on("close", function() { console.log("[ws] disconnected: " + wallet); destroySession(ws); });
  ws.on("error", function(e) { console.error("[ws] error: " + e.message); destroySession(ws); });
});

var PORT = process.env.PORT || 8081;
server.listen(PORT, function() {
  console.log("Puppeteer SNES server on port " + PORT);
  console.log("Base game URL:          " + GAME_BASE_URL);
  console.log("Loading URL:            " + LOADING_URL);
  console.log("Loading screen duration:" + LOADING_SCREEN_MS + "ms");
  console.log("Target FPS:             " + TARGET_FPS);
  console.log("JPEG quality:           " + JPEG_QUALITY);
  console.log("Insurgence path:        " + INSURGENCE_PATH);
});
