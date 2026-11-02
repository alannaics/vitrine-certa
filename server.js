const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
const APP_ID = process.env.SHOPEE_APP_ID;
const APP_SECRET = process.env.SHOPEE_APP_SECRET;
const SHOPEE_URL = "https://open-api.affiliate.shopee.com.br/graphql";

function signature(payload) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const digest = crypto.createHash("sha256")
    .update(APP_ID + timestamp + payload + APP_SECRET, "utf8")
    .digest("hex");
  return { timestamp, authorization: "SHA256 Credential=" + APP_ID +
    ", Timestamp=" + timestamp + ", Signature=" + digest };
}

async function shopeeRequest(query) {
  if (!APP_ID || !APP_SECRET) {
    const error = new Error("Shopee ainda não configurada no servidor.");
    error.status = 503;
    throw error;
  }
  const payload = JSON.stringify({ query });
  const auth = signature(payload);
  const response = await fetch(SHOPEE_URL, {
    method: "POST",
    headers: {
      "Authorization": auth.authorization,
      "Content-Type": "application/json"
    },
    body: payload
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.errors?.length) {
    const error = new Error(data.errors?.map(e => e.message).join("; ") ||
      "A Shopee retornou HTTP " + response.status);
    error.status = response.status >= 500 ? 502 : 400;
    throw error;
  }
  return data.data;
}

function requireDashboardToken(req, res, next) {
  const expected = process.env.DASHBOARD_API_TOKEN;
  const supplied = req.get("x-dashboard-token") || "";
  if (!expected) return res.status(503).json({ error: "Configure DASHBOARD_API_TOKEN no ambiente do servidor." });
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Token de acesso inválido." });
  }
  next();
}


const ML_CLIENT_ID = process.env.ML_CLIENT_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const db = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;

