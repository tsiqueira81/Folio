// Ask-AI providers, run in the main process so credentials never reach the page.
//
// - ChatGPT: OpenAI's "Sign in with ChatGPT" for open-source apps (OAuth 2.0 + PKCE with a loopback
//   redirect). Requests use the person's own ChatGPT plan through the public Responses API.
//   https://developers.openai.com/siwc/token-sharing-open-source/sign-in
// - Claude: the person's own, unmodified Claude Code CLI, signed in with their Claude subscription
//   through Anthropic's own flow. Folio never sees or stores Claude credentials; it runs `claude -p`
//   with every tool disabled and reads the streamed answer.
const { app, net, safeStorage, shell } = require("electron");
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const AUTH_ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const API = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const USAGE_URL = "https://chatgpt.com/settings/usage";
const REFRESH_FAILURES = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
  "refresh_token_invalidated", "refresh_token_reused"]);

const dir = () => path.join(app.getPath("userData"), "ai");
const file = (name) => path.join(dir(), name);
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function writeAtomic(name, contents) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(name) + ".tmp", contents, { mode: 0o600 });
  fs.renameSync(file(name) + ".tmp", file(name));
}

// ── ChatGPT credentials (encrypted with Windows' per-user data protection) ──────────────────
function loadHost() {
  try {
    const host = JSON.parse(fs.readFileSync(file("chatgpt-host.json"), "utf8"));
    if (typeof host.hostId === "string") return host;
  } catch {}
  const host = { hostId: `urn:uuid:${crypto.randomUUID()}`, clientId: null, welcomeSeen: false };
  writeAtomic("chatgpt-host.json", JSON.stringify(host));
  return host;
}
function saveHost(host) {
  writeAtomic("chatgpt-host.json", JSON.stringify(host));
}

let session = null; // { accessToken, refreshToken, idToken, expiresAt, scopes, email, name }
async function loadSession() {
  if (session) return session;
  try {
    if (!fs.existsSync(file("chatgpt-session.bin")) || !(await safeStorage.isAsyncEncryptionAvailable())) return null;
    const { result } = await safeStorage.decryptStringAsync(fs.readFileSync(file("chatgpt-session.bin")));
    session = JSON.parse(result);
  } catch { session = null; }
  return session;
}
async function saveSession(next) {
  session = next;
  if (!next) {
    try { fs.rmSync(file("chatgpt-session.bin"), { force: true }); } catch {}
    return;
  }
  // Without OS encryption, keep the session in memory only (sign in again next launch).
  if (await safeStorage.isAsyncEncryptionAvailable()) writeAtomic("chatgpt-session.bin", await safeStorage.encryptStringAsync(JSON.stringify(next)));
}

async function postForm(url, params) {
  const response = await net.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: response.ok, status: response.status, json, text };
}

