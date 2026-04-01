const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const puppeteer = require("puppeteer");
const { spawn } = require("child_process");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const GAME_BASE_URL = process.env.GAME_URL    || "https://jdunk4.github.io/ARCADE1/game.html";
const LOADING_URL   = process.env.LOADING_URL || "https://jdunk4.github.io/ARCADE1/loading.html";
const TARGET_FPS    = 20;
const FRAME_MS      = 1000 / TARGET_FPS;
const VIEWPORT_W    = 512;
const VIEWPORT_H    = 448;

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

  // ── Page 1: Loading screen (streams immediately) ──────────────
  const loadingPage = await browser.newPage();
  await loadingPage.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });
  console.log("[session] loading screen page opening: " + LOADING_URL);
  await loadingPage.goto(LOADING_URL, { waitUntil: "domcontentloaded", timeout: 10000 });
  console.log("[session] loading screen ready — streaming starts now");

  // Stream loading page at full framerate
  var streamingLoadingScreen = true;
  var loadingInterval = setInterval(async function() {
    if (ws.readyState !== 1) { clearInterval(loadingInterval); return; }
    if (!streamingLoadingScreen) { clearInterval(loadingInterval); return; }
    try {
      var imageBase64 = await loadingPage.screenshot({ type: "jpeg", quality: 70, encoding: "base64" });
      ws.send(JSON.stringify({ image: "data:image/jpeg;base64," + imageBase64 }));
    } catch(e) {}
  }, FRAME_MS);

  // ── Page 2: Game page (loads in background) ───────────────────
  const gamePage = await browser.newPage();
  await gamePage.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });

  await gamePage.evaluateOnNewDocument(function() {
    Object.defineProperty(window, "crossOriginIsolated", { get: function() { return true; } });
    if (typeof SharedArrayBuffer === "undefined") window.SharedArrayBuffer = ArrayBuffer;
  });

  await gamePage.setRequestInterception(true);
  gamePage.on("request", function(req) {
    var url = req.url();
    if (url.includes("cdn.emulatorjs.org") && url.endsWith(".json")) {
      req.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: "{}" });
      return;
    }
    req.continue();
  });

  gamePage.on("console", function(msg) {
    var text = msg.text();
    if (text.includes("Translation not found")) return;
    if (text.includes("Language set to")) return;
    console.log("[browser] " + msg.type() + ": " + text);
  });
  gamePage.on("pageerror", function(err) { console.error("[browser] PAGE ERROR: " + err.message); });

  var gameUrl = GAME_BASE_URL
    + "?rom="    + encodeURIComponent(romFile)
    + "&core="   + encodeURIComponent(romCore)
    + "&id="     + encodeURIComponent(romId)
    + "&wallet=" + encodeURIComponent(wallet);

  console.log("[session] loading game in background: " + gameUrl);
  await gamePage.goto(gameUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  // ── Wait for game canvas ──────────────────────────────────────
  var canvasFound = false;
  try {
    await gamePage.waitForSelector("canvas", { timeout: 60000 });
    canvasFound = true;
    console.log("[session] canvas found — switching to game stream");
  } catch(e) {
    console.warn("[session] canvas not found within 60s");
    try { await gamePage.screenshot({ path: "/tmp/debug-screenshot.jpg", type: "jpeg", quality: 80 }); } catch(se) {}
  }

  // Stop loading screen stream and close loading page
  streamingLoadingScreen = false;
  clearInterval(loadingInterval);
  try { await loadingPage.close(); } catch(e) {}

  if (!canvasFound) {
    ws.send(JSON.stringify({ type: "error", message: "Emulator failed to load" }));
    await browser.close();
    return;
  }

  // ── Click Play and focus ──────────────────────────────────────
  await new Promise(function(r) { setTimeout(r, 8000); });

  var allClickable = await gamePage.evaluate(function() {
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
    await gamePage.mouse.click(playEl.x, playEl.y);
    await new Promise(function(r) { setTimeout(r, 1000); });
  }
  await gamePage.mouse.click(VIEWPORT_W / 2, VIEWPORT_H / 2);
  await new Promise(function(r) { setTimeout(r, 500); });

  // ── Audio capture ─────────────────────────────────────────────
  var ffmpegProc = null;
  try {
    console.log("[session] starting ffmpeg audio capture...");
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

  } catch(e) {
    console.warn("[session] ffmpeg setup failed: " + e.message);
  }

  // ── Game frame loop ───────────────────────────────────────────
  console.log("[session] starting game frame loop at " + TARGET_FPS + "fps");

  var frameInterval = setInterval(async function() {
    if (ws.readyState !== 1) { clearInterval(frameInterval); return; }
    try {
      var canvasEl = await gamePage.$("canvas");
      var imageBase64;
      if (canvasEl) {
        imageBase64 = await canvasEl.screenshot({ type: "jpeg", quality: 70, encoding: "base64" });
      } else {
        imageBase64 = await gamePage.screenshot({ type: "jpeg", quality: 70, encoding: "base64" });
      }
      ws.send(JSON.stringify({ image: "data:image/jpeg;base64," + imageBase64 }), function(err) {
        if (err) console.warn("[session] send error: " + err.message);
      });
    } catch(e) {
      console.error("[session] screenshot failed: " + e.message);
      clearInterval(frameInterval);
      destroySession(ws);
    }
  }, FRAME_MS);

  sessions.set(ws, { browser, page: gamePage, frameInterval, ffmpegProc, wallet, romId });
  console.log("[session] live: " + wallet + " / " + romId);
}

async function destroySession(ws) {
  var session = sessions.get(ws);
  if (!session) return;
  clearInterval(session.frameInterval);
  if (session.ffmpegProc) {
    try { session.ffmpegProc.kill("SIGTERM"); } catch(e) {}
  }
  try { await session.browser.close(); } catch(e) {}
  sessions.delete(ws);
  console.log("[session] destroyed: " + session.wallet + " / " + session.romId);
}

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
  console.log("Base game URL: " + GAME_BASE_URL);
  console.log("Loading URL:   " + LOADING_URL);
  console.log("Streaming: " + TARGET_FPS + "fps JPEG");
});
