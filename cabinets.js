/**
 * cabinets.js — Registry of all 50 arcade cabinets
 *
 * Each entry defines everything about one cabinet:
 * the ROM to load, how it looks, and its difficulty.
 *
 * To add a new cabinet:
 * 1. Upload the ROM to your /ROM folder
 * 2. Add an entry here
 * 3. In the MML world editor, point the cabinet to:
 *    wss://arcade2-production.up.railway.app?cabinet=YOUR-ID
 */

const CABINETS = {

  "kaizo-mario-world-1": {
    // ROM config
    romFile:    "Kaizo Mario (English).sfc",
    romCore:    "snes",
    // Cabinet display
    title:      "KAIZO MARIO WORLD",
    author:     "T. Takemoto",
    difficulty: "EXPERT",
    diffColor:  "#ff3300",
    previewImg: "https://raw.githubusercontent.com/jdunk4/ARCADE1/main/SMW%20-%20Kaizo%20Mario%20World%201.png",
    infoCard:   "https://raw.githubusercontent.com/jdunk4/ARCADE2/main/KMW%20-%20Info%20Card.png",
  },

  "smb3mix": {
    romFile:    "smb3mix-rev2B-prg0.nes",
    romCore:    "nes",
    title:      "SMB3 MIX",
    author:     "",
    difficulty: "INTERMEDIATE",
    diffColor:  "#88cc00",
    previewImg: "https://raw.githubusercontent.com/jdunk4/ARCADE2/main/SMB3Mix%20-%20Preview.png",
    infoCard:   "",
  },

  // ── Add more cabinets here ──────────────────────────────────────────
  // "your-cabinet-id": {
  //   romFile:    "your-rom.sfc",
  //   romCore:    "snes",
  //   title:      "YOUR GAME TITLE",
  //   author:     "Author Name",
  //   difficulty: "CASUAL",
  //   diffColor:  "#00cc44",
  //   previewImg: "https://raw.githubusercontent.com/jdunk4/ARCADE2/main/your-preview.png",
  //   infoCard:   "https://raw.githubusercontent.com/jdunk4/ARCADE2/main/your-info-card.png",
  // },

};

module.exports = CABINETS;