let openIdConfig = null;
async function getOpenIdConfig() {
  if (openIdConfig) return openIdConfig;
  const response = await net.fetch(`${AUTH_ISSUER}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error("Couldn't reach OpenAI's sign-in service.");
  openIdConfig = await response.json();
  return openIdConfig;
}

/** Verifies the ID token's RS256 signature and claims; returns its payload. */
async function verifyIdToken(idToken, clientId, nonce) {
  const [h, p, sig] = String(idToken).split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  const config = await getOpenIdConfig();
  const jwks = await (await net.fetch(config.jwks_uri)).json();
  const jwk = jwks.keys?.find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== "RS256") throw new Error("Unexpected sign-in token.");
  const valid = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(sig, "base64url"));
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const authorizedParty = audience.length > 1 ? payload.azp === clientId : payload.azp === undefined || payload.azp === clientId;
  if (!valid || payload.iss !== AUTH_ISSUER || !audience.includes(clientId) || !authorizedParty || payload.nonce !== nonce
    || !Number.isFinite(payload.exp) || payload.exp * 1000 < Date.now()) {
    throw new Error("The sign-in response couldn't be verified. Please try again.");
  }
  return payload;
}

const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>Folio</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;color:#222">
<p>You can close this tab and return to Folio.</p></body>`;

let signInInProgress = null;

async function signInChatGPT() {
  if (signInInProgress) return signInInProgress;
  signInInProgress = (async () => {
    const host = loadHost();
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));

    // Loopback redirect on 127.0.0.1; only the port may differ between sign-ins.
    const server = http.createServer();
    const callback = new Promise((resolve, reject) => {
      server.on("request", (req, res) => {
        try {
          const url = new URL(req.url, "http://127.0.0.1");
          // Only a response carrying this attempt's state counts; anything else is ignored, so stray
          // requests from other local software or web pages can't end the sign-in.
          if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state) { res.writeHead(404).end(); return; }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(CALLBACK_PAGE);
          if (url.searchParams.get("error")) return reject(new Error(url.searchParams.get("error") === "access_denied" ? "Sign-in was cancelled." : "ChatGPT sign-in failed."));
          resolve(url.searchParams);
        } catch {
          // A malformed request line shouldn't be able to take the app down.
          res.writeHead(400).end();
        }
      });
    });
    callback.catch(() => {}); // handled by the race below; avoids an early unhandled rejection
    let waitTimer;
    try {
      let listenTimer;
      await new Promise((resolve, reject) => {
        let fellBack = false;
        server.on("error", (error) => {
          // Port 1455 is the documented default; any free loopback port also works.
          if (!fellBack && error.code === "EADDRINUSE") { fellBack = true; server.listen(0, "127.0.0.1", resolve); }
          else reject(new Error("Couldn't start sign-in."));
        });
        server.listen(1455, "127.0.0.1", resolve);
        listenTimer = setTimeout(() => reject(new Error("Couldn't start sign-in.")), 5000);
      }).finally(() => clearTimeout(listenTimer));
      const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const timeout = new Promise((_, reject) => {
        waitTimer = setTimeout(() => reject(new Error("Sign-in timed out. Please try again.")), 5 * 60_000);
      });
      timeout.catch(() => {});

      const params = {
        response_type: "code",
        client_id: host.clientId || "dynamic_agent_client",
        redirect_uri: redirectUri,
        scope: SCOPES,
        resource: API,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ext_agent_host_id: host.hostId,
      };
      if (!host.clientId) params.agent_name_hint = "Folio";
      await shell.openExternal(`${AUTHORIZE_URL}?${new URLSearchParams(params)}`);

      const query = await Promise.race([callback, timeout]);
      const clientId = query.get("client_id") || host.clientId;
      if (!clientId) throw new Error("ChatGPT didn't finish registering Folio. Please try again.");
      // Keep the issued client ID for every later sign-in on this computer, even if the rest fails.
      if (host.clientId !== clientId) saveHost({ ...host, clientId });
      const exchange = await postForm(TOKEN_URL, {
        grant_type: "authorization_code", client_id: clientId, code: query.get("code"), code_verifier: verifier, redirect_uri: redirectUri, resource: API,
      });
      if (!exchange.ok || !exchange.json?.access_token) throw new Error("ChatGPT sign-in failed. Please try again.");
      const tokens = exchange.json;
      const claims = await verifyIdToken(tokens.id_token, clientId, nonce);
      const scopes = String(tokens.scope || query.get("scope") || "").split(/[\s+]+/);
      if (!scopes.includes("chatgpt.tokens.use.direct")) {
        throw new Error("ChatGPT plan usage wasn't granted. Sign in again and allow Folio to use your plan.");
      }
      await saveSession({
        accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000, scopes, email: claims.email ?? "", name: claims.name ?? "",
      });
      return await chatgptStatus();
    } finally {
      clearTimeout(waitTimer);
      server.close();
    }
  })();
  try { return await signInInProgress; } finally { signInInProgress = null; }
}

