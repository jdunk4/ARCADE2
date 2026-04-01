const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const puppeteer = require("puppeteer");
const { spawn } = require("child_process");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const GAME_URL = process.env.GAME_URL || "https://jdunk4.github.io/ARCADE1/game.html";
const TARGET_FPS = 20;
const FRAME_MS = 1000 / TARGET_FPS;
const VIEWPORT_W = 512;
const VIEWPORT_H = 448;

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

async function createSession(ws, romId, wallet) {
  console.log("[session] creating: rom=" + romId + " wallet=" + wallet);

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

  var gameUrl = GAME_URL + "?wallet=" + encodeURIComponent(wallet) + "&rom=" + encodeURIComponent(romId);
  console.log("[session] navigating to: " + gameUrl);
  await page.goto(gameUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  var webglStatus = await page.evaluate(function() {
    var canvas = document.createElement("canvas");
    var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return "WebGL NOT available";
    return "WebGL OK: " + gl.getParameter(gl.VERSION);
  });
  console.log("[session] WebGL check: " + webglStatus);

  var keepalive = setInterval(function() {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "status", message: "Loading emulator..." }));
  }, 3000);

  var canvasFound = false;
  try {
    await page.waitForSelector("canvas", { timeout: 60000 });
    canvasFound = true;
    console.log("[session] canvas found");
  } catch (e) {
    console.warn("[session] canvas not found within 60s");
    try { await page.screenshot({ path: "/tmp/debug-screenshot.jpg", type: "jpeg", quality: 80 }); } catch (se) {}
  }

  clearInterval(keepalive);

  if (!canvasFound) {
    ws.send(JSON.stringify({ type: "error", message: "Emulator failed to load" }));
    await browser.close();
    return;
  }

  // Wait for emulator to settle then find and click Play
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

  // ── Capture audio from PulseAudio via ffmpeg ──────────────────────────
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
      try {
        ws.send(JSON.stringify({ type: "audio", data: chunk.toString("base64") }));
      } catch (e) {
        console.warn("[ffmpeg] send error: " + e.message);
      }
    });

    // Log ALL ffmpeg output so we can see exactly what's happening
    ffmpegProc.stderr.on("data", function(d) {
      console.log("[ffmpeg] " + d.toString().trim());
    });

    ffmpegProc.on("close", function(code) {
      console.log("[ffmpeg] process exited with code " + code);
    });

    ffmpegProc.on("error", function(e) {
      console.warn("[ffmpeg] failed to start: " + e.message);
    });

    console.log("[session] ffmpeg audio capture started");

  } catch (e) {
    console.warn("[session] ffmpeg audio setup failed: " + e.message);
  }

  // ── Video frame loop ──────────────────────────────────────────────────
  console.log("[session] starting frame loop at " + TARGET_FPS + "fps");

  var frameInterval = setInterval(async function() {
    if (ws.readyState !== 1) { clearInterval(frameInterval); return; }
    try {
      var canvasEl = await page.$("canvas");
      var imageBase64;
      if (canvasEl) {
        imageBase64 = await canvasEl.screenshot({ type: "jpeg", quality: 70, encoding: "base64" });
      } else {
        imageBase64 = await page.screenshot({ type: "jpeg", quality: 70, encoding: "base64" });
      }
      ws.send(JSON.stringify({ image: "data:image/jpeg;base64," + imageBase64 }), function(err) {
        if (err) console.warn("[session] send error: " + err.message);
      });
    } catch (e) {
      console.error("[session] screenshot failed: " + e.message);
      clearInterval(frameInterval);
      destroySession(ws);
    }
  }, FRAME_MS);

  sessions.set(ws, { browser, page, frameInterval, ffmpegProc, wallet, romId });
  console.log("[session] live: " + wallet + " / " + romId);
}

async function destroySession(ws) {
  var session = sessions.get(ws);
  if (!session) return;
  clearInterval(session.frameInterval);
  if (session.ffmpegProc) {
    try { session.ffmpegProc.kill("SIGTERM"); } catch (e) {}
  }
  try { await session.browser.close(); } catch (e) {}
  sessions.delete(ws);
  console.log("[session] destroyed: " + session.wallet + " / " + session.romId);
}

wss.on("connection", async function(ws, req) {
  var url = new URL(req.url, "http://localhost");
  var romId = url.searchParams.get("rom") || "kaizo-mario-world-1";
  var wallet = url.searchParams.get("wallet") || "anonymous";

  console.log("[ws] connected: rom=" + romId + " wallet=" + wallet);
  ws.send(JSON.stringify({ type: "status", message: "Launching emulator..." }));

  try {
    await createSession(ws, romId, wallet);
    if (sessions.has(ws)) ws.send(JSON.stringify({ type: "status", message: "Emulator running!" }));
  } catch (e) {
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
    } catch (e) { console.warn("[ws] input error: " + e.message); }
  });

  ws.on("close", function() { console.log("[ws] disconnected: " + wallet); destroySession(ws); });
  ws.on("error", function(e) { console.error("[ws] error: " + e.message); destroySession(ws); });
});

var PORT = process.env.PORT || 8081;
server.listen(PORT, function() {
  console.log("Puppeteer SNES server on port " + PORT);
  console.log("Streaming: " + TARGET_FPS + "fps JPEG from " + GAME_URL);
});
