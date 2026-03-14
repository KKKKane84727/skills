import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_ROLE = "operator";
const DEFAULT_SCOPES = ["operator.read", "operator.write"];
const DEFAULT_CLIENT = {
  id: "gateway-client",
  version: "1.0.0",
  platform: process.platform === "darwin" ? "macos" : process.platform,
  mode: "backend",
};
const DEVICE_IDENTITY_FILE = "feishu-bridge-device.json";
const DEVICE_AUTH_FILE = "feishu-bridge-device-auth.json";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function resolveHomePrefix(input) {
  return input.replace(/^~/, os.homedir());
}

function resolveStateDir(env = process.env) {
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return path.resolve(resolveHomePrefix(override));
  }
  const home = os.homedir();
  const openclawDir = path.join(home, ".openclaw");
  const legacyDir = path.join(home, ".clawdbot");
  if (env.OPENCLAW_TEST_FAST === "1") {
    return openclawDir;
  }
  if (fs.existsSync(openclawDir)) {
    return openclawDir;
  }
  if (fs.existsSync(legacyDir)) {
    return legacyDir;
  }
  return openclawDir;
}

function resolveAuthPaths(params = {}) {
  const stateDir = params.stateDir
    ? path.resolve(resolveHomePrefix(params.stateDir))
    : resolveStateDir(params.env);
  return {
    stateDir,
    identityPath: params.identityPath
      ? path.resolve(resolveHomePrefix(params.identityPath))
      : path.join(stateDir, "identity", DEVICE_IDENTITY_FILE),
    authPath: params.authPath
      ? path.resolve(resolveHomePrefix(params.authPath))
      : path.join(stateDir, "identity", DEVICE_AUTH_FILE),
  };
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, payload) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

function base64UrlEncode(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input) {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function derivePublicKeyRaw(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem) {
  return crypto.createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
}

function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    version: 1,
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
    createdAtMs: Date.now(),
  };
}