let refreshing = null;
async function accessToken(force = false) {
  const current = await loadSession();
  if (!current) throw Object.assign(new Error("Continue with ChatGPT to use your plan in Folio."), { code: "signed_out" });
  if (!force && current.expiresAt - 60_000 > Date.now()) return current.accessToken;
  // Refresh tokens rotate: never run two refreshes at once.
  refreshing ??= (async () => {
    const { clientId } = loadHost();
    const result = await postForm(TOKEN_URL, { grant_type: "refresh_token", client_id: clientId, refresh_token: current.refreshToken, resource: API });
    if (!result.ok) {
      const code = result.json?.error;
      if (REFRESH_FAILURES.has(code)) {
        await saveSession(null);
        throw Object.assign(new Error("Your ChatGPT sign-in has ended. Continue with ChatGPT to reconnect."), { code: "signed_out" });
      }
      throw new Error("Couldn't refresh your ChatGPT sign-in. Check your connection and try again.");
    }
    const t = result.json;
    // Signed out while this refresh was in flight: don't bring the session back.
    if (!session || session.refreshToken !== current.refreshToken) {
      throw Object.assign(new Error("Continue with ChatGPT to use your plan in Folio."), { code: "signed_out" });
    }
    await saveSession({ ...current, accessToken: t.access_token, refreshToken: t.refresh_token ?? current.refreshToken,
      idToken: t.id_token ?? current.idToken, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 });
    return session.accessToken;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function signOutChatGPT() {
  // Let an in-flight refresh finish first, so the newest refresh token is the one revoked.
  await refreshing?.catch(() => {});
  const current = await loadSession();
  await saveSession(null);
  if (!current?.refreshToken) return chatgptStatus();
  try {
    const { revocation_endpoint } = await getOpenIdConfig();
    if (revocation_endpoint) {
      await postForm(revocation_endpoint, { token: current.refreshToken, token_type_hint: "refresh_token", client_id: loadHost().clientId });
    }
  } catch {
    /* tokens are already cleared locally; the person can also disconnect Folio in ChatGPT settings */
  }
  return chatgptStatus();
}

async function chatgptStatus() {
  const current = await loadSession();
  const host = loadHost();
  return { connected: !!current, email: current?.email ?? "", name: current?.name ?? "", welcomeSeen: !!host.welcomeSeen,
    encrypted: await safeStorage.isAsyncEncryptionAvailable() };
}

async function chatgptModels() {
  const token = await accessToken();
  const response = await net.fetch(`${API}/models`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Couldn't load ChatGPT models (${response.status}).`);
  const json = await response.json();
  const list = Array.isArray(json.models) ? json.models : Array.isArray(json.data) ? json.data : [];
  return list.filter((m) => m.visibility === undefined || m.visibility === "list")
    .map((m) => ({ id: m.slug ?? m.id, name: m.display_name ?? m.slug ?? m.id }))
    .filter((m) => typeof m.id === "string");
}

async function askChatGPT({ model, instructions, messages }, emit, signal) {
  const body = JSON.stringify({
    model,
    instructions,
    input: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    store: false,
    stream: true,
  });
  const send = (token) => net.fetch(`${API}/responses`, {
    method: "POST", signal, body,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
  });
  let response = await send(await accessToken());
  if (response.status === 401) response = await send(await accessToken(true));
  if (!response.ok) {
    let code = "";
    try { const j = await response.json(); code = j.error?.code ?? j.code ?? ""; } catch {}
    throw usageError(code, response.status);
  }
  // Server-sent events: blank-line separated blocks of "event:" / "data:" lines.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") emit(event.delta);
      else if (event.type === "response.completed") completed = true;
      else if (event.type === "response.failed" || event.type === "error") {
        throw usageError(event.response?.error?.code ?? event.error?.code ?? event.code ?? "", 0);
      } else if (event.type === "response.incomplete") {
        throw new Error("The answer was cut short. Try a shorter question or a smaller selection.");
      }
    }
  }
  if (!completed) throw new Error("The connection to ChatGPT ended early. Please try again.");
}

function usageError(code, status) {
  if (code === "subscription_sharing_usage_limit_exceeded" || status === 429) {
    return Object.assign(new Error("You've reached a ChatGPT usage limit."), { code: "usage_limit", link: USAGE_URL });
  }
  if (code === "subscription_sharing_usage_unavailable" || status === 503) {
    return new Error("ChatGPT is temporarily unavailable. Please try again in a moment.");
  }
  if (code === "subscription_sharing_invalid_user" || status === 401) {
    return Object.assign(new Error("ChatGPT couldn't confirm your plan. Continue with ChatGPT to reconnect."), { code: "signed_out" });
  }
  return new Error(`ChatGPT couldn't answer${status ? ` (${status})` : ""}. Please try again.`);
}

// ── Claude Code ────────────────────────────────────────────────────────────────────────────
function run(cmd, args, timeout = 10_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, env: claudeEnv() }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

function claudeEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

let claudePath;
async function findClaude() {
  if (claudePath) return claudePath;
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  // Search absolute PATH entries ourselves (never the current folder, which `where.exe` checks first),
  // with Claude Code's default install location first. Only native executables: .cmd/.bat shims would need a shell.
  const dirs = [path.join(os.homedir(), ".local", "bin"), ...String(process.env.PATH ?? "").split(path.delimiter)]
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter((d) => d && path.isAbsolute(d));
  claudePath = dirs.map((d) => path.join(d, name)).find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) ?? null;
  return claudePath;
}

// Checking Claude Code runs two short processes; reuse the answer for a little while.
let claudeStatusCache = null;
async function claudeStatus(fresh = false) {
  if (!fresh && claudeStatusCache && Date.now() - claudeStatusCache.at < 30_000) return claudeStatusCache.value;
  const exe = await findClaude();
  let value = { installed: false, loggedIn: false };
  if (exe) {
    const version = (await run(exe, ["--version"]))?.trim().split(/\s/)[0] ?? "";
    let auth = null;
    try { auth = JSON.parse((await run(exe, ["auth", "status"])) ?? "null"); } catch {}
    value = { installed: true, version, loggedIn: !!auth?.loggedIn, subscription: auth?.authMethod === "claude.ai", authMethod: auth?.authMethod ?? "" };
  }
  claudeStatusCache = { at: Date.now(), value };
  return value;
}

const CLAUDE_MODELS = new Set(["", "sonnet", "opus", "haiku"]);
const CLAUDE_TIMEOUT_MS = 5 * 60_000;

/** Removes prompt folders left behind if Folio or Claude Code exited mid-answer. */
function cleanStaleClaudeFolders() {
  try {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith("folio-claude-")) fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
    }
  } catch {}
}

