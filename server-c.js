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

app.get("/debug-display.jpg", function(req, res) {
  var execSync = require("child_process").execSync;
  try {
    execSync("ffmpeg -y -f x11grab -r 1 -s 1024x768 -i :99.0+0,0 -vframes 1 /tmp/debug-display.jpg 2>/dev/null || true");
    var p = "/tmp/debug-display.jpg";
    if (fs.existsSync(p)) {
      res.setHeader("Content-Type", "image/jpeg");
      res.sendFile(p);
    } else {
      res.status(404).send("No display screenshot");
    }
  } catch(e) { res.status(500).send("Error: " + e.message); }
});

// Serve mml-screen.html as a static HTML file
// Railway's Networked DOM server picks this up via the websocket handler below
app.get("/mml-screen.html", function(req, res) {
  res.setHeader("Content-Type", "text/html");
  res.sendFile("/app/mml-screen.html");
});

// Serve last broadcast frame as JPEG
// Two alternating endpoints /frame-a and /frame-b
// MML script switches between them so URL always changes
// but stays a valid https:// URL (no blob/base64 issues)
var frameCounter = new Map(); // channelId -> counter

function serveFrame(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  var channelId = req.params.channelId;
  var lastFrame = broadcastLastFrame.get(channelId);
  if (!lastFrame) return res.status(404).send("No frame yet");
  try {
    var parsed = JSON.parse(lastFrame);
    var base64 = parsed.image.replace("data:image/jpeg;base64,", "");
    var buf = Buffer.from(base64, "base64");
    res.setHeader("Content-Type", "image/jpeg");
    res.send(buf);
  } catch(e) { res.status(500).send("Error: " + e.message); }
}

app.get("/last-frame/:channelId", serveFrame);
app.get("/frame-a/:channelId", serveFrame);
app.get("/frame-b/:channelId", serveFrame);


const KEY_MAP = {
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  a: "z", b: "x", x: "a", y: "s",
  start: "Enter", select: "Shift", l: "q", r: "w"
};

const WINE_KEY_MAP = {
  up: "Up", down: "Down", left: "Left", right: "Right",
  a: "z", b: "x", x: "a", y: "s",
  start: "Return", select: "Shift_L", l: "q", r: "w"
};

