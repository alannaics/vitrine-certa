const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");

const app = express();
app.use(express.json({ limit: "100kb" }));
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
  return mlAccessToken;
}

app.get("/api/status", (_req, res) => {
  res.json({
    shopee: { configured: Boolean(APP_ID && APP_SECRET) },
    mercadoLivre: { configured: mlConfigured(), connected: Boolean(mlRefreshToken), mode: mlRefreshToken ? "oauth_connected_memory" : "manual", note: "OAuth de consulta da API de vendedores; métricas de afiliados permanecem separadas." }
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



app.get("/api/mercadolivre/discovery", requireDashboardToken, async (req, res) => {
  try {
    const token = await ensureMlToken();
    const terms = [
      "moda feminina", "bolsa feminina", "tenis feminino", "maquiagem",
      "skincare", "acessorios femininos", "organizacao casa", "autocuidado feminino"
    ];
    const searches = await Promise.all(terms.map(async (q) => {
      const url = new URL("https://api.mercadolibre.com/sites/MLB/search");
      url.search = new URLSearchParams({ q, sort: "sold_quantity_desc", limit: "12" }).toString();
      const response = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || "Falha na pesquisa do Mercado Livre (HTTP " + response.status + ").");
      return (data.results || []).map(item => ({ ...item, searchTerm: q }));
    }));
    const unique = new Map();
    for (const item of searches.flat()) {
      if (!item.id || unique.has(String(item.id))) continue;
      const sold = Number(item.sold_quantity || 0);
      const price = Number(item.price || 0);
      if (!price) continue;
      const score = Math.min(100, Math.round(
        Math.min(55, Math.log10(sold + 1) * 18) +
        (item.shipping?.free_shipping ? 10 : 0) +
        (item.condition === "new" ? 10 : 0) +
        (Number(item.original_price) > price ? 15 : 0) +
        Math.min(10, Number(item.available_quantity || 0) > 0 ? 10 : 0)
      ));
      unique.set(String(item.id), {
        id: String(item.id), title: item.title, price, permalink: item.permalink,
        thumbnail: item.thumbnail, category: item.category_id || "",
        soldQuantity: sold, freeShipping: Boolean(item.shipping?.free_shipping), score,
        originalPrice: item.original_price || null
      });
    }
    const products = [...unique.values()]
      .sort((a,b) => b.score-a.score || b.soldQuantity-a.soldQuantity)
      .slice(0,5);
    res.json({ products, updatedAt: new Date().toISOString(), source: "Mercado Livre public search API", note: "Score indicativo; não representa comissão nem previsão garantida de vendas." });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || "Falha no garimpo do Mercado Livre." });
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
app.get("/api/gemini/status", (_req, res) => res.json({ configured: Boolean(GEMINI_API_KEY) }));
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
      "Você é redator de marketing de afiliados para a Vitrine Certa, no Brasil.",
      "Crie conteúdo em português brasileiro, natural, objetivo e persuasivo, sem promessas enganosas.",
      "Não invente avaliações, vendas, características, descontos, escassez ou resultados. Use apenas os dados fornecidos; se faltarem, recomende conferir no anúncio.",
      "Inclua chamada para ação e aviso transparente de link de afiliado. Informe que preço e estoque podem mudar.",
      "Formato solicitado: " + format,
      "Produto: " + product,
      "Preço informado: " + (price || "não informado"),
      "Link de afiliado: " + (link || "não informado"),
      "Informações adicionais: " + (details || "nenhuma")
    ].join("\n");
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1200, thinkingConfig: { thinkingLevel: "low" } } })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.error?.message || "Falha ao gerar conteúdo no Gemini.";
      return res.status(response.status === 429 ? 429 : 502).json({ error: message });
    }
    const text = (data.candidates || []).flatMap(c => c.content?.parts || []).map(p => p.text || "").join("\n").trim();
    if (!text) return res.status(502).json({ error: "O Gemini não retornou texto. Tente novamente." });
    res.json({ text, model: "gemini-3.8-flash" });
  } catch (e) { res.status(500).json({ error: e.message || "Erro ao consultar o Gemini." }); }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log("Vitrine Certa API listening on " + PORT));
