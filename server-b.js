/**
 * server-b.js — Multi-ROM Path B streaming server
 * Uses RetroArch with snes9x/nestopia cores for SNES/NES emulation
 */

const http       = require("http");
const WebSocket  = require("ws");
const { execFile, spawn } = require("child_process");
const path       = require("path");
const fs         = require("fs");
const url        = require("url");

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PORT         = process.env.PORT || 8080;
const ROM_DIR      = path.join(__dirname, "ROM");
const MAX_SESSIONS = 50;
const FRAME_RATE   = 20;

// RetroArch core paths
const CORES = {
  snes: "/root/.config/retroarch/cores/snes9x_libretro.so",
  nes:  "/root/.config/retroarch/cores/nestopia_libretro.so",
};

// Allowlist of permitted ROM filenames
const ALLOWED_ROMS = new Set([
  "smb3mix-rev2B-prg0.nes",
  "Kaizo Mario (English).sfc",
  // Add more here as you upload them
]);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SESSION STORE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const sessions = new Map();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HTTP SERVER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const server = http.createServer((req, res) => {
  const parsedUrl = new url.URL(req.url, `http://localhost`);

  if (parsedUrl.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: sessions.size, max: MAX_SESSIONS }));
    return;
  }

  if (parsedUrl.pathname === "/sessions") {
    const list = [];
    sessions.forEach((s, id) => list.push({ id, rom: s.romFile, wallet: s.wallet }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEBSOCKET SERVER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  const params    = new url.URL(req.url, `http://localhost`).searchParams;
  const romFile   = params.get("rom")     || "";
  const core      = params.get("core")    || "snes";
  const sessionId = params.get("session") || Math.random().toString(36).slice(2);
  const wallet    = params.get("wallet")  || "anonymous";

  console.log(`[${sessionId}] New connection — ROM: ${romFile} | core: ${core} | wallet: ${wallet}`);

  // Validate ROM
  if (!romFile) { sendError(ws, "No ROM specified"); ws.close(); return; }
  if (!ALLOWED_ROMS.has(romFile)) { sendError(ws, `ROM not allowed: ${romFile}`); ws.close(); return; }

  const romPath = path.join(ROM_DIR, romFile);
  if (!fs.existsSync(romPath)) { sendError(ws, `ROM file not found: ${romFile}`); ws.close(); return; }

  // Session cap
  if (sessions.size >= MAX_SESSIONS) { sendError(ws, "Server is full. Try again later."); ws.close(); return; }

  // Validate core
  const corePath = CORES[core];
  if (!corePath) { sendError(ws, `Unknown core: ${core}`); ws.close(); return; }

  const session = { ws, romFile, romId: romFile.replace(/\.[^.]+$/, "").toLowerCase().replace(/\s+/g, "-"), wallet, emulator: null, xvfb: null, ffmpegVideo: null, ffmpegAudio: null };
  sessions.set(sessionId, session);

  sendStatus(ws, "Booting emulator...");
  bootEmulator(session, sessionId, romPath, core, corePath);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "keyDown" || msg.type === "keyUp") forwardInput(session, msg);
    } catch (e) {}
  });

  ws.on("close", () => { console.log(`[${sessionId}] Disconnected`); teardown(sessionId); });
  ws.on("error", () => teardown(sessionId));
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EMULATOR BOOT — RetroArch headless
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function bootEmulator(session, sessionId, romPath, core, corePath) {
  // Unique display per session (:10 through :99)
  const displayNum = 10 + (sessions.size % 90);
  const display    = `:${displayNum}`;

  // Start virtual display
  const xvfb = spawn("Xvfb", [display, "-screen", "0", "256x224x24"], {
    detached: false, stdio: "ignore"
  });

  xvfb.on("error", (err) => {
    console.error(`[${sessionId}] Xvfb error: ${err.message}`);
    teardown(sessionId);
  });

  session.xvfb    = xvfb;
  session.display = display;

  // Give Xvfb a moment to start
  setTimeout(() => {
    if (!sessions.has(sessionId)) return;

    // Launch RetroArch with the appropriate core and ROM
    const emulator = spawn("retroarch", [
      "--libretro", corePath,
      "--fullscreen",
      "--no-stdin",
      romPath
    ], {
      env: {
        ...process.env,
        DISPLAY:      display,
        PULSE_SERVER: "unix:/tmp/pulse/native",
      },
      detached: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    emulator.on("error", (err) => {
      console.error(`[${sessionId}] Emulator error: ${err.message}`);
      sendError(session.ws, "Emulator failed to start: " + err.message);
      teardown(sessionId);
    });

    emulator.on("exit", (code) => {
      console.log(`[${sessionId}] Emulator exited (code ${code})`);
      teardown(sessionId);
    });

    session.emulator = emulator;

    // Give RetroArch 2s to boot, then start streaming
    setTimeout(() => {
      if (!sessions.has(sessionId)) return;
      startFrameStream(session, sessionId, display);
      startAudioStream(session, sessionId);
      sendStatus(session.ws, "");
    }, 2000);

  }, 500);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FRAME STREAMING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startFrameStream(session, sessionId, display) {
  const ffmpeg = spawn("ffmpeg", [
    "-f",          "x11grab",
    "-video_size", "256x224",
    "-framerate",  String(FRAME_RATE),
    "-i",          display,
    "-vf",         `fps=${FRAME_RATE}`,
    "-vcodec",     "png",
    "-f",          "image2pipe",
    "pipe:1"
  ], { stdio: ["ignore", "pipe", "ignore"] });

  let buf = Buffer.alloc(0);

  ffmpeg.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    // Find PNG start signature
    let start = -1;
    for (let i = 0; i < buf.length - 8; i++) {
      if (buf[i] === 0x89 && buf[i+1] === 0x50 && buf[i+2] === 0x4E && buf[i+3] === 0x47) {
        start = i; break;
      }
    }
    if (start === -1) return;

    // Find PNG end signature (IEND chunk)
    const IEND = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
    const end  = buf.indexOf(IEND, start);
    if (end === -1) return;

    const frame = buf.slice(start, end + 8);
    buf = buf.slice(end + 8);

    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        image: "data:image/png;base64," + frame.toString("base64")
      }));
    }
  });

  ffmpeg.on("exit", () => console.log(`[${sessionId}] Frame stream ended`));
  session.ffmpegVideo = ffmpeg;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUDIO STREAMING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startAudioStream(session, sessionId) {
  const ffmpegAudio = spawn("ffmpeg", [
    "-f",    "pulse",
    "-i",    "default",
    "-acodec", "libopus",
    "-b:a",  "64k",
    "-f",    "webm",
    "-cluster_size_limit", "2M",
    "-cluster_time_limit", "2000",
    "pipe:1"
  ], {
    env: { ...process.env, PULSE_SERVER: "unix:/tmp/pulse/native" },
    stdio: ["ignore", "pipe", "ignore"]
  });

  ffmpegAudio.stdout.on("data", (chunk) => {
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: "audio", data: chunk.toString("base64") }));
    }
  });

  ffmpegAudio.on("exit", () => console.log(`[${sessionId}] Audio stream ended`));
  session.ffmpegAudio = ffmpegAudio;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INPUT FORWARDING via xdotool
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const KEY_MAP = {
  up: "Up", down: "Down", left: "Left", right: "Right",
  a: "x", b: "z", x: "s", y: "a",
  l: "q", r: "w",
  start: "Return", select: "shift",
};