async function askClaude({ model, instructions, messages }, emit, signal) {
  const exe = await findClaude();
  if (!exe) throw new Error("Claude Code isn't installed.");
  if (signal.aborted) return;
  // An empty working folder, no settings, MCP servers, slash commands, or tools: Claude only reads and answers.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "folio-claude-"));
  const cleanup = () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} };
  const promptFile = path.join(cwd, "system.txt");
  try {
    fs.writeFileSync(promptFile, instructions, { mode: 0o600 });
  } catch (error) {
    cleanup();
    throw error;
  }
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "",
    "--system-prompt-file", promptFile, "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence"];
  if (model && CLAUDE_MODELS.has(model)) args.push("--model", model);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { cwd, env: claudeEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      cleanup();
      return reject(error);
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, CLAUDE_TIMEOUT_MS);
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    let buffer = "";
    let streamed = false;
    let result = null;
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "stream_event" && event.event?.delta?.type === "text_delta") {
          streamed = true;
          emit(event.event.delta.text);
        } else if (event.type === "result") result = event;
      }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on("error", () => {}); // the process may exit before reading everything
    child.on("error", (error) => { clearTimeout(timer); cleanup(); reject(error); });
    child.on("close", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      cleanup();
      if (signal.aborted) return resolve();
      if (timedOut) return reject(new Error("Claude took too long to answer. Please try again."));
      if (result && !result.is_error) {
        if (!streamed && result.result) emit(result.result);
        return resolve();
      }
      const message = String(result?.result || stderr || "");
      if (/log ?in|logged in|authenticat/i.test(message)) return reject(new Error("Claude Code isn't signed in. Open a terminal, run `claude`, and sign in with your Claude account."));
      if (/limit|usage/i.test(message)) return reject(Object.assign(new Error("You've reached your Claude usage limit. " + message.split("\n")[0]), { code: "usage_limit" }));
      reject(new Error(message.split("\n")[0] || "Claude Code couldn't answer."));
    });
    child.stdin.end(transcript(messages));
  });
}

