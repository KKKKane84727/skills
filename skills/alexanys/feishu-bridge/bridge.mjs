/**
 * Feishu ↔ Clawdbot Bridge
 *
 * Receives messages from Feishu via WebSocket (long connection),
 * forwards them to Clawdbot Gateway, and sends the AI reply back.
 *
 * No public server / domain / HTTPS required.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import * as Lark from "@larksuiteoapi/node-sdk";
import WebSocket from "ws";
import { isGatewayDeviceTokenMismatch, resolveBridgeGatewayAuth } from "./gateway-auth.mjs";

// ─── Config ──────────────────────────────────────────────────────

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET_PATH = resolve(
  process.env.FEISHU_APP_SECRET_PATH || "~/.clawdbot/secrets/feishu_app_secret",
);
const CLAWDBOT_CONFIG_PATH = resolve(
  process.env.CLAWDBOT_CONFIG_PATH || "~/.clawdbot/clawdbot.json",
);
const CLAWDBOT_AGENT_ID = process.env.CLAWDBOT_AGENT_ID || "main";
const THINKING_THRESHOLD_MS = Number(process.env.FEISHU_THINKING_THRESHOLD_MS ?? 2500);
const GATEWAY_SCOPES = ["operator.read", "operator.write"];
const GATEWAY_CLIENT = {
  id: "gateway-client",
  version: "1.0.0",
  platform: process.platform === "darwin" ? "macos" : process.platform,
  mode: "backend",
};

// ─── Helpers ─────────────────────────────────────────────────────

function resolve(p) {
  return p.replace(/^~/, os.homedir());
}

function mustRead(filePath, label) {
  const resolved = resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`[FATAL] ${label} not found: ${resolved}`);
    process.exit(1);
  }
  const val = fs.readFileSync(resolved, "utf8").trim();
  if (!val) {
    console.error(`[FATAL] ${label} is empty: ${resolved}`);
    process.exit(1);
  }
  return val;
}

const uuid = () => crypto.randomUUID();
const SESSION_AGENT_ID =
  (CLAWDBOT_AGENT_ID || "main")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "") || "main";

// ─── Load secrets & config ───────────────────────────────────────

if (!APP_ID) {
  console.error("[FATAL] FEISHU_APP_ID environment variable is required");
  process.exit(1);
}

const APP_SECRET = mustRead(APP_SECRET_PATH, "Feishu App Secret");
const clawdConfig = JSON.parse(mustRead(CLAWDBOT_CONFIG_PATH, "Clawdbot config"));

const GATEWAY_PORT = clawdConfig?.gateway?.port || 18789;
const GATEWAY_TOKEN = clawdConfig?.gateway?.auth?.token;

if (!GATEWAY_TOKEN) {
  console.error("[FATAL] gateway.auth.token missing in Clawdbot config");
  process.exit(1);
}

// ─── Feishu SDK setup ────────────────────────────────────────────

const sdkConfig = {
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: Lark.Domain.Feishu,
  appType: Lark.AppType.SelfBuild,
};

const client = new Lark.Client(sdkConfig);
const wsClient = new Lark.WSClient({ ...sdkConfig, loggerLevel: Lark.LoggerLevel.info });

// ─── Dedup (Feishu may deliver the same event more than once) ────

const seen = new Map();
const SEEN_TTL_MS = 10 * 60 * 1000;

function isDuplicate(messageId) {
  const now = Date.now();
  // Garbage-collect old entries
  for (const [k, ts] of seen) {
    if (now - ts > SEEN_TTL_MS) seen.delete(k);
  }
  if (!messageId) return false;
  if (seen.has(messageId)) return true;
  seen.set(messageId, now);
  return false;
}

// ─── Talk to Clawdbot Gateway ────────────────────────────────────

async function askClawdbot({ text, sessionKey }) {
  try {
    return await askClawdbotOnce({ text, sessionKey });
  } catch (error) {
    if (error?.code === "retry_with_shared_token") {
      return await askClawdbotOnce({ text, sessionKey, forceSharedToken: true });
    }
    throw error;
  }
}

async function askClawdbotOnce({ text, sessionKey, forceSharedToken = false }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}`);
    let runId = null;
    let buf = "";
    let gatewayAuth = null;
    const close = () => {
      try {
        ws.close();
      } catch {}
    };

    ws.on("error", (e) => {
      close();
      reject(e);
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Step 1: Gateway sends connect challenge → we authenticate
      if (msg.type === "event" && msg.event === "connect.challenge") {
        const nonce = typeof msg.payload?.nonce === "string" ? msg.payload.nonce : "";
        if (!nonce) {
          close();
          reject(new Error("connect.challenge nonce missing"));
          return;
        }
        gatewayAuth = resolveBridgeGatewayAuth({
          nonce,
          gatewayToken: GATEWAY_TOKEN,
          requestedScopes: GATEWAY_SCOPES,
          forceSharedToken,
          client: GATEWAY_CLIENT,
          locale: "zh-CN",
          userAgent: "feishu-clawdbot-bridge",
        });
        ws.send(
          JSON.stringify({
            type: "req",
            id: "connect",
            method: "connect",
            params: gatewayAuth.connectParams,
          }),
        );
        return;
      }

      // Step 2: Connect response → send the user message
      if (msg.type === "res" && msg.id === "connect") {
        if (!msg.ok) {
          if (gatewayAuth?.authMode === "device-token" && isGatewayDeviceTokenMismatch(msg.error)) {
            gatewayAuth.clearStoredDeviceAuth();
            close();
            const retryError = new Error(msg.error?.message || "device token mismatch");
            retryError.code = "retry_with_shared_token";
            reject(retryError);
            return;
          }
          close();
          reject(new Error(msg.error?.message || "connect failed"));
          return;
        }
        gatewayAuth?.persistHelloAuth(msg.payload);
        ws.send(
          JSON.stringify({
            type: "req",
            id: "agent",
            method: "agent",
            params: {
              message: text,
              agentId: CLAWDBOT_AGENT_ID,
              sessionKey,
              deliver: false,
              idempotencyKey: uuid(),
            },
          }),
        );
        return;
      }

      // Step 3: Agent run accepted
      if (msg.type === "res" && msg.id === "agent") {
        if (!msg.ok) {
          close();
          reject(new Error(msg.error?.message || "agent error"));
          return;
        }
        if (msg.payload?.runId) runId = msg.payload.runId;
        return;
      }

      // Step 4: Stream the response
      if (msg.type === "event" && msg.event === "agent") {
        const p = msg.payload;
        if (!p || (runId && p.runId !== runId)) return;

        if (p.stream === "assistant") {
          const d = p.data || {};
          if (typeof d.text === "string") buf = d.text;
          else if (typeof d.delta === "string") buf += d.delta;
          return;
        }

        if (p.stream === "lifecycle") {
          if (p.data?.phase === "end") {
            close();
            resolve(buf.trim());
          }
          if (p.data?.phase === "error") {
            close();
            reject(new Error(p.data?.message || "agent error"));
          }
        }
      }
    });
  });
}

// ─── Group chat intelligence ─────────────────────────────────────
//
// In group chats, only respond when the message looks like a real
// question, request, or direct address — avoids spamming.

function shouldRespondInGroup(text, mentions) {
  if (mentions.length > 0) return true;
  const t = text.toLowerCase();
  if (/[？?]$/.test(text)) return true;
  if (/\b(why|how|what|when|where|who|help)\b/.test(t)) return true;
  const verbs = [
    "帮",
    "麻烦",
    "请",
    "能否",
    "可以",
    "解释",
    "看看",
    "排查",
    "分析",
    "总结",
    "写",
    "改",
    "修",
    "查",
    "对比",
    "翻译",
  ];
  if (verbs.some((k) => text.includes(k))) return true;
  // Customize this list with your bot's name
  if (/^(clawdbot|bot|助手|智能体)[\s,:，：]/i.test(text)) return true;
  return false;
}

// ─── Message handler ─────────────────────────────────────────────

const dispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    try {
      const { message } = data;
      const chatId = message?.chat_id;
      if (!chatId) return;

      // Dedup
      if (isDuplicate(message?.message_id)) return;

      // Only handle text messages
      if (message?.message_type !== "text" || !message?.content) return;

      let text = (JSON.parse(message.content)?.text || "").trim();
      if (!text) return;

      // Group chat: check if we should respond
      if (message?.chat_type === "group") {
        const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
        text = text.replace(/@_user_\d+\s*/g, "").trim();
        if (!text || !shouldRespondInGroup(text, mentions)) return;
      }

      const sessionKey = `agent:${SESSION_AGENT_ID}:feishu:${chatId}`;

      // Process asynchronously
      setImmediate(async () => {
        let placeholderId = "";
        let done = false;

        // Show "thinking…" if reply takes too long
        const timer =
          THINKING_THRESHOLD_MS > 0
            ? setTimeout(async () => {
                if (done) return;
                try {
                  const res = await client.im.v1.message.create({
                    params: { receive_id_type: "chat_id" },
                    data: {
                      receive_id: chatId,
                      msg_type: "text",
                      content: JSON.stringify({ text: "正在思考…" }),
                    },
                  });
                  placeholderId = res?.data?.message_id || "";
                } catch {}
              }, THINKING_THRESHOLD_MS)
            : null;

        let reply = "";
        try {
          reply = await askClawdbot({ text, sessionKey });
        } catch (e) {
          reply = `（系统出错）${e?.message || String(e)}`;
        } finally {
          done = true;
          if (timer) clearTimeout(timer);
        }

        // Skip empty or NO_REPLY
        if (!reply || reply === "NO_REPLY") return;

        // If we sent "thinking…", update it; otherwise send new message
        if (placeholderId) {
          try {
            await client.im.v1.message.update({
              path: { message_id: placeholderId },
              data: { msg_type: "text", content: JSON.stringify({ text: reply }) },
            });
            return;
          } catch {
            // Fall through to send new
          }
        }

        await client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: reply }) },
        });
      });
    } catch (e) {
      console.error("[ERROR] message handler:", e);
    }
  },
});

// ─── Start ───────────────────────────────────────────────────────

wsClient.start({ eventDispatcher: dispatcher });
console.log(`[OK] Feishu bridge started (appId=${APP_ID})`);
