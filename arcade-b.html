const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const puppeteer = require("puppeteer");
const { spawn } = require("child_process");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const GAME_BASE_URL    = process.env.GAME_URL    || "https://jdunk4.github.io/ARCADE1/game.html";
const LOADING_URL      = process.env.LOADING_URL || "https://jdunk4.github.io/ARCADE1/loading.html";
const VIEWPORT_W       = 512;
const VIEWPORT_H       = 448;
const TARGET_FPS       = 30;
const JPEG_QUALITY     = 85;  // higher quality now that ffmpeg is fast
const LOADING_SCREEN_MS = 20000;

// Single shared Xvfb display — all Chrome instances render here
const DISPLAY = ":99";

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

const KEY_MAP = {
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  a: "z", b: "x", x: "a", y: "s",
  start: "Enter", select: "Shift", l: "q", r: "w"
};

const sessions = new Map();

async function createSession(ws, romFile, romCore, romId, wallet) {
  console.log("[session] creating: rom=" + romFile + " core=" + romCore + " wallet=" + wallet);

  // ── Launch Chrome on the shared Xvfb display ──────────────────
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
      "--display=" + DISPLAY,
      "--use-fake-ui-for-media-stream",
      "--window-size=" + VIEWPORT_W + "," + VIEWPORT_H,
      "--window-position=0,0"
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });

  // ── Set up handlers before any navigation ─────────────────────
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

  // ── Step 1: Show loading screen ───────────────────────────────
  console.log("[session] showing loading screen: " + LOADING_URL);
  await page.goto(LOADING_URL, { waitUntil: "domcontentloaded", timeout: 10000 });

  // Stream loading screen via ffmpeg grabbing Xvfb
  var loadingFfmpeg = startVideoStream(ws, DISPLAY, VIEWPORT_W, VIEWPORT_H, TARGET_FPS, JPEG_QUALITY, "loading");
  await new Promise(function(r) { setTimeout(r, LOADING_SCREEN_MS); });

  // Stop loading stream
  try { loadingFfmpeg.kill("SIGTERM"); } catch(e) {}

  // ── Step 2: Navigate to game ──────────────────────────────────
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

  // ── Step 3: Wait for emulator canvas ─────────────────────────
  var canvasFound = false;
  try {
    await page.waitForSelector("canvas", { timeout: 60000 });
    canvasFound = true;
    console.log("[session] canvas found");
  } catch(e) {
    console.warn("[session] canvas not found within 60s");
  }

  clearInterval(keepalive);

  if (!canvasFound) {
    ws.send(JSON.stringify({ type: "error", message: "Emulator failed to load" }));
    await browser.close();
    return;
  }

  // ── Step 4: Click Play and focus ─────────────────────────────
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

  // ── Step 5: Start ffmpeg video stream from Xvfb ───────────────
  // This replaces the slow Puppeteer screenshot loop entirely
  // ffmpeg grabs directly from the X display — much lower latency
  console.log("[session] starting ffmpeg video capture from Xvfb...");
  var videoFfmpeg = startVideoStream(ws, DISPLAY, VIEWPORT_W, VIEWPORT_H, TARGET_FPS, JPEG_QUALITY, "game");

  // ── Step 6: Audio capture ─────────────────────────────────────
  var ffmpegAudio = null;
  try {
    console.log("[session] starting ffmpeg audio capture from PulseAudio...");
    ffmpegAudio = spawn("ffmpeg", [
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

    console.log("[session] ffmpeg audio capture started");
  } catch(e) {
    console.warn("[session] ffmpeg audio setup failed: " + e.message);
  }

  sessions.set(ws, { browser, page, videoFfmpeg, ffmpegAudio, wallet, romId });
  console.log("[session] live: " + wallet + " / " + romId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FFMPEG VIDEO STREAM
// Grabs Xvfb display directly — no Puppeteer screenshot overhead
// Sends JPEG frames over WebSocket at TARGET_FPS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startVideoStream(ws, display, w, h, fps, quality, label) {
  var ffmpeg = spawn("ffmpeg", [
    "-f",          "x11grab",
    "-video_size", w + "x" + h,
    "-framerate",  String(fps),
    "-i",          display + ".0+0,0",   // grab top-left corner of display
    "-vf",         "fps=" + fps,
    "-vcodec",     "mjpeg",
    "-q:v",        String(Math.round(31 - (quality / 100) * 30)), // ffmpeg quality scale (2=best, 31=worst)
    "-f",          "image2pipe",
    "-vframes",    "999999",
    "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  var buf = Buffer.alloc(0);

  ffmpeg.stdout.on("data", function(chunk) {
    if (ws.readyState !== 1) return;

    buf = Buffer.concat([buf, chunk]);

    // JPEG starts with FFD8 and ends with FFD9
    var start = -1;
    for (var i = 0; i < buf.length - 1; i++) {
      if (buf[i] === 0xFF && buf[i+1] === 0xD8) { start = i; break; }
    }
    if (start === -1) return;

    var end = -1;
    for (var j = buf.length - 1; j > start; j--) {
      if (buf[j-1] === 0xFF && buf[j] === 0xD9) { end = j; break; }
    }
    if (end === -1) return;

    var frame = buf.slice(start, end + 1);
    buf = buf.slice(end + 1);

    try {
      ws.send(JSON.stringify({ image: "data:image/jpeg;base64," + frame.toString("base64") }));
    } catch(e) {}
  });

  ffmpeg.stderr.on("data", function(d) {
    var line = d.toString().trim();
    if (line.includes("Error") || line.includes("error")) {
      console.log("[ffmpeg-" + label + "] " + line);
    }
  });

  ffmpeg.on("exit", function(code) {
    console.log("[ffmpeg-" + label + "] exited code " + code);
  });

  ffmpeg.on("error", function(e) {
    console.warn("[ffmpeg-" + label + "] failed to start: " + e.message);
  });

  console.log("[ffmpeg-" + label + "] started: " + fps + "fps from " + display);
  return ffmpeg;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DESTROY SESSION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function destroySession(ws) {
  var session = sessions.get(ws);
  if (!session) return;

  const kill = function(proc, name) {
    if (proc && !proc.killed) {
      try { proc.kill("SIGTERM"); } catch(e) {}
      console.log("[session] killed " + name);
    }
  };

  kill(session.videoFfmpeg, "videoFfmpeg");
  kill(session.ffmpegAudio, "ffmpegAudio");
  try { await session.browser.close(); } catch(e) {}
  sessions.delete(ws);
  console.log("[session] destroyed: " + session.wallet + " / " + session.romId);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEBSOCKET
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

wss.on("connection", async function(ws, req) {
  var url     = new URL(req.url, "http://localhost");
  var romFile = url.searchParams.get("rom")    || "Kaizo Mario (English).sfc";
  var romCore = url.searchParams.get("core")   || "snes";
  var romId   = url.searchParams.get("id")     || url.searchParams.get("rom") || "kaizo-mario-world-1";
  var wallet  = url.searchParams.get("wallet") || "anonymous";

  console.log("[ws] connected: rom=" + romFile + " core=" + romCore + " id=" + romId + " wallet=" + wallet);
  ws.send(JSON.stringify({ type: "status", message: "Launching emulator..." }));

  try {
    await createSession(ws, romFile, romCore, romId, wallet);
    if (sessions.has(ws)) ws.send(JSON.stringify({ type: "status", message: "Emulator running!" }));
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
      var key = KEY_MAP[msg.key];
      if (!key) return;
      if (msg.type === "keyDown") await session.page.keyboard.down(key);
      else if (msg.type === "keyUp") await session.page.keyboard.up(key);
    } catch(e) { console.warn("[ws] input error: " + e.message); }
  });

  ws.on("close", function() { console.log("[ws] disconnected: " + wallet); destroySession(ws); });
  ws.on("error", function(e) { console.error("[ws] error: " + e.message); destroySession(ws); });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// START
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

var PORT = process.env.PORT || 8081;
server.listen(PORT, function() {
  console.log("Puppeteer SNES server on port " + PORT);
  console.log("Base game URL:           " + GAME_BASE_URL);
  console.log("Loading URL:             " + LOADING_URL);
  console.log("Loading screen duration: " + LOADING_SCREEN_MS + "ms");
  console.log("Target FPS:              " + TARGET_FPS);
  console.log("JPEG quality:            " + JPEG_QUALITY);
  console.log("Video capture:           ffmpeg x11grab from " + DISPLAY);
});
