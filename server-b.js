/**
 * server-b.js — Multi-ROM Path B streaming server
 *
 * Each WebSocket connection gets its own isolated emulator process.
 * The client passes ?rom=filename.nes&core=nes&session=abc&wallet=0xABC
 * The server boots a headless emulator for that ROM and streams
 * frames + audio back over the same WebSocket.
 *
 * Simultaneous players on different ROMs = fully isolated, no interference.
 */

const http       = require("http");
const WebSocket  = require("ws");
const { execFile, spawn } = require("child_process");
const path       = require("path");
const fs         = require("fs");
const url        = require("url");

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PORT         = process.env.PORT || 3000;
const ROM_DIR      = path.join(__dirname, "ROM");   // ROMs stored here
const MAX_SESSIONS = 50;                             // hard cap on simultaneous players
const FRAME_RATE   = 20;                             // frames per second to stream

// Allowed ROM files — whitelist prevents path traversal attacks
// Add each ROM filename here as you upload them
const ALLOWED_ROMS = new Set([
  "smb3mix-rev2B-prg0.nes",
  "Kaizo Mario (English).sfc",
  // Add more as you go:
  // "another-hack.nes",
  // "some-smw-hack.sfc",
]);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SESSION STORE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// sessionId → { ws, emulatorProcess, romId, wallet, frameTimer }
const sessions = new Map();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HTTP SERVER (health check + ROM serving)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // Health check
  if (parsedUrl.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      sessions: sessions.size,
      max: MAX_SESSIONS
    }));
    return;
  }

  // Active sessions list (for debugging)
  if (parsedUrl.pathname === "/sessions") {
    const list = [];
    sessions.forEach((s, id) => {
      list.push({ id, rom: s.romFile, wallet: s.wallet });
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEBSOCKET SERVER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  const params    = new url.URL(req.url, `http://localhost`).searchParams;
  const romFile   = params.get("rom")     || "";
  const core      = params.get("core")    || "nes";
  const sessionId = params.get("session") || Math.random().toString(36).slice(2);
  const wallet    = params.get("wallet")  || "anonymous";

  console.log(`[${sessionId}] New connection — ROM: ${romFile} | core: ${core} | wallet: ${wallet}`);

  // ── Validate ROM ────────────────────────────────────────────
  if (!romFile) {
    sendError(ws, "No ROM specified");
    ws.close();
    return;
  }

  if (!ALLOWED_ROMS.has(romFile)) {
    sendError(ws, `ROM not in allowlist: ${romFile}`);
    ws.close();
    return;
  }

  const romPath = path.join(ROM_DIR, romFile);
  if (!fs.existsSync(romPath)) {
    sendError(ws, `ROM file not found on server: ${romFile}`);
    ws.close();
    return;
  }

  // ── Session cap ─────────────────────────────────────────────
  if (sessions.size >= MAX_SESSIONS) {
    sendError(ws, "Server is full. Try again later.");
    ws.close();
    return;
  }

  // ── Boot emulator for this session ──────────────────────────
  const session = {
    ws,
    romFile,
    romId: romFile.replace(/\.[^.]+$/, "").toLowerCase().replace(/[\s]+/g, "-"),
    wallet,
    emulator: null,
    frameTimer: null,
    audioProcess: null,
  };

  sessions.set(sessionId, session);
  sendStatus(ws, "Booting emulator...");

  bootEmulator(session, sessionId, romPath, core);

  // ── Handle input from client ─────────────────────────────────
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "keyDown" || msg.type === "keyUp") {
        forwardInput(session, msg);
      }
    } catch (e) {}
  });

  // ── Cleanup on disconnect ────────────────────────────────────
  ws.on("close", () => {
    console.log(`[${sessionId}] Disconnected — tearing down emulator`);
    teardown(sessionId);
  });

  ws.on("error", () => {
    teardown(sessionId);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EMULATOR BOOT
//
// This uses the same headless Snes9x/fceux pattern as your
// original server-b.js — just parameterized per session.
// Each session gets its own process + unique display/audio device.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function bootEmulator(session, sessionId, romPath, core) {
  // Each session gets a unique virtual display number to avoid conflicts
  const displayNum = 10 + (sessions.size % 90); // :10 through :99
  const display    = `:${displayNum}`;
  const audioSink  = `session_${sessionId}`;

  // Start virtual display (Xvfb)
  const xvfb = spawn("Xvfb", [display, "-screen", "0", "256x240x24"], {
    detached: false,
    stdio: "ignore"
  });

  // Choose emulator binary based on core
  const emulatorCmd  = core === "snes" ? "snes9x-gtk" : "fceux";
  const emulatorArgs = core === "snes"
    ? [romPath]
    : ["--no-gui", "--sound", "1", romPath];

  // Start emulator on the virtual display
  const emulator = spawn(emulatorCmd, emulatorArgs, {
    env: { ...process.env, DISPLAY: display },
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
  session.xvfb     = xvfb;
  session.display  = display;

  // Give emulator 1.5s to boot, then start streaming
  setTimeout(() => {
    if (!sessions.has(sessionId)) return; // already disconnected
    startFrameStream(session, sessionId, display);
    startAudioStream(session, sessionId, display);
    sendStatus(session.ws, "");
  }, 1500);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FRAME STREAMING
// Captures the virtual display with ffmpeg → base64 PNG → WebSocket
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startFrameStream(session, sessionId, display) {
  const ffmpeg = spawn("ffmpeg", [
    "-f",         "x11grab",
    "-video_size", "256x240",
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

    // PNG files start with \x89PNG and end with IEND\xAE\x42\x60\x82
    let start = -1;
    for (let i = 0; i < buf.length - 8; i++) {
      if (buf[i] === 0x89 && buf[i+1] === 0x50 && buf[i+2] === 0x4E && buf[i+3] === 0x47) {
        start = i;
        break;
      }
    }

    if (start === -1) return;

    const IEND = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
    const end = buf.indexOf(IEND, start);
    if (end === -1) return;

    const frame = buf.slice(start, end + 8);
    buf = buf.slice(end + 8);

    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        image: "data:image/png;base64," + frame.toString("base64")
      }));
    }
  });

  ffmpeg.on("exit", () => {
    console.log(`[${sessionId}] Frame stream ended`);
  });

  session.ffmpegVideo = ffmpeg;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUDIO STREAMING
// Captures PulseAudio output → WebM Opus chunks → base64 → WebSocket
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startAudioStream(session, sessionId, display) {
  const ffmpegAudio = spawn("ffmpeg", [
    "-f",          "pulse",
    "-i",          "default",
    "-acodec",     "libopus",
    "-b:a",        "64k",
    "-f",          "webm",
    "-cluster_size_limit", "2M",
    "-cluster_time_limit", "2000",
    "pipe:1"
  ], {
    env: { ...process.env, DISPLAY: display },
    stdio: ["ignore", "pipe", "ignore"]
  });

  ffmpegAudio.stdout.on("data", (chunk) => {
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        type:  "audio",
        data:  chunk.toString("base64")
      }));
    }
  });

  ffmpegAudio.on("exit", () => {
    console.log(`[${sessionId}] Audio stream ended`);
  });

  session.ffmpegAudio = ffmpegAudio;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INPUT FORWARDING
