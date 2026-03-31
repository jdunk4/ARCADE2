const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const puppeteer = require("puppeteer");

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
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--use-gl=swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--autoplay-policy=no-user-gesture-required"
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H });

  page.on("console", function(msg) {
    console.log("[browser] " + msg.type() + ": " + msg.text());
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
    console.warn("[session] canvas not found within 60s");
  }

  clearInterval(keepalive);

  if (!canvasFound) {
    ws.send(JSON.stringify({ type: "error", message: "Emulator failed to load - check ROM token and CORS" }));
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
