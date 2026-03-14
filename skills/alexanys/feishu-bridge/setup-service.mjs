/**
 * Generate a macOS launchd plist to keep the Feishu bridge running.
 *
 * Usage:
 *   FEISHU_APP_ID=cli_xxx node setup-service.mjs
 *
 * Then:
 *   launchctl load ~/Library/LaunchAgents/com.clawdbot.feishu-bridge.plist
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_ID = process.env.FEISHU_APP_ID;
if (!APP_ID) {
  console.error("Please set FEISHU_APP_ID environment variable");
  process.exit(1);
}

const HOME = os.homedir();
const NODE_PATH = process.execPath; // e.g. /opt/homebrew/bin/node
const BRIDGE_PATH = path.resolve(import.meta.dirname, "bridge.mjs");
const WORK_DIR = path.resolve(import.meta.dirname);
const LABEL = "com.clawdbot.feishu-bridge";

function resolveStateDir() {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return path.resolve(override.replace(/^~/, HOME));
  }
  const openclawDir = path.join(HOME, ".openclaw");
  const legacyDir = path.join(HOME, ".clawdbot");
  if (fs.existsSync(openclawDir)) {
    return openclawDir;
  }
  if (fs.existsSync(legacyDir)) {
    return legacyDir;
  }
  return openclawDir;
}

const STATE_DIR = resolveStateDir();
const SECRET_PATH =
  process.env.FEISHU_APP_SECRET_PATH || path.join(STATE_DIR, "secrets", "feishu_app_secret");
const CONFIG_PATH =
  process.env.CLAWDBOT_CONFIG_PATH ||
  process.env.OPENCLAW_CONFIG_PATH ||
  path.join(
    STATE_DIR,
    fs.existsSync(path.join(STATE_DIR, "openclaw.json")) ? "openclaw.json" : "clawdbot.json",
  );
const LOG_DIR = path.join(STATE_DIR, "logs");

const environmentVariables = {
  HOME,
  PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  FEISHU_APP_ID: APP_ID,
  FEISHU_APP_SECRET_PATH: SECRET_PATH,
  CLAWDBOT_CONFIG_PATH: CONFIG_PATH,
};

if (process.env.CLAWDBOT_AGENT_ID?.trim()) {
  environmentVariables.CLAWDBOT_AGENT_ID = process.env.CLAWDBOT_AGENT_ID.trim();
}
if (process.env.OPENCLAW_CONFIG_PATH?.trim()) {
  environmentVariables.OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH.trim();
}
if (process.env.OPENCLAW_STATE_DIR?.trim()) {
  environmentVariables.OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR.trim();
}
if (process.env.CLAWDBOT_STATE_DIR?.trim()) {
  environmentVariables.CLAWDBOT_STATE_DIR = process.env.CLAWDBOT_STATE_DIR.trim();
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_PATH}</string>
      <string>${BRIDGE_PATH}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${WORK_DIR}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>EnvironmentVariables</key>
    <dict>
${Object.entries(environmentVariables)
  .map(
    ([key, value]) => `      <key>${key}</key>
      <string>${value}</string>`,
  )
  .join("\n")}
    </dict>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/feishu-bridge.out.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/feishu-bridge.err.log</string>
    <key>ThrottleInterval</key>
    <integer>1</integer>
  </dict>
</plist>
`;

// Ensure logs dir
fs.mkdirSync(LOG_DIR, { recursive: true });

const outPath = path.join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, plist);
console.log(`✅ Wrote: ${outPath}`);
console.log();
console.log("To start the service:");
console.log(`  launchctl load ${outPath}`);
console.log();
console.log("To stop:");
console.log(`  launchctl unload ${outPath}`);