/** Claude Code reads one prompt, so earlier turns are included as a transcript. */
function transcript(messages) {
  if (messages.length === 1) return messages[0].content;
  const earlier = messages.slice(0, -1).map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`).join("\n\n");
  return `${earlier}\n\nContinue the conversation. Reply to this latest message:\n\n${messages[messages.length - 1].content}`;
}

// ── Gemini (GEMINI_API_KEY env var via @google/genai, Antigravity CLI `agy`, or legacy `gemini`) ──
const GEMINI_API_MODELS = new Set(["gemini-4-hydrogen", "gemini-3.1-flash-lite"]);
const GEMINI_DEFAULT_MODEL = "gemini-4-hydrogen";
const GEMINI_TIMEOUT_MS = 5 * 60_000;

let geminiCliInfo; // { exe: string, kind: "agy" | "gemini" } | null | undefined
async function findGeminiCli() {
  if (geminiCliInfo !== undefined) return geminiCliInfo;
  const win = process.platform === "win32";
  const pathDirs = String(process.env.PATH ?? "")
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter((d) => d && path.isAbsolute(d));

  const agyDirs = win
    ? [
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "agy", "bin") : "",
        path.join(os.homedir(), ".agy", "bin"),
        path.join(os.homedir(), ".local", "bin"),
        ...pathDirs,
      ]
    : [path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".agy", "bin"), "/opt/homebrew/bin", "/usr/local/bin", ...pathDirs];

  const agyNames = win ? ["agy.exe", "agy.cmd"] : ["agy"];
  for (const d of agyDirs.filter((x) => x && path.isAbsolute(x))) {
    for (const name of agyNames) {
      const candidate = path.join(d, name);
      try {
        if (fs.statSync(candidate).isFile()) {
          geminiCliInfo = { exe: candidate, kind: "agy" };
          return geminiCliInfo;
        }
      } catch {}
    }
  }

  // Fallback for enterprise/API users still running legacy Gemini CLI.
  const legacyDirs = win
    ? [process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "", path.join(os.homedir(), ".local", "bin"), ...pathDirs]
    : [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", ...pathDirs];
  const legacyNames = win ? ["gemini.exe", "gemini.cmd"] : ["gemini"];
  for (const d of legacyDirs.filter((x) => x && path.isAbsolute(x))) {
    for (const name of legacyNames) {
      const candidate = path.join(d, name);
      try {
        if (fs.statSync(candidate).isFile()) {
          geminiCliInfo = { exe: candidate, kind: "gemini" };
          return geminiCliInfo;
        }
      } catch {}
    }
  }

  geminiCliInfo = null;
  return geminiCliInfo;
}

function legacyGeminiHasCredentials() {
  const geminiDir = path.join(os.homedir(), ".gemini");
  for (const name of ["oauth_creds.json", "google_accounts.json"]) {
    try {
      const text = fs.readFileSync(path.join(geminiDir, name), "utf8").trim();
      if (text && text !== "{}" && text !== "null") return true;
    } catch {}
  }
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(geminiDir, "settings.json"), "utf8"));
    if (settings?.security?.auth?.selectedType || settings?.selectedAuthType) return true;
  } catch {}
  return Boolean(process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_API_KEY);
}

function runGeminiCmd(cmd, args, timeout = 10_000) {
  return new Promise((resolve) => {
    const isCmd = process.platform === "win32" && /\.cmd$/i.test(cmd);
    execFile(cmd, args, { timeout, windowsHide: true, shell: isCmd, env: claudeEnv() }, (error, stdout) =>
      resolve(error ? null : String(stdout)),
    );
  });
}

let geminiStatusCache = null;
async function geminiStatus(fresh = false) {
  if (!fresh && geminiStatusCache && Date.now() - geminiStatusCache.at < 30_000) return geminiStatusCache.value;
  if (process.env.GEMINI_API_KEY?.trim()) {
    const value = { available: true, mode: "api", installed: true, loggedIn: true, version: "" };
    geminiStatusCache = { at: Date.now(), value };
    return value;
  }
  const found = await findGeminiCli();
  let value = { available: false, mode: "none", installed: false, loggedIn: false, version: "" };
  if (found) {
    const rawVer = (await runGeminiCmd(found.exe, ["--version"]))?.trim() ?? "";
    const version = rawVer.split(/\s+/).pop() ?? "";
    // Antigravity CLI (`agy`) stores its Google session in the OS keyring rather than a plain JSON file,
    // so treat an installed `agy` binary as ready and surface an auth hint if a request asks for sign-in.
    const loggedIn = found.kind === "agy" ? true : legacyGeminiHasCredentials();
    value = { available: loggedIn, mode: "cli", cli: found.kind, installed: true, loggedIn, version };
  }
  geminiStatusCache = { at: Date.now(), value };
  return value;
}

function cleanStaleGeminiFolders() {
  try {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith("folio-gemini-")) fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
    }
  } catch {}
}

async function askGeminiApi({ model, instructions, messages }, emit, signal) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("Gemini API key is not configured.");
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
  const chosenModel = model && GEMINI_API_MODELS.has(model) ? model : GEMINI_DEFAULT_MODEL;
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const stream = await ai.models.generateContentStream({
    model: chosenModel,
    contents,
    config: instructions ? { systemInstruction: instructions } : undefined,
  });
  for await (const chunk of stream) {
    if (signal.aborted) return;
    if (chunk.text) emit(chunk.text);
  }
}

async function askGeminiCli({ model, instructions, messages }, emit, signal) {
  const found = await findGeminiCli();
  if (!found) throw new Error("Antigravity CLI isn't installed.");
  if (signal.aborted) return;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "folio-gemini-"));
  const cleanup = () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} };
  const isCmd = process.platform === "win32" && /\.cmd$/i.test(found.exe);

  // Use explicit headless -p prompt and send the full reading instructions + conversation on stdin
  // so `agy` never enters interactive REPL mode and never hits Windows command-line length limits.
  const args = ["-p", "Follow the system_instructions and answer the user's question from stdin. Reply only with the answer.", "--output-format", "stream-json"];
  if (model && found.kind === "gemini" && GEMINI_API_MODELS.has(model)) args.push("--model", model);

  const stdinPayload = `<system_instructions>\n${instructions}\n</system_instructions>\n\n${transcript(messages)}`;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(found.exe, args, { cwd, env: claudeEnv(), windowsHide: true, shell: isCmd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      cleanup();
      return reject(error);
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, GEMINI_TIMEOUT_MS);
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    let buffer = "";
    let streamed = false;
    let errorMsg = "";
    let stderr = "";
    let finalResponse = "";

    const extractText = (value) => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
      return "";
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch {
          // If the CLI emitted plain text instead of NDJSON, stream it directly.
          streamed = true;
          emit(line + "\n");
          continue;
        }
        if (event.type === "message" && event.role === "assistant") {
          const text = extractText(event.content);
          if (text) {
            if (event.delta) { streamed = true; emit(text); }
            else finalResponse = text;
          }
        } else if (event.type === "stream_event" && typeof event.event?.delta?.text === "string") {
          streamed = true;
          emit(event.event.delta.text);
        } else if (event.type === "text" && typeof event.text === "string") {
          streamed = true;
          emit(event.text);
        } else if (event.type === "error") {
          errorMsg = String(event.message || event.error?.message || "Gemini couldn't answer.");
        } else if (event.type === "result") {
          if (event.status === "error" || event.is_error) {
            errorMsg = String(event.error?.message || event.message || event.result || "Gemini couldn't answer.");
          } else {
            const text = extractText(event.response ?? event.result ?? event.text);
            if (text) finalResponse = text;
          }
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on("error", () => {});
    child.on("error", (error) => { clearTimeout(timer); cleanup(); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      cleanup();
      if (signal.aborted) return resolve();
      if (timedOut) return reject(new Error("Gemini took too long to answer. Please try again."));
      if (code === 0 && !errorMsg) {
        if (!streamed && finalResponse) emit(finalResponse);
        return resolve();
      }
      const cliLabel = found.kind === "agy" ? "Antigravity CLI" : "Gemini CLI";
      const cliCmd = found.kind === "agy" ? "agy" : "gemini";
      const message = String(errorMsg || stderr || "");
      if (/log ?in|sign ?in|authenticat|credentials|oauth|unauthenticated/i.test(message)) {
        return reject(new Error(`${cliLabel} isn't signed in. Open a terminal, run \`${cliCmd}\`, and sign in with your Google account.`));
      }
      if (/quota|rate limit|429|resource_exhausted/i.test(message)) {
        return reject(Object.assign(new Error("You've reached a Gemini usage limit. Please try again in a moment."), { code: "usage_limit" }));
      }
      reject(new Error(message.split("\n")[0] || `${cliLabel} couldn't answer.`));
    });
    child.stdin.end(stdinPayload);
  });
}

