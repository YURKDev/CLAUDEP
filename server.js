import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Render injeta automaticamente process.env.PORT (geralmente 10000)
const PORT = Number(process.env.PORT || 10000);
const DATA_DIR = process.env.DATA_DIR || __dirname;
const STORE_PATH = path.join(DATA_DIR, "auth_store.json");

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    }
  } catch {}
  return { codes: {}, activeCode: null };
}

function saveStore(store) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
  } catch (e) {
    console.error("Erro ao salvar auth_store:", e);
  }
}

const store = loadStore();
const pendingQueues = new Map(); // code -> [cmd]
const waiters = new Map();       // commandId -> { resolve, timer }
const lastSeen = new Map();      // code -> timestamp
const sseClients = new Map();    // sessionId -> res

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
  });
  res.end(JSON.stringify(obj));
}

const CURATED_SOUNDS = [
  { id: "9119713951", name: "Click UI Moderno", category: "ui" },
  { id: "6895079853", name: "Pop Suave Botao", category: "ui" },
  { id: "4612375233", name: "Moeda / Cash Coletado", category: "tycoon" },
  { id: "5153734608", name: "Level Up / Vitoria", category: "rpg" },
  { id: "1848354536", name: "Musica Lobby Relax", category: "music" },
  { id: "1837879082", name: "Musica Aventura / Simulator", category: "music" },
  { id: "9125402735", name: "Explosao / Impacto", category: "sfx" },
  { id: "9114221580", name: "Portal / Magia", category: "sfx" },
];

async function searchRobloxSounds(query) {
  const q = String(query || "").trim();
  try {
    const url = `https://apis.roblox.com/toolbox-service/v1/marketplace/3?keyword=${encodeURIComponent(q)}&limit=8`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (r.ok) {
      const json = await r.json();
      const items = (json.data || []).map((item) => ({
        id: String(item.id),
        name: item.name || "Audio Roblox",
        source: "roblox_creator_store",
      }));
      if (items.length > 0) return items;
    }
  } catch {}
  const lower = q.toLowerCase();
  const filtered = CURATED_SOUNDS.filter(
    (s) => s.name.toLowerCase().includes(lower) || s.category.includes(lower)
  );
  return (filtered.length > 0 ? filtered : CURATED_SOUNDS).map((s) => ({
    ...s,
    source: "curated_library",
  }));
}

async function dispatchToStudio(code, action, params) {
  const targetCode = (code ? String(code).trim().toUpperCase() : null) || store.activeCode;
  if (!targetCode || !store.codes[targetCode] || !store.codes[targetCode].validated) {
    return {
      ok: false,
      error: "Codigo ainda nao validado. Peca ao usuario o codigo que aparece no Roblox Studio e use verify_connection.",
    };
  }
  const online = (Date.now() - (lastSeen.get(targetCode) || 0)) < 8000;
  if (!online) {
    return {
      ok: false,
      error: "Roblox Studio offline no momento. Verifique se o plugin esta aberto e conectado na URL do Render.",
    };
  }
  const commandId = crypto.randomUUID();
  const q = pendingQueues.get(targetCode) || [];
  q.push({ id: commandId, action, params: params || {} });
  pendingQueues.set(targetCode, q);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(commandId);
      resolve({ ok: false, error: "Timeout aguardando resposta do Roblox Studio." });
    }, 25000);
    waiters.set(commandId, { resolve, timer });
  });
}