// Sends keyboard events to the emulator process via xdotool
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Key mapping: MML gamepad button name → X11 keysym
const KEY_MAP = {
  up:     "Up",
  down:   "Down",
  left:   "Left",
  right:  "Right",
  a:      "x",
  b:      "z",
  x:      "s",
  y:      "a",
  l:      "q",
  r:      "w",
  start:  "Return",
  select: "shift",
};

function forwardInput(session, msg) {
  const keysym = KEY_MAP[msg.key];
  if (!keysym || !session.display) return;

  const action = msg.type === "keyDown" ? "keydown" : "keyup";

  execFile("xdotool", [action, "--clearmodifiers", keysym], {
    env: { ...process.env, DISPLAY: session.display }
  }, (err) => {
    if (err) console.warn(`[input] xdotool error: ${err.message}`);
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEARDOWN — kill all processes for a session
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function sendStatus(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "status", message }));
  }
}

function sendError(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "error", message }));
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CLEANUP ON SERVER SHUTDOWN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

process.on("SIGTERM", () => {
  console.log("SIGTERM received — tearing down all sessions");
  sessions.forEach((_, id) => teardown(id));
  process.exit(0);
});

process.on("SIGINT", () => {
  sessions.forEach((_, id) => teardown(id));
  process.exit(0);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// START
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

server.listen(PORT, () => {
  console.log(`🕹️  Multi-ROM arcade server running on port ${PORT}`);
  console.log(`   ROM directory: ${ROM_DIR}`);
  console.log(`   Max sessions:  ${MAX_SESSIONS}`);
  console.log(`   Allowed ROMs:  ${[...ALLOWED_ROMS].join(", ")}`);
});