async function askGemini(req, emit, signal) {
  if (process.env.GEMINI_API_KEY?.trim()) return askGeminiApi(req, emit, signal);
  return askGeminiCli(req, emit, signal);
}

// ── IPC surface ────────────────────────────────────────────────────────────────────────────
const active = new Map();
const MAX_CHARS = 1_500_000;

function validRequest(req) {
  return req && typeof req.id === "string" && req.id.length < 100 && (req.provider === "chatgpt" || req.provider === "claude" || req.provider === "gemini")
    && typeof req.instructions === "string" && typeof req.model === "string" && req.model.length < 100
    && Array.isArray(req.messages) && req.messages.length > 0 && req.messages.length < 200
    && req.messages.every((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    && req.instructions.length + req.messages.reduce((n, m) => n + m.content.length, 0) < MAX_CHARS;
}

const MAX_ACTIVE = 2;

function register(handle, send) {
  cleanStaleClaudeFolders();
  cleanStaleGeminiFolders();
  handle("folio:ai-status", async () => ({
    chatgpt: await chatgptStatus(),
    claude: await claudeStatus(),
    gemini: await geminiStatus(),
  }));
  handle("folio:ai-chatgpt-signin", async () => {
    try { return { ok: true, status: await signInChatGPT() }; } catch (e) { return { ok: false, error: e.message }; }
  });
  handle("folio:ai-chatgpt-signout", () => signOutChatGPT());
  handle("folio:ai-chatgpt-welcome-seen", () => { saveHost({ ...loadHost(), welcomeSeen: true }); return true; });
  handle("folio:ai-chatgpt-models", async () => {
    try { return { ok: true, models: await chatgptModels() }; } catch (e) { return { ok: false, error: e.message, code: e.code }; }
  });
  let lastClaudeRecheck = 0;
  handle("folio:ai-claude-recheck", async () => {
    if (Date.now() - lastClaudeRecheck < 2000) return claudeStatus();
    lastClaudeRecheck = Date.now();
    claudePath = undefined;
    return claudeStatus(true);
  });
  let lastGeminiRecheck = 0;
  handle("folio:ai-gemini-recheck", async () => {
    if (Date.now() - lastGeminiRecheck < 2000) return geminiStatus();
    lastGeminiRecheck = Date.now();
    geminiCliInfo = undefined;
    return geminiStatus(true);
  });
  handle("folio:ai-ask", (_event, req) => {
    if (!validRequest(req) || active.has(req.id)) throw new Error("Invalid request");
    if (active.size >= MAX_ACTIVE) throw new Error("Another answer is still in progress.");
    const controller = new AbortController();
    active.set(req.id, controller);
    const emit = (text) => send("folio:ai-event", { id: req.id, type: "delta", text });
    const ask = req.provider === "chatgpt" ? askChatGPT : req.provider === "gemini" ? askGemini : askClaude;
    Promise.resolve(ask(req, emit, controller.signal))
      .then(() => send("folio:ai-event", { id: req.id, type: "done" }))
      .catch((e) => send("folio:ai-event", controller.signal.aborted ? { id: req.id, type: "done" }
        : { id: req.id, type: "error", message: e.message || "Something went wrong.", code: e.code ?? "", link: e.link ?? "" }))
      .finally(() => active.delete(req.id));
    return true;
  });
  handle("folio:ai-cancel", (_event, id) => { active.get(id)?.abort(); return true; });
}

module.exports = { register };