// =========================================================
// DEFINICAO DAS TOOLS MCP (PARA ENDPOINT REMOTO /mcp e /sse)
// =========================================================
const MCP_TOOLS = [
  {
    name: "verify_connection",
    description: "Valida o codigo exibido no plugin do Roblox Studio. Uma vez validado, funciona para sempre em qualquer conta do Claude.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Codigo exibido no Roblox Studio (ex: RBX-7K4M-9P2Q)" },
      },
      required: ["code"],
    },
  },
  {
    name: "check_status",
    description: "Verifica se o Roblox Studio esta conectado no Render e qual codigo esta validado.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_explorer_tree",
    description: "Lista instancias em Workspace, ReplicatedStorage, ServerScriptService, StarterGui e Lighting.",
    inputSchema: {
      type: "object",
      properties: { maxDepth: { type: "number" } },
    },
  },
  {
    name: "create_script",
    description: "Cria ou edita um Script, LocalScript ou ModuleScript diretamente no Roblox Studio.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        scriptType: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"] },
        parent: { type: "string" },
        source: { type: "string" },
      },
      required: ["name", "source"],
    },
  },
  {
    name: "create_map_preset",
    description: "Cria mapas prontos (lobby_island, obby_stage, tycoon_base) no Workspace.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["lobby_island", "obby_stage", "tycoon_base"] },
        name: { type: "string" },
        position: { type: "array", items: { type: "number" } },
      },
      required: ["preset"],
    },
  },
  {
    name: "create_modern_ui",
    description: "Cria UIs modernas inspiradas em jogos famosos atuais (pet_sim, anime_rng, blox_fruits, modern_tycoon).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        style: { type: "string", enum: ["pet_sim", "anime_rng", "blox_fruits", "modern_tycoon"] },
        title: { type: "string" },
        buttons: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "search_sounds",
    description: "Pesquisa sons/musicas do Roblox e opcionalmente insere no SoundService.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        autoInsert: { type: "boolean" },
        soundName: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "insert_sound",
    description: "Insere um Sound com SoundId especifico no Roblox Studio.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        soundId: { type: "string" },
        volume: { type: "number" },
        looped: { type: "boolean" },
        parent: { type: "string" },
      },
      required: ["name", "soundId"],
    },
  },
  {
    name: "get_project_suggestions",
    description: "Analisa o projeto aberto no Studio e gera sugestoes de UIs, mapas, sons e scripts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_luau_in_studio",
    description: "Executa codigo Luau diretamente no Roblox Studio (com suporte a Ctrl+Z) para construir mapas complexos.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  },
  {
    name: "delete_instance",
    description: "Remove uma instancia do Roblox Studio pelo caminho (ex: Workspace.Part).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

async function executeMcpToolCall(name, args = {}) {
  if (name === "verify_connection") {
    const clean = String(args.code || "").trim().toUpperCase();
    if (!clean) return { ok: false, error: "Informe o codigo exibido no Roblox Studio." };
    if (!store.codes[clean]) {
      store.codes[clean] = {
        code: clean,
        validated: true,
        createdAt: new Date().toISOString(),
        validatedAt: new Date().toISOString(),
      };
    } else {
      store.codes[clean].validated = true;
      store.codes[clean].validatedAt = store.codes[clean].validatedAt || new Date().toISOString();
    }
    store.activeCode = clean;
    saveStore(store);
    const online = (Date.now() - (lastSeen.get(clean) || 0)) < 8000;
    return {
      ok: true,
      code: clean,
      validatedForever: true,
      studioOnline: online,
      message: online
        ? "CONECTED! Codigo validado para sempre no Render (funciona em todas as suas contas Claude)."
        : "Codigo validado para sempre no Render! Abra o Studio com o plugin conectado.",
    };
  }
  if (name === "check_status") {
    const code = store.activeCode;
    const entry = code ? store.codes[code] : null;
    const online = code ? (Date.now() - (lastSeen.get(code) || 0)) < 8000 : false;
    return {
      ok: true,
      activeCode: code,
      validated: Boolean(entry?.validated),
      studioOnline: online,
      placeName: entry?.placeName || null,
    };
  }
  if (name === "search_sounds") {
    const sounds = await searchRobloxSounds(args.query || "");
    let insertResult = null;
    if (args.autoInsert && sounds.length > 0) {
      const top = sounds[0];
      insertResult = await dispatchToStudio(null, "insert_sound", {
        name: args.soundName || top.name,
        soundId: top.id,
        parent: "SoundService",
      });
    }
    return { ok: true, sounds, insertResult };
  }
  if (name === "get_project_suggestions") {
    const analysis = await dispatchToStudio(null, "get_project_analysis", {});
    if (!analysis.ok) return analysis;
    const stats = analysis.stats || {};
    const suggestions = [];
    if ((stats.screenGuis || 0) === 0) {
      suggestions.push("Crie uma HUD moderna com `create_modern_ui` (pet_sim, anime_rng, blox_fruits ou modern_tycoon).");
    }
    if ((stats.sounds || 0) === 0) {
      suggestions.push("Adicione efeitos sonoros com `search_sounds` (click, coin, lobby music).");
    }
    if ((stats.scripts || 0) < 3) {
      suggestions.push("Adicione sistema de Leaderstats + DataStore com `create_script`.");
    }
    if ((stats.parts || 0) < 10) {
      suggestions.push("Construa o cenario inicial usando `create_map_preset` ou `run_luau_in_studio`.");
    }
    return { ok: true, stats, suggestions };
  }
  if (name === "run_luau_in_studio") {
    return dispatchToStudio(null, "run_luau", { code: args.code });
  }
  return dispatchToStudio(null, name, args);
}

async function handleJsonRpc(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "roblox-studio-render-mcp", version: "2.0.0" },
      },
    };
  }
  if (method === "notifications/initialized") {
    return null;
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
  }
  if (method === "tools/call") {
    const toolResult = await executeMcpToolCall(params?.name, params?.arguments || {});
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }],
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Metodo desconhecido: ${method}` },
  };
}

// =========================================================
// SERVIDOR HTTP + SSE + STREAMABLE MCP (100% COMPATIVEL RENDER)
// =========================================================
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
      });
      return res.end();
    }

    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const p = urlObj.pathname;

    // Health check do Render
    if (req.method === "GET" && p === "/") {
      return sendJson(res, 200, {
        ok: true,
        service: "Roblox Studio Claude Cloud MCP (Render)",
        mcpEndpoint: "/mcp",
        sseEndpoint: "/sse",
        activeCode: store.activeCode,
        studioOnline: store.activeCode
          ? (Date.now() - (lastSeen.get(store.activeCode) || 0)) < 8000
          : false,
      });
    }

    // Plugin Polling (Roblox Studio -> Render)
    if (req.method === "POST" && (p === "/api/plugin/poll" || p === "/api/plugin/register")) {
      const { code, placeName } = await readJsonBody(req);
      if (!code) return sendJson(res, 400, { ok: false, error: "Codigo ausente" });
      if (!store.codes[code]) {
        store.codes[code] = {
          code,
          validated: false,
          createdAt: new Date().toISOString(),
          validatedAt: null,
        };
        saveStore(store);
      }
      if (placeName) store.codes[code].placeName = placeName;
      store.activeCode = code;
      lastSeen.set(code, Date.now());
      const queue = pendingQueues.get(code) || [];
      pendingQueues.set(code, []);
      return sendJson(res, 200, {
        ok: true,
        validated: store.codes[code].validated === true,
        commands: queue,
      });
    }

    // Plugin devolve resultado
    if (req.method === "POST" && p === "/api/plugin/result") {
      const { commandId, result } = await readJsonBody(req);
      const w = waiters.get(commandId);
      if (w) {
        clearTimeout(w.timer);
        waiters.delete(commandId);
        w.resolve(result);
      }
      return sendJson(res, 200, { ok: true });
    }

    // Endpoints REST auxiliares (para ponte local opcional ou debug)
    if (req.method === "POST" && p === "/api/mcp/verify") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await executeMcpToolCall("verify_connection", body));
    }
    if (req.method === "GET" && p === "/api/mcp/status") {
      return sendJson(res, 200, await executeMcpToolCall("check_status", {}));
    }
    if (req.method === "POST" && p === "/api/mcp/command") {
      const { code, action, params } = await readJsonBody(req);
      return sendJson(res, 200, await dispatchToStudio(code, action, params));
    }
    if (req.method === "GET" && p === "/api/sounds/search") {
      const q = urlObj.searchParams.get("q") || "";
      return sendJson(res, 200, { ok: true, sounds: await searchRobloxSounds(q) });
    }

    // =========================================================
    // ENDPOINT REMOTO MCP DIRETO (SEM PRECISAR DE PC!)
    // =========================================================
    // 1) Streamable HTTP (/mcp) - usado pelo Claude Web/Mobile/Desktop Connectors
    if (req.method === "POST" && p === "/mcp") {
      const body = await readJsonBody(req);
      const rpcRes = await handleJsonRpc(body);
      if (!rpcRes) {
        res.writeHead(202, { "Access-Control-Allow-Origin": "*" });
        return res.end();
      }
      return sendJson(res, 200, rpcRes);
    }

    // 2) SSE Transport (/sse + /messages) - compatibilidade extra
    if (req.method === "GET" && p === "/sse") {
      const sessionId = crypto.randomUUID();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      sseClients.set(sessionId, res);
      res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
      const keepAlive = setInterval(() => {
        res.write(": ping\n\n");
      }, 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(sessionId);
      });
      return;
    }

    if (req.method === "POST" && p === "/messages") {
      const sessionId = urlObj.searchParams.get("sessionId");
      const body = await readJsonBody(req);
      const rpcRes = await handleJsonRpc(body);
      const client = sessionId ? sseClients.get(sessionId) : null;
      if (client && rpcRes) {
        client.write(`event: message\ndata: ${JSON.stringify(rpcRes)}\n\n`);
      }
      return sendJson(res, 202, { ok: true });
    }

    sendJson(res, 404, { ok: false, error: "Rota nao encontrada" });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[RobloxClaudeRender] Online na porta ${PORT}`);
});