function forwardInput(session, msg) {
  const keysym = KEY_MAP[msg.key];
  if (!keysym || !session.display) return;
  const action = msg.type === "keyDown" ? "keydown" : "keyup";
  execFile("xdotool", [action, "--clearmodifiers", keysym], {
    env: { ...process.env, DISPLAY: session.display }
  }, (err) => { if (err) console.warn(`[input] xdotool: ${err.message}`); });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEARDOWN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function teardown(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);

  const kill = (proc, name) => {
    if (proc && !proc.killed) {
      try { proc.kill("SIGTERM"); } catch (e) {}
      console.log(`[${sessionId}] Killed ${name}`);
    }
  };

  kill(session.emulator,    "emulator");
  kill(session.ffmpegVideo, "ffmpegVideo");
  kill(session.ffmpegAudio, "ffmpegAudio");
  kill(session.xvfb,        "xvfb");

  console.log(`[${sessionId}] Teardown complete. Active sessions: ${sessions.size}`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function sendStatus(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "status", message }));
}

function sendError(ws, message) {
  console.error("Error:", message);
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", message }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SHUTDOWN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

process.on("SIGTERM", () => { sessions.forEach((_, id) => teardown(id)); process.exit(0); });
process.on("SIGINT",  () => { sessions.forEach((_, id) => teardown(id)); process.exit(0); });

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// START
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.listen(PORT, () => {
  console.log(`🕹️  Multi-ROM arcade server running on port ${PORT}`);
  console.log(`   ROM directory: ${ROM_DIR}`);
  console.log(`   Max sessions:  ${MAX_SESSIONS}`);
  console.log(`   Allowed ROMs:  ${[...ALLOWED_ROMS].join(", ")}`);
});
