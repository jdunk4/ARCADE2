const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const puppeteer = require("puppeteer");
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
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  a: "z",
  b: "x",
  x: "a",
  y: "s",
  start: "Enter",
  select: "Shift",
  l: "q",
  r: "w"
};

const sessions = new Map();

async function createSession(ws, romId, wallet) {
  console.log("[session] creating: rom=" + romId + " wallet=" + wallet);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
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
      "--display=:99"
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });

  await page.evaluateOnNewDocument(function() {
    Object.defineProperty(window, "crossOriginIsolated", {
      get: function() { return true; }
    });
    if (typeof SharedArrayBuffer === "undefined") {
      window.SharedArrayBuffer = ArrayBuffer;
    }
  });

  await page.setRequestInterception(true);
  page.on("request", function(req) {
    var url = req.url();
    if (url.includes("cdn.emulatorjs.org") && url.endsWith(".json")) {
      req.respond({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: "{}"
      });
      return;
    }
    req.continue();
  });

  // Suppress translation noise, only log meaningful messages
  page.on("console", function(msg) {
    var text = msg.text();
    if (text.includes("Translation not found")) return;
    if (text.includes("Language set to")) return;
    console.log("[browser] " + msg.type() + ": " + text);
  });
  page.on("pageerror", function(err) {
    console.error("[browser] PAGE ERROR: " + err.message);
  });
  page.on("requestfailed", function(req) {
    var failure = req.failure();
    console.error("[browser] REQUEST FAILED: " + req.url() + " - " + (failure ? failure.errorText : "unknown"));
  });

  var gameUrl = GAME_URL + "?wallet=" + encodeURIComponent(wallet) + "&rom=" + encodeURIComponent(romId);
  console.log("[session] navigating to: " + gameUrl);

  await page.goto(gameUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Check WebGL status immediately after page load
  var webglStatus = await page.evaluate(function() {
    var canvas = document.createElement("canvas");
    var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return "WebGL NOT available";
    return "WebGL OK: " + gl.getParameter(gl.VERSION);
  });
  console.log("[session] WebGL check: " + webglStatus);

  var keepalive = setInterval(function() {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "status", message: "Loading emulator..." }));
    }
  }, 3000);

  var canvasFound = false;
  try {
    await page.waitForSelector("canvas", { timeout: 60000 });
    canvasFound = true;
    console.log("[session] canvas found - emulator loaded");
  } catch (e) {
    console.warn("[session] canvas not found within 60s - taking diagnostic screenshot");
    try {
      await page.screenshot({ path: "/tmp/debug-screenshot.jpg", type: "jpeg", quality: 80 });
      console.log("[session] screenshot saved - visit /debug-screenshot.jpg");
    } catch (se) {
      console.warn("[session] screenshot failed: " + se.message);
    }
    var elements = await page.evaluate(function() {
      return {
        hasCanvas: document.querySelectorAll("canvas").length,
        hasGame: document.getElementById("game") !== null,
        bodyText: document.body.innerText.substring(0, 300),
        iframes: document.querySelectorAll("iframe").length
      };
    });
    console.log("[session] page state: " + JSON.stringify(elements));
  }

  clearInterval(keepalive);

  if (!canvasFound) {
    ws.send(JSON.stringify({ type: "error", message: "Emulator failed to load" }));
    await browser.close();
    return;
  }

  await page.click("canvas").catch(function() {
    console.warn("[session] canvas click failed");
  });

  await new Promise(function(r) { setTimeout(r, 1000); });

  console.log("[session] starting frame loop at " + TARGET_FPS + "fps");

  var frameInterval = setInterval(async function() {
    if (ws.readyState !== 1) {
      clearInterval(frameInterval);
      return;
    }
    try {
      var canvasEl = await page.$("canvas");
      var imageBase64;
      if (canvasEl) {
        imageBase64 = await canvasEl.screenshot({
          type: "jpeg",
          quality: 65,
          encoding: "base64"
        });
      } else {
        imageBase64 = await page.screenshot({
          type: "jpeg",
          quality: 65,
          encoding: "base64"
        });
      }
      var dataUri = "data:image/jpeg;base64," + imageBase64;
      ws.send(JSON.stringify({ image: dataUri }), function(err) {
        if (err) console.warn("[session] send error: " + err.message);
      });
    } catch (e) {
      console.error("[session] screenshot failed: " + e.message);
      clearInterval(frameInterval);
      destroySession(ws);
    }
  }, FRAME_MS);

  var session = { browser: browser, page: page, frameInterval: frameInterval, wallet: wallet, romId: romId };
  sessions.set(ws, session);
  console.log("[session] live: " + wallet + " / " + romId);
}

async function destroySession(ws) {
  var session = sessions.get(ws);
  if (!session) return;
  clearInterval(session.frameInterval);
  try {
    await session.browser.close();
  } catch (e) {
    console.warn("[session] browser close error: " + e.message);
  }
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
    if (sessions.has(ws)) {
      ws.send(JSON.stringify({ type: "status", message: "Emulator running!" }));
    }
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
      if (msg.type === "keyDown") {
        await session.page.keyboard.down(key);
      } else if (msg.type === "keyUp") {
        await session.page.keyboard.up(key);
      }
    } catch (e) {
      console.warn("[ws] input error: " + e.message);
    }
  });

  ws.on("close", function() {
    console.log("[ws] disconnected: " + wallet);
    destroySession(ws);
  });

  ws.on("error", function(e) {
    console.error("[ws] error: " + e.message);
    destroySession(ws);
  });
});

var PORT = process.env.PORT || 8081;
server.listen(PORT, function() {
  console.log("Puppeteer SNES server on port " + PORT);
  console.log("Streaming: " + TARGET_FPS + "fps JPEG from " + GAME_URL);
});