function tokenEncryptionKey() {
  if (!ML_CLIENT_SECRET) return null;
  return crypto.scryptSync(ML_CLIENT_SECRET, "vitrine-certa-ml-oauth-v1", 32);
}
function encryptTokens(value) {
  const key = tokenEncryptionKey();
  if (!key) throw new Error("ML_CLIENT_SECRET é necessário para proteger a sessão do Mercado Livre.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
function decryptTokens(value) {
  const key = tokenEncryptionKey();
  if (!key) throw new Error("ML_CLIENT_SECRET não configurado.");
  const packed = Buffer.from(value, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8"));
}
async function saveMlTokens() {
  if (!db || !mlRefreshToken) return;
  const encrypted = encryptTokens({ accessToken: mlAccessToken, refreshToken: mlRefreshToken, expiresAt: mlTokenExpiresAt });
  await db.query(
    "INSERT INTO app_secrets (secret_name, secret_value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (secret_name) DO UPDATE SET secret_value = EXCLUDED.secret_value, updated_at = NOW()",
    ["mercadolivre_oauth", encrypted]
  );
}
async function loadMlTokens() {
  if (!db) return;
  const result = await db.query("SELECT secret_value FROM app_secrets WHERE secret_name = $1", ["mercadolivre_oauth"]);
  if (!result.rows.length) return;
  const saved = decryptTokens(result.rows[0].secret_value);
  mlAccessToken = saved.accessToken || null;
  mlRefreshToken = saved.refreshToken || null;
  mlTokenExpiresAt = Number(saved.expiresAt) || 0;
}
async function initializeDatabase() {
  if (!db) return;
  await db.query("CREATE TABLE IF NOT EXISTS app_secrets (secret_name TEXT PRIMARY KEY, secret_value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await loadMlTokens();
}
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ML_REDIRECT_URI = process.env.ML_REDIRECT_URI || "https://vitrine-certa.onrender.com/oauth/mercadolivre/callback";
let mlAccessToken = null;
let mlRefreshToken = null;
let mlTokenExpiresAt = 0;
let mlOAuthState = null;

function mlConfigured() {
  return Boolean(ML_CLIENT_ID && ML_CLIENT_SECRET && ML_REDIRECT_URI);
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function mlTokenRequest(body) {
  const response = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "accept": "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error_description || data.error || "Falha na autenticação do Mercado Livre.");
    error.status = response.status;
    throw error;
  }
  return data;
}
async function ensureMlToken() {
  if (mlAccessToken && Date.now() < mlTokenExpiresAt - 60000) return mlAccessToken;
  if (!mlRefreshToken) {
    const error = new Error("Conecte sua conta do Mercado Livre novamente.");
    error.status = 401;
    throw error;
  }
  const data = await mlTokenRequest({
    grant_type: "refresh_token",
    client_id: ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET,
    refresh_token: mlRefreshToken
  });
  mlAccessToken = data.access_token;
  mlRefreshToken = data.refresh_token;
  mlTokenExpiresAt = Date.now() + Number(data.expires_in || 21600) * 1000;
  await saveMlTokens();
  return mlAccessToken;
}

app.get("/api/status", (_req, res) => {
  res.json({
    database: { configured: Boolean(db) },
    shopee: { configured: Boolean(APP_ID && APP_SECRET) },
    mercadoLivre: { configured: mlConfigured(), connected: Boolean(mlRefreshToken), mode: mlRefreshToken ? "oauth_connected_persistent" : "manual", note: "OAuth de consulta da API de vendedores; métricas de afiliados permanecem separadas." }
  });
});

app.post("/api/shopee/short-link", requireDashboardToken, async (req, res) => {
  try {
    const originUrl = String(req.body?.originUrl || "");
    const subIds = Array.isArray(req.body?.subIds) ? req.body.subIds.slice(0, 5).map(x => String(x).slice(0, 50)) : [];
    let parsed;
    try { parsed = new URL(originUrl); } catch { return res.status(400).json({ error: "Informe uma URL válida." }); }
    if (parsed.protocol !== "https:" || !/(^|\.)shopee\.com(\.br)?$/i.test(parsed.hostname) &&
      !/(^|\.)shopee\.com\.br$/i.test(parsed.hostname) && !/(^|\.)shope\.ee$/i.test(parsed.hostname)) {
      return res.status(400).json({ error: "Use um link HTTPS de produto/loja Shopee." });
    }
    const escapedUrl = JSON.stringify(originUrl);
    const escapedSubs = JSON.stringify(subIds);
    const query = "mutation { generateShortLink(input: { originUrl: " + escapedUrl +
      ", subIds: " + escapedSubs + " }) { shortLink } }";
    const data = await shopeeRequest(query);
    res.json({ shortLink: data?.generateShortLink?.shortLink || null });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get("/api/shopee/products", requireDashboardToken, async (req, res) => {
  try {
    const keyword = String(req.query.keyword || "").slice(0, 80).replace(/["\\]/g, "");
    const page = Math.max(1, Math.min(50, Number(req.query.page) || 1));
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const query = "{ productOfferV2(keyword: " + JSON.stringify(keyword) +
      ", listType: 0, sortType: 1, page: " + page + ", limit: " + limit +
      ") { nodes { itemId productName productLink offerLink imageUrl priceMin priceMax " +
      "priceDiscountRate sales ratingStar commissionRate sellerCommissionRate " +
      "shopeeCommissionRate commission shopId shopName shopType } pageInfo { page limit hasNextPage } } }";
    const data = await shopeeRequest(query);
    res.json(data?.productOfferV2 || { nodes: [], pageInfo: {} });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get("/api/shopee/conversions", requireDashboardToken, async (req, res) => {
  try {
    const start = Number(req.query.start);
    const end = Number(req.query.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= start ||
      end - start > 31 * 86400) {
      return res.status(400).json({ error: "Informe start e end como Unix timestamp (segundos), em intervalo máximo de 31 dias." });
    }
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const query = "{ conversionReport(purchaseTimeStart: " + start +
      ", purchaseTimeEnd: " + end + ", limit: " + limit +
      ") { nodes { purchaseTime clickTime conversionId totalCommission sellerCommission " +
      "shopeeCommissionCapped buyerType device utmContent orders { orderId orderStatus " +
      "items { itemId itemName shopName itemPrice qty itemTotalCommission attributionType } } } " +
      "pageInfo { limit hasNextPage scrollId } } }";
    const data = await shopeeRequest(query);
    res.json(data?.conversionReport || { nodes: [], pageInfo: {} });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});



app.get("/api/mercadolivre/discovery", async (_req, res) => {
  try {
    // Usa o recurso oficial /trends, evitando /sites/MLB/search que pode retornar 403.
    const token = await ensureMlToken();
    const response = await fetch("https://api.mercadolibre.com/trends/MLB", {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" }
    });
    const data = await response.json().catch(() => []);
    if (!response.ok) {
      const message = data.message || data.error || "Falha ao consultar tendências oficiais do Mercado Livre (HTTP " + response.status + ").";
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    const femaleTerms = /feminin|mulher|maquiagem|skincare|beleza|bolsa|biqu[ií]ni|legging|academia|cabelo|unha|organizador|cozinha|decora[cç][aã]o|casa|tenis|sapato|sand[aá]lia|vestido|blusa|cal[cç]a|perfume|escova|secador|chapinha|joia|biju|acess[oó]rio|celular|fone|smartwatch/i;
    const trends = (Array.isArray(data) ? data : [])
      .map((item, index) => ({
        keyword: String(item.keyword || "").trim(),
        url: String(item.url || ""),
        trendType: index < 10 ? "Crescimento" : index < 30 ? "Mais buscado" : "Popular"
      }))
      .filter(item => item.keyword && femaleTerms.test(item.keyword))
      .slice(0, 5)
      .map((item, index) => ({
        id: "trend-" + index + "-" + Buffer.from(item.keyword).toString("base64url").slice(0, 12),
        title: item.keyword,
        price: null,
        permalink: item.url || "https://lista.mercadolivre.com.br/" + encodeURIComponent(item.keyword),
        thumbnail: null,
        category: "Tendência de busca",
        soldQuantity: null,
        freeShipping: false,
        score: null,
        trendType: item.trendType,
        isTrend: true
      }));
    res.json({
      products: trends,
      updatedAt: new Date().toISOString(),
      source: "API oficial de Tendências do Mercado Livre",
      note: "Tendências de busca atualizadas semanalmente. Não são anúncios de produtos: preço, vendedor, estoque e comissão precisam ser conferidos ao abrir os resultados."
    });
  } catch (e) {
    const status = e.status === 401 ? 401 : e.status === 403 ? 403 : 502;
    res.status(status).json({
      error: status === 401
        ? "A autorização do Mercado Livre expirou ou não está ativa neste servidor. Reconecte a conta em Configurações."
        : e.message || "Falha no garimpo de tendências do Mercado Livre."
    });
  }
});

app.get("/oauth/mercadolivre/callback", async (req, res) => {
  try {
    if (!mlConfigured()) return res.status(503).send("Configure ML_CLIENT_ID, ML_CLIENT_SECRET e ML_REDIRECT_URI no Render.");
    if (!mlOAuthState || !safeEqual(req.query.state, mlOAuthState)) return res.status(400).send("Estado OAuth inválido ou expirado. Volte ao Vitrine Certa e tente conectar novamente.");
    mlOAuthState = null;
    if (req.query.error) return res.status(400).send("Autorização não concluída: " + String(req.query.error_description || req.query.error));
    const code = String(req.query.code || "");
    if (!code) return res.status(400).send("Código de autorização não recebido.");
    const data = await mlTokenRequest({
      grant_type: "authorization_code",
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      code,
      redirect_uri: ML_REDIRECT_URI
    });
    mlAccessToken = data.access_token;
    mlRefreshToken = data.refresh_token;
    mlTokenExpiresAt = Date.now() + Number(data.expires_in || 21600) * 1000;
    await saveMlTokens();
    res.type("html").send("<!doctype html><html lang='pt-BR'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Mercado Livre conectado</title><body style='font:16px system-ui;max-width:560px;margin:12vh auto;padding:24px;color:#28232a'><h2>Autorização recebida</h2><p>O Mercado Livre foi conectado ao Vitrine Certa nesta sessão do servidor.</p><p>Volte ao painel para verificar o status. No plano gratuito, uma reinicialização pode exigir nova autorização.</p><a href='/'>Voltar ao Vitrine Certa</a></body></html>");
  } catch (e) { res.status(e.status || 500).send("Não foi possível concluir a conexão: " + String(e.message)); }
});

app.post("/api/mercadolivre/auth-url", requireDashboardToken, (_req, res) => {
  if (!mlConfigured()) return res.status(503).json({ error: "Configure as variáveis ML_CLIENT_ID, ML_CLIENT_SECRET e ML_REDIRECT_URI no Render." });
  mlOAuthState = crypto.randomBytes(24).toString("hex");
  const url = new URL("https://auth.mercadolivre.com.br/authorization");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: ML_CLIENT_ID,
    redirect_uri: ML_REDIRECT_URI,
    state: mlOAuthState
  }).toString();
  res.json({ authorizationUrl: url.toString() });
});

app.get("/api/mercadolivre/me", requireDashboardToken, async (_req, res) => {
  try {
    const token = await ensureMlToken();
    const response = await fetch("https://api.mercadolibre.com/users/me", { headers: { Authorization: "Bearer " + token } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Falha ao consultar a conta Mercado Livre.");
    res.json({ connected: true, nickname: data.nickname || null, userId: data.id || null, expiresAt: mlTokenExpiresAt });
  } catch (e) { res.status(e.status || 500).json({ connected: false, error: e.message }); }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.Gemini_API_Key;
app.get("/api/gemini/status", async (_req, res) => {
  if (!GEMINI_API_KEY) return res.status(503).json({ configured: false, valid: false, error: "Chave Gemini ausente no Render." });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": GEMINI_API_KEY },
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("[Gemini status]", response.status, body.error?.message || "Google API error");
      return res.status(502).json({ configured: true, valid: false, googleStatus: response.status, error: body.error?.message || "Google API recusou a chave." });
    }
    const models = (body.models || []).map(model => model.name).filter(name => /gemini/i.test(name));
    return res.json({ configured: true, valid: true, reachable: true, geminiModelsAvailable: models.length, models: models.slice(0, 12) });
  } catch (error) {
    console.error("[Gemini status]", error.name, error.message);
    return res.status(504).json({ configured: true, valid: false, reachable: false, error: error.name === "AbortError" ? "Tempo esgotado ao conectar ao Google." : error.message });
  } finally { clearTimeout(timer); }
});
app.post("/api/gemini/generate", requireDashboardToken, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(503).json({ error: "Configure GEMINI_API_KEY (ou Gemini_API_Key) no Render." });
    const product = String(req.body?.product || "").slice(0, 500);
    const price = String(req.body?.price || "").slice(0, 80);
    const link = String(req.body?.link || "").slice(0, 1000);
    const format = String(req.body?.format || "Roteiro para vídeo curto").slice(0, 100);
    const details = String(req.body?.details || "").slice(0, 1000);
    if (!product) return res.status(400).json({ error: "Selecione ou informe um produto." });
    const prompt = [
      "Você é estrategista sênior de conteúdo e SEO para marketing de afiliados no Brasil, trabalhando para a Vitrine Certa.",
      "Entregue um pacote pronto para a pessoa gravar e editar o vídeo por conta própria. NÃO gere vídeo, não prometa edição nem publicação automática.",
      "Escreva em português brasileiro, com linguagem natural, específica, persuasiva e sem exageros. Evite introduções genéricas.",
      "Não invente características, avaliações, vendas, descontos, preço, comissão, estoque, escassez, resultados ou experiência de uso. Use apenas os dados fornecidos; quando faltarem, indique claramente o que precisa ser conferido no anúncio.",
      "Organize obrigatoriamente a resposta com estas seções e nesta ordem:",
      "1. ÂNGULO E OBJETIVO: público provável, necessidade atendida, promessa editorial realista e objetivo do conteúdo.",
      "2. ROTEIRO DE GRAVAÇÃO: duração sugerida, gancho nos primeiros 2 segundos, falas/narração completas, desenvolvimento, demonstração e CTA. Diferencie fala de texto na tela.",
      "3. STORYBOARD CENA A CENA: tabela com tempo de início/fim, duração, enquadramento/plano, o que a pessoa deve filmar, ação/movimento de câmera, texto na tela, narração/fala e áudio/efeito sugerido. Planeje cenas graváveis com celular; não dependa de imagens inexistentes.",
      "4. SEO POR PLATAFORMA: criar opções específicas para TikTok, Instagram Reels e YouTube Shorts. Para cada uma, fornecer título/gancho pesquisável, descrição otimizada, palavra-chave principal, palavras-chave secundárias e hashtags relevantes. Não repetir cegamente o mesmo texto entre plataformas.",
      "5. LEGENDA E CTA: legenda pronta para copiar, chamada para ação e aviso transparente de link de afiliado.",
      "6. CHECKLIST ANTES DE PUBLICAR: dados do produto a conferir, alegações que não devem ser feitas sem comprovação e adequação do link.",
      "Use termos de busca naturais e intenção de compra; não faça keyword stuffing nem prometa viralização ou ranking. Hashtags devem ser poucas e pertinentes.",
      "Formato ou plataforma priorizada: " + format,
      "Produto: " + product,
      "Preço informado: " + (price || "não informado"),
      "Link de afiliado: " + (link || "não informado"),
      "Informações adicionais verificadas: " + (details || "nenhuma")
    ].join("\n");
    const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";
    const requestBody = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 3200, thinkingConfig: { thinkingLevel: "low" } }
    });
    let response, data = {};
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const requestTimeout = setTimeout(() => controller.abort(), 50000);
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
          body: requestBody,
          signal: controller.signal
        });
        data = await response.json().catch(() => ({}));
      } catch (error) {
        if (error.name === "AbortError") {
          return res.status(504).json({ error: "O Gemini não respondeu em 50 segundos. A solicitação foi encerrada; tente novamente." });
        }
        throw error;
      } finally { clearTimeout(requestTimeout); }
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    }
    if (!response.ok) {
      const status = response.status;
      if (status === 429 || status === 503 || status === 504) {
        return res.status(503).json({ error: "O Gemini está com alta demanda no momento. A Vitrine Certa tentou novamente automaticamente, mas o serviço continua ocupado. Aguarde cerca de um minuto e tente gerar novamente; seus dados e o produto selecionado foram preservados." });
      }
      const message = data.error?.message || "Falha ao gerar conteúdo no Gemini.";
      return res.status(502).json({ error: message });
    }
    const text = (data.candidates || []).flatMap(c => c.content?.parts || []).map(p => p.text || "").join("\n").trim();
    if (!text) return res.status(502).json({ error: "O Gemini não retornou texto. Tente novamente." });
    res.json({ text, model: "gemini-3.8-flash" });
  } catch (e) { console.error("Gemini generation failed:", e); res.status(502).json({ error: "Falha na comunicação com o serviço de IA: " + (e.message || "erro desconhecido") }); }
});

app.get("/api/health", async (_req, res) => {
  let database = "not_configured";
  if (db) {
    try { await db.query("SELECT 1"); database = "connected"; }
    catch { database = "error"; }
  }
  res.status(database === "error" ? 503 : 200).json({ ok: database !== "error", database });
});
initializeDatabase()
  .then(() => app.listen(PORT, () => console.log("Vitrine Certa API listening on " + PORT + "; database " + (db ? "connected" : "not configured"))))
  .catch(error => {
    console.error("Database initialization failed:", error.message);
    app.listen(PORT, () => console.log("Vitrine Certa API listening on " + PORT + "; database unavailable"));
  });