export function loadOrCreateBridgeDeviceIdentity(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKeyPem === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {
        const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
        if (derivedId !== parsed.deviceId) {
          const updated = { ...parsed, deviceId: derivedId };
          writeJson(filePath, updated);
          return updated;
        }
        return parsed;
      }
    }
  } catch {
    // regenerate below
  }

  const identity = generateIdentity();
  writeJson(filePath, identity);
  return identity;
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem) {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

export function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function normalizeScopes(scopes) {
  const items = Array.isArray(scopes) ? scopes : DEFAULT_SCOPES;
  const out = [];
  for (const scope of items) {
    const trimmed = typeof scope === "string" ? scope.trim() : "";
    if (trimmed && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_SCOPES];
}

export function buildDeviceAuthPayloadV3(params) {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    normalizeScopes(params.scopes).join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    typeof params.platform === "string" ? params.platform.trim() : "",
    typeof params.deviceFamily === "string" ? params.deviceFamily.trim() : "",
  ].join("|");
}

function readAuthStore(authPath) {
  try {
    if (!fs.existsSync(authPath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") {
      return null;
    }
    if (!parsed.tokens || typeof parsed.tokens !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeAuthStore(authPath, store) {
  writeJson(authPath, store);
}

export function loadStoredGatewayDeviceAuth(params = {}) {
  const { authPath } = resolveAuthPaths(params);
  const store = readAuthStore(authPath);
  if (!store) {
    return null;
  }
  if (params.deviceId && store.deviceId !== params.deviceId) {
    return null;
  }
  const role = params.role ?? DEFAULT_ROLE;
  const entry = store.tokens?.[role];
  if (!entry || typeof entry.token !== "string" || entry.token.trim() === "") {
    return null;
  }
  return {
    role,
    token: entry.token,
    scopes: normalizeScopes(entry.scopes),
    storedAtMs: typeof entry.storedAtMs === "number" ? entry.storedAtMs : undefined,
  };
}

export function storeGatewayDeviceAuth(params) {
  const { authPath } = resolveAuthPaths(params);
  const existing = readAuthStore(authPath);
  const next =
    existing?.deviceId === params.deviceId
      ? existing
      : {
          version: 1,
          deviceId: params.deviceId,
          tokens: {},
        };
  const role = params.role ?? DEFAULT_ROLE;
  next.deviceId = params.deviceId;
  next.tokens[role] = {
    token: params.token,
    scopes: normalizeScopes(params.scopes),
    storedAtMs: Date.now(),
  };
  writeAuthStore(authPath, next);
  return next.tokens[role];
}

export function clearStoredGatewayDeviceAuth(params = {}) {
  const { authPath } = resolveAuthPaths(params);
  const store = readAuthStore(authPath);
  if (!store) {
    return false;
  }
  if (params.deviceId && store.deviceId !== params.deviceId) {
    return false;
  }
  const role = params.role ?? DEFAULT_ROLE;
  if (!store.tokens?.[role]) {
    return false;
  }
  delete store.tokens[role];
  if (Object.keys(store.tokens).length === 0) {
    try {
      fs.unlinkSync(authPath);
    } catch {
      writeAuthStore(authPath, { version: 1, deviceId: store.deviceId, tokens: {} });
    }
    return true;
  }
  writeAuthStore(authPath, store);
  return true;
}

export function buildGatewayConnectParams(params) {
  const role = params.role ?? DEFAULT_ROLE;
  const requestedScopes = normalizeScopes(params.requestedScopes);
  const client = {
    ...DEFAULT_CLIENT,
    ...(params.client ?? {}),
  };
  const { identityPath, authPath } = resolveAuthPaths(params);
  const identity = loadOrCreateBridgeDeviceIdentity(identityPath);
  const storedAuth = params.forceSharedToken
    ? null
    : loadStoredGatewayDeviceAuth({
        authPath,
        deviceId: identity.deviceId,
        role,
      });
  const auth = storedAuth?.token
    ? { deviceToken: storedAuth.token }
    : { token: params.gatewayToken };
  const authTokenForSignature = auth.deviceToken ?? auth.token ?? null;
  const signedAtMs = params.signedAtMs ?? Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId: client.id,
    clientMode: client.mode,
    role,
    scopes: requestedScopes,
    signedAtMs,
    token: authTokenForSignature,
    nonce: params.nonce,
    platform: client.platform,
    deviceFamily: client.deviceFamily,
  });
  return {
    deviceId: identity.deviceId,
    authMode: storedAuth?.token ? "device-token" : "shared-token",
    authPath,
    connectParams: {
      minProtocol: 3,
      maxProtocol: 3,
      client,
      role,
      scopes: requestedScopes,
      auth,
      device: {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce: params.nonce,
      },
      locale: params.locale,
      userAgent: params.userAgent,
    },
  };
}

export function persistGatewayHelloAuth(params) {
  const payload = params.payload;
  const helloAuth = payload?.type === "hello-ok" ? payload.auth : null;
  if (
    !helloAuth ||
    typeof helloAuth.deviceToken !== "string" ||
    helloAuth.deviceToken.trim() === ""
  ) {
    return null;
  }
  return storeGatewayDeviceAuth({
    authPath: params.authPath,
    deviceId: params.deviceId,
    role:
      typeof helloAuth.role === "string" && helloAuth.role.trim() ? helloAuth.role : params.role,
    token: helloAuth.deviceToken,
    scopes: Array.isArray(helloAuth.scopes) ? helloAuth.scopes : params.scopes,
  });
}

export function resolveBridgeGatewayAuth(params) {
  const built = buildGatewayConnectParams(params);
  return {
    ...built,
    persistHelloAuth(payload) {
      return persistGatewayHelloAuth({
        authPath: built.authPath,
        deviceId: built.deviceId,
        role: params.role ?? DEFAULT_ROLE,
        scopes: built.connectParams.scopes,
        payload,
      });
    },
    clearStoredDeviceAuth() {
      return clearStoredGatewayDeviceAuth({
        authPath: built.authPath,
        deviceId: built.deviceId,
        role: params.role ?? DEFAULT_ROLE,
      });
    },
  };
}

export function isGatewayDeviceTokenMismatch(error) {
  const code = error?.details?.code;
  return (
    code === "AUTH_DEVICE_TOKEN_MISMATCH" || /device token mismatch/i.test(error?.message ?? "")
  );
}