const sessions = new Map();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BROADCAST RELAY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const broadcastViewers = new Map();  // channelId → Set<ws>
const broadcastSenders = new Map();  // channelId → ws
const broadcastLastFrame = new Map(); // channelId → last frame data string ← NEW

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WINE SESSION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function createWineSession(ws, romId, wallet) {
  console.log("[wine] creating session: id=" + romId + " wallet=" + wallet);

  try { require("child_process").execSync("pkill -f 'Game.exe' 2>/dev/null || true"); } catch(e) {}
  try { require("child_process").execSync("pkill -f 'x11grab' 2>/dev/null || true"); } catch(e) {}
  await new Promise(function(r) { setTimeout(r, 500); });

  ws.send(JSON.stringify({ type: "status", message: "Starting Pokemon Insurgence..." }));

  var wineProc = null;
  try {
    wineProc = spawn("wine", [INSURGENCE_PATH], {
      env: Object.assign({}, process.env, { DISPLAY: DISPLAY, WINEDEBUG: "-all" }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    wineProc.stdout.on("data", function(d) { console.log("[wine] " + d.toString().trim()); });
    wineProc.stderr.on("data", function(d) {
      var line = d.toString().trim();
      if (line.includes("err:") || line.includes("fixme:")) return;
      if (line.length > 0) console.log("[wine] " + line);
    });
    wineProc.on("close", function(code) { console.log("[wine] exited " + code); destroySession(ws); });
    wineProc.on("error", function(e) {
      ws.send(JSON.stringify({ type: "error", message: "Wine failed: " + e.message }));
    });
  } catch(e) {
    ws.send(JSON.stringify({ type: "error", message: "Could not launch Wine: " + e.message }));
    ws.close();
    return;
  }

  await new Promise(function(r) { setTimeout(r, 8000); });
  ws.send(JSON.stringify({ type: "status", message: "Loading game..." }));

  var ffmpegVideo = spawn("ffmpeg", [
    "-f", "x11grab", "-r", String(TARGET_FPS), "-s", "544x416",
    "-i", DISPLAY + ".0+175,145",
    "-vf", "scale=" + VIEWPORT_W + ":" + VIEWPORT_H,
    "-c:v", "mjpeg", "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  var jpegBuffer = Buffer.alloc(0);
  var SOI = Buffer.from([0xFF, 0xD8]);
  var EOI = Buffer.from([0xFF, 0xD9]);

  ffmpegVideo.stdout.on("data", function(chunk) {
    jpegBuffer = Buffer.concat([jpegBuffer, chunk]);
    while (true) {
      var start = jpegBuffer.indexOf(SOI);
      if (start === -1) { jpegBuffer = Buffer.alloc(0); break; }
      var end = jpegBuffer.indexOf(EOI, start + 2);
      if (end === -1) break;
      end += 2;
      var frame = jpegBuffer.slice(start, end);
      jpegBuffer = jpegBuffer.slice(end);
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ image: "data:image/jpeg;base64," + frame.toString("base64") })); }
        catch(e) {}
      }
    }
  });

  ffmpegVideo.on("close", function(code) { console.log("[ffmpeg-video] exited " + code); });
  ffmpegVideo.on("error", function(e) { console.warn("[ffmpeg-video] failed: " + e.message); });

  sessions.set(ws, { type: "wine", wineProc, ffmpegVideo, ffmpegAudio: null, frameInterval: null, wallet, romId });
  ws.send(JSON.stringify({ type: "status", message: "" }));
  console.log("[wine] session live: " + wallet + " / " + romId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EMULATOR SESSION (Puppeteer)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function createSession(ws, romFile, romCore, romId, wallet) {
  var gameUrl = GAME_BASE_URL +
    "?rom=" + encodeURIComponent(romFile) +
    "&core=" + encodeURIComponent(romCore) +
    "&id=" + encodeURIComponent(romId) +
    "&wallet=" + encodeURIComponent(wallet);

  console.log("[session] launching: " + gameUrl);
  ws.send(JSON.stringify({ type: "status", message: "Launching emulator..." }));

  var browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"]
  });

  var page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });

  var keepalive = setInterval(function() {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "status", message: "Loading emulator..." }));
  }, 3000);

  await page.goto(gameUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  var canvasFound = false;
  try {
    await page.waitForSelector("canvas", { timeout: 60000 });
    canvasFound = true;
  } catch(e) {
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
    await page.mouse.click(playEl.x, playEl.y);
    await new Promise(function(r) { setTimeout(r, 1000); });
  }
  await page.mouse.click(VIEWPORT_W / 2, VIEWPORT_H / 2);
  await new Promise(function(r) { setTimeout(r, 500); });

  var ffmpegProc = null;
  try {
    ffmpegProc = spawn("ffmpeg", [
      "-f", "pulse", "-i", "virtual_speaker.monitor",
      "-c:a", "libopus", "-b:a", "64k", "-vn", "-f", "webm",
      "-cluster_size_limit", "2M", "-cluster_time_limit", "100", "pipe:1"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    ffmpegProc.stdout.on("data", function(chunk) {
      if (ws.readyState !== 1) return;
      try { ws.send(JSON.stringify({ type: "audio", data: chunk.toString("base64") })); } catch(e) {}
    });
    ffmpegProc.on("close", function(code) { console.log("[ffmpeg] exited " + code); });
    ffmpegProc.on("error", function(e) { console.warn("[ffmpeg] failed: " + e.message); });
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
      });
    } catch(e) {
      sendingFrame = false;
      clearInterval(frameInterval);
      destroySession(ws);
    }
  }, FRAME_MS);

  sessions.set(ws, { type: "emulator", browser, page, frameInterval, ffmpegProc, wallet, romId });
  console.log("[session] live: " + wallet + " / " + romId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DESTROY SESSION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function destroySession(ws) {
  var session = sessions.get(ws);
  if (!session) return;
  if (session.type === "wine") {
    try { if (session.ffmpegVideo) session.ffmpegVideo.kill("SIGKILL"); } catch(e) {}
    try { if (session.wineProc) session.wineProc.kill("SIGKILL"); } catch(e) {}
    try { require("child_process").execSync("pkill -9 -f x11grab 2>/dev/null || true"); } catch(e) {}
    try { require("child_process").execSync("pkill -9 -f Game.exe 2>/dev/null || true"); } catch(e) {}
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
  var url       = new URL(req.url, "http://localhost");
  var mode      = url.searchParams.get("mode")    || "player";
  var romFile   = url.searchParams.get("rom")     || "Kaizo Mario (English).sfc";
  var romCore   = url.searchParams.get("core")    || "snes";
  var romId     = url.searchParams.get("id")      || romFile;
  var wallet    = url.searchParams.get("wallet")  || "anonymous";
  var channelId = url.searchParams.get("channel") || romId;

  console.log("[ws] connected: mode=" + mode + " channel=" + channelId);

  // ── BROADCAST MODE ─────────────────────────────────────────────
  if (mode === "broadcast") {
    var oldSender = broadcastSenders.get(channelId);
    if (oldSender && oldSender.readyState === 1) {
      try { oldSender.close(); } catch(e) {}
    }
    broadcastSenders.set(channelId, ws);
    if (!broadcastViewers.has(channelId)) broadcastViewers.set(channelId, new Set());

    // Clear stale frame so viewers get fresh frames immediately on reconnect
    broadcastLastFrame.delete(channelId);

    var viewerCount = broadcastViewers.get(channelId).size;
    ws.send(JSON.stringify({ type: "status", message: "Broadcasting on channel: " + channelId + " (" + viewerCount + " viewers)" }));
    console.log("[broadcast] broadcaster connected on channel: " + channelId);

    ws.on("message", function(data) {
      // Always convert to string — broadcaster sends Buffer (binary)
      // but viewers need UTF-8 text for JSON.parse to work
      var dataStr = data.toString();

      // Cache the last frame so new viewers get it immediately on connect
      try {
        var parsed = JSON.parse(dataStr);
        if (parsed.image) {
          broadcastLastFrame.set(channelId, dataStr);
        }
      } catch(e) {}

      // Forward to all current viewers as string
      var viewers = broadcastViewers.get(channelId);
      if (!viewers || viewers.size === 0) return;
      viewers.forEach(function(viewerWs) {
        if (viewerWs.readyState === 1) {
          try { viewerWs.send(dataStr); } catch(e) {}
        }
      });
    });

    ws.on("close", function() {
      broadcastSenders.delete(channelId);
      broadcastLastFrame.delete(channelId);
      var viewers = broadcastViewers.get(channelId);
      if (viewers) {
        viewers.forEach(function(viewerWs) {
          if (viewerWs.readyState === 1) {
            try { viewerWs.send(JSON.stringify({ type: "status", message: "Stream ended" })); } catch(e) {}
          }
        });
      }
      console.log("[broadcast] broadcaster disconnected from channel: " + channelId);
    });

    ws.on("error", function(e) { console.error("[broadcast] error: " + e.message); });
    return;
  }

  // ── VIEW MODE ───────────────────────────────────────────────────
  if (mode === "view") {
    if (!broadcastViewers.has(channelId)) broadcastViewers.set(channelId, new Set());
    broadcastViewers.get(channelId).add(ws);

    var broadcaster = broadcastSenders.get(channelId);
    if (broadcaster && broadcaster.readyState === 1) {
      ws.send(JSON.stringify({ type: "status", message: "Connected to live stream" }));
      // Send last cached frame immediately so viewer sees something right away
      var lastFrame = broadcastLastFrame.get(channelId);
      if (lastFrame) {
        try { ws.send(lastFrame); } catch(e) {}
      }
      // Update broadcaster with new viewer count
      try { broadcaster.send(JSON.stringify({ type: "viewerCount", count: broadcastViewers.get(channelId).size })); } catch(e) {}
    } else {
      ws.send(JSON.stringify({ type: "status", message: "Waiting for broadcaster..." }));
    }

    console.log("[view] viewer connected to channel: " + channelId + " (" + broadcastViewers.get(channelId).size + " total viewers)");

    ws.on("close", function() {
      var viewers = broadcastViewers.get(channelId);
      if (viewers) {
        viewers.delete(ws);
        var bc = broadcastSenders.get(channelId);
        if (bc && bc.readyState === 1) {
          try { bc.send(JSON.stringify({ type: "viewerCount", count: viewers.size })); } catch(e) {}
        }
      }
      console.log("[view] viewer disconnected from channel: " + channelId);
    });

    ws.on("error", function(e) { console.error("[view] error: " + e.message); });
    return;
  }

  // ── PLAYER MODE (existing emulator/wine sessions) ───────────────
  ws.send(JSON.stringify({ type: "status", message: "Launching..." }));

  try {
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
      if (session.type === "wine") {
        var wineKey = WINE_KEY_MAP[msg.key];
        if (!wineKey) return;
        spawn("xdotool", [msg.type === "keyDown" ? "keydown" : "keyup", "--clearmodifiers", wineKey], {
          env: Object.assign({}, process.env, { DISPLAY: DISPLAY })
        });
        return;
      }
      var key = KEY_MAP[msg.key];
      if (!key) return;
      if (msg.type === "keyDown") await session.page.keyboard.down(key);
      else if (msg.type === "keyUp") await session.page.keyboard.up(key);
    } catch(e) {}
  });

  ws.on("close", function() { destroySession(ws); });
  ws.on("error", function(e) { console.error("[ws] error: " + e.message); destroySession(ws); });
});

var PORT = process.env.PORT || 8081;
server.listen(PORT, function() {
  console.log("Puppeteer SNES server on port " + PORT);
  console.log("Target FPS: " + TARGET_FPS);
  console.log("JPEG quality: " + JPEG_QUALITY);
});
