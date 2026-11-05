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
  await db.query("CREATE TABLE IF NOT EXISTS dashboard_state (id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await db.query("CREATE TABLE IF NOT EXISTS saved_campaigns (id TEXT PRIMARY KEY, product_name TEXT NOT NULL, format TEXT, content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
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
    const result = data?.productOfferV2 || { nodes: [], pageInfo: {} };
    const nodes = (result.nodes || [])
      .slice()
      .sort((a, b) => {
        const salesA = Number(a.sales);
        const salesB = Number(b.sales);
        if (Number.isFinite(salesA) && Number.isFinite(salesB)) return salesB - salesA;
        if (Number.isFinite(salesA)) return -1;
        if (Number.isFinite(salesB)) return 1;
        return 0;
      });
    res.json({ ...result, nodes, ranking: "Produtos ordenados pelas vendas informadas pela API; itens sem dado de vendas aparecem depois.",
      availabilityVerified: false,
      availabilityNote: "A API de ofertas consultada não fornece um campo confiável de estoque nesta consulta; confirme a disponibilidade na página do produto." });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get("/api/mercadolivre/products", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim().slice(0, 100);
    if (!query) return res.status(400).json({ error: "Informe o nome do produto para pesquisar." });
    const token = await ensureMlToken();
    const headers = { Accept: "application/json", Authorization: "Bearer " + token, "User-Agent": "VitrineCerta/1.0" };
    const url = new URL("https://api.mercadolibre.com/products/search");
    url.search = new URLSearchParams({ site_id: "MLB", q: query, limit: "50" }).toString();
    const response = await fetch(url, { headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || data.error || "A API de produtos do Mercado Livre respondeu HTTP " + response.status + ".");
      error.status = response.status; throw error;
    }
    const raw = Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : [];
    const candidates = raw.map(item => {
      const winner = item.buy_box_winner || item.buyBoxWinner || {};
      const pics = item.pictures || item.main_picture || [];
      const pic = Array.isArray(pics) ? pics[0]?.url || pics[0]?.secure_url : pics?.url || pics?.secure_url;
      return { catalogId: item.id || null, itemId: winner.item_id || winner.itemId || winner.id || item.item_id || item.itemId || null,
        title: item.name || item.title || winner.title || "", price: winner.price ?? item.price ?? item.price_info?.price ?? null,
        permalink: winner.permalink || item.permalink || "", thumbnail: pic || winner.thumbnail || null,
        rating: item.rating?.average ?? winner.rating_average ?? null, category: item.domain_id || item.category_id || "Mercado Livre" };
    }).filter(item => item.title && item.catalogId);
    const checked = await Promise.allSettled(candidates.slice(0, 30).map(async item => {
      let itemId = item.itemId;
      // Product detail may expose the current buy-box listing even when product search omits it.
      if (!itemId) {
        const productResponse = await fetch("https://api.mercadolibre.com/products/" + encodeURIComponent(item.catalogId), { headers });
        const productDetail = await productResponse.json().catch(() => ({}));
        if (productResponse.ok) {
          const winner = productDetail.buy_box_winner || productDetail.buyBoxWinner || {};
          itemId = winner.item_id || winner.itemId || winner.id || null;
        }
      }
      if (!itemId) return { catalog: item };
      const detailResponse = await fetch("https://api.mercadolibre.com/items/" + encodeURIComponent(itemId), { headers });
      const detail = await detailResponse.json().catch(() => ({}));
      if (!detailResponse.ok || detail.status !== "active" || Number(detail.available_quantity || 0) <= 0) return null;
      let seller = null;
      if (detail.seller_id) {
        try {
          const sellerResponse = await fetch("https://api.mercadolibre.com/users/" + encodeURIComponent(detail.seller_id), { headers });
          if (sellerResponse.ok) seller = await sellerResponse.json();
        } catch (_) {}
      }
      let competition = null;
      try {
        const competitionUrl = new URL("https://api.mercadolibre.com/items/" + encodeURIComponent(itemId) + "/price_to_win");
        competitionUrl.search = new URLSearchParams({ site_id: "MLB", version: "v2" }).toString();
        const competitionResponse = await fetch(competitionUrl, { headers });
        if (competitionResponse.ok) competition = await competitionResponse.json();
      } catch (_) {}
      return { listing: { ...item, id: detail.id, title: detail.title || item.title,
        price: Number(detail.price ?? item.price) || null, permalink: detail.permalink || item.permalink,
        thumbnail: detail.thumbnail || item.thumbnail, sold_quantity: Number(detail.sold_quantity) || 0,
        available_quantity: Number(detail.available_quantity) || 0, listing_status: detail.status,
        sellerId: detail.seller_id || null, sellerName: seller?.nickname || null,
        sellerReputation: seller?.seller_reputation?.level_id || null,
        sellerTransactions: seller?.seller_reputation?.transactions?.completed ?? null,
        sellerPositiveRate: seller?.seller_reputation?.transactions?.ratings?.positive ?? null,
        officialStore: Boolean(detail.official_store_id), officialStoreId: detail.official_store_id || null,
        shipping: { free_shipping: Boolean(detail.shipping?.free_shipping), logistic_type: detail.shipping?.logistic_type || null },
        availabilityVerified: true, competition: competition ? {
          status: competition.status || null,
          currentPrice: competition.current_price ?? null,
          priceToWin: competition.price_to_win ?? null,
          competitorsSharingFirstPlace: competition.competitors_sharing_first_place ?? null,
          visitShare: competition.visit_share || null,
          reasons: Array.isArray(competition.reason) ? competition.reason : [],
          boosts: Array.isArray(competition.boosts) ? competition.boosts.map(b => ({ id: b.id, status: b.status, description: b.description })) : [],
          winner: competition.winner ? { itemId: competition.winner.item_id || null, price: competition.winner.price ?? null, sellerId: competition.winner.seller_id || null } : null
        } : null, category: detail.category_id || item.category } };
    }));
    const verified = checked.filter(x => x.status === "fulfilled" && x.value?.listing).map(x => x.value.listing);
    const verifiedIds = new Set(verified.map(x => String(x.catalogId)));
    const catalogOnly = checked.filter(x => x.status === "fulfilled" && x.value?.catalog)
      .map(x => ({ ...x.value.catalog, sold_quantity: null, available_quantity: null, listing_status: "catalog",
        availabilityVerified: false, availabilityNote: "Produto de catálogo sem anúncio vencedor confirmado. Não é possível afirmar ranking de vendas ou estoque." }));
    const products = verified.sort((a,b) => (Number(b.sold_quantity)||0) - (Number(a.sold_quantity)||0));
    res.json({ products, catalogProducts: catalogOnly, count: products.length, verifiedCount: verified.length, catalogCount: catalogOnly.length,
      source: "API oficial de catálogo e anúncios do Mercado Livre",
      ranking: "Anúncios ativos com estoque confirmado, ordenados pelas vendas reportadas; catálogo sem anúncio confirmado aparece separado.",
      updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("[mercadolivre-products]", error.message);
    res.status(error.status === 401 || error.status === 403 ? error.status : 502).json({
      error: error.status === 401 ? "A autorização do Mercado Livre expirou. Reconecte a conta em Configurações." :
        error.message || "Não foi possível consultar o catálogo do Mercado Livre."
    });
  }
});

app.post("/api/affiliate/inspect", requireDashboardToken, async (req, res) => {
  try {
    const link = String(req.body?.link || "").trim();
    const name = String(req.body?.name || "").trim().slice(0, 120);
    if (!/^https?:\/\//i.test(link)) return res.status(400).json({ error: "Informe um link http ou https válido." });
    const parsed = new URL(link);
    const host = parsed.hostname.toLowerCase();
    if (host.includes("mercadolivre") || host.includes("mercadolibre")) {
      const match = (parsed.pathname.match(/(MLB-?\d{6,})/i) || [])[1];
      if (!match) return res.status(422).json({ marketplace: "Mercado Livre", message: "Não consegui identificar o código do anúncio neste link. Mantenha o nome e o link; preço e comissão podem ser conferidos manualmente." });
      const itemId = match.replace("-", "").toUpperCase();
      const token = await ensureMlToken();
      const response = await fetch("https://api.mercadolibre.com/items/" + encodeURIComponent(itemId), { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
      const item = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(item.message || "Mercado Livre respondeu HTTP " + response.status + ".");
      return res.json({ marketplace: "Mercado Livre", name: item.title || name, price: item.price ?? null, category: item.category_id || "", rating: null, sold: item.sold_quantity ?? null, freeShipping: item.shipping?.free_shipping === true, available: item.status === "active" && Number(item.available_quantity || 0) > 0, commission: null, commissionNote: "A API pública de anúncios do Mercado Livre não informa a comissão do seu programa de afiliados. Esse dado precisa vir do painel de afiliados.", source: "API de anúncios do Mercado Livre", updatedAt: new Date().toISOString() });
    }
    if (host.includes("shopee")) {
      const keyword = name || decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "").replace(/[-_]/g, " ").slice(0, 80);
      if (!keyword) return res.status(422).json({ marketplace: "Shopee", message: "Informe também o nome do produto para consultar a oferta na API de afiliados." });
      const query = "{ productOfferV2(keyword: " + JSON.stringify(keyword.replace(/["\\]/g, "")) + ", listType: 0, sortType: 1, page: 1, limit: 50) { nodes { itemId productName productLink offerLink imageUrl priceMin priceMax sales ratingStar commissionRate sellerCommissionRate shopeeCommissionRate commission shopId shopName } } }";
      const data = await shopeeRequest(query);
      const nodes = data?.productOfferV2?.nodes || [];
      const idMatch = parsed.pathname.match(/-i\.(\d+)\.(\d+)/);
      const found = nodes.find(p => idMatch && String(p.itemId) === String(idMatch[2])) || nodes.find(p => (p.productName || "").toLowerCase() === keyword.toLowerCase()) || null;
      if (!found) return res.json({ marketplace: "Shopee", name, message: "A API não retornou uma oferta correspondente com segurança. Não vou associar comissão de outro produto. Confira se o acesso de afiliado está ativo e tente novamente.", commission: null, source: "Shopee Affiliate Open API" });
      return res.json({ marketplace: "Shopee", name: found.productName || name, price: found.priceMin ?? found.priceMax ?? null, category: "", rating: found.ratingStar ?? null, sold: found.sales ?? null, freeShipping: null, available: null, commission: found.commissionRate ?? found.sellerCommissionRate ?? found.shopeeCommissionRate ?? found.commission ?? null, commissionNote: "Comissão retornada pela oferta da API; confirme regras e valor final no painel de afiliados.", offerLink: found.offerLink || found.productLink || "", source: "Shopee Affiliate Open API", updatedAt: new Date().toISOString() });
    }
    return res.status(422).json({ error: "Domínio não reconhecido. Use um link da Shopee ou do Mercado Livre." });
  } catch (e) {
    console.error("[affiliate-inspect]", e.message);
    res.status(e.status || 502).json({ error: e.message || "Não foi possível identificar os dados deste link." });
  }
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




const dailyPicksCache = new Map();
const femaleSearches = [
  { keyword: "moda feminina", category: "Moda feminina" },
  { keyword: "beleza maquiagem skincare", category: "Beleza" },
  { keyword: "bolsa feminina acessorios", category: "Bolsas e acessórios" },
  { keyword: "legging fitness feminina", category: "Fitness feminino" },
  { keyword: "sapato feminino", category: "Calçados femininos" }
];
function brazilDateKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
app.get("/api/daily-picks", async (req, res) => {
  const dateKey = brazilDateKey();
  const cached = dailyPicksCache.get(dateKey);
  if (req.query.refresh !== "1" && cached && Date.now() - cached.createdAt < 20 * 60 * 60 * 1000) {
    return res.json({ ...cached.payload, cached: true });
  }
  try {
    // A API de busca pode bloquear chamadas anônimas originadas de servidores cloud.
    // Usamos a sessão OAuth já conectada ao Mercado Livre e um User-Agent identificável.
    const token = await ensureMlToken();
    const batches = await Promise.allSettled(femaleSearches.map(async group => {
      const url = new URL("https://api.mercadolibre.com/sites/MLB/search");
      url.search = new URLSearchParams({ q: group.keyword, sort: "sold_quantity_desc", limit: "30" }).toString();
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + token,
          "User-Agent": "VitrineCerta/1.0 (product discovery)"
        }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error("Mercado Livre (" + group.category + ") respondeu HTTP " + response.status);
        error.status = response.status;
        throw error;
      }
      return (data.results || []).map(item => ({
        id: String(item.id), title: String(item.title || ""), price: Number(item.price) || null,
        currency: item.currency_id || "BRL", soldQuantity: Number(item.sold_quantity) || 0,
        rating: Number(item.reviews?.rating_average || item.rating_average) || null,
        permalink: String(item.permalink || ""), thumbnail: String(item.thumbnail || "").replace("-I.jpg", "-W.jpg"),
        sellerId: item.seller?.id || null, category: group.category,
        condition: item.condition || null, shippingFree: Boolean(item.shipping?.free_shipping),
        platform: "Mercado Livre", source: "API oficial de busca do Mercado Livre"
      }));
    }));
    const successful = batches.filter(x => x.status === "fulfilled").flatMap(x => x.value);
    const failedCategories = batches.map((x,i) => x.status === "rejected" ? {
      category: femaleSearches[i].category,
      status: x.reason?.status || null,
      message: x.reason?.message || "Falha na consulta"
    } : null).filter(Boolean);
    if (!successful.length) {
      const authFailure = failedCategories.find(x => x.status === 401 || x.status === 403);
      const error = new Error(authFailure
        ? "O Mercado Livre recusou a consulta autenticada (HTTP " + authFailure.status + "). Verifique a conexão da conta em Configurações."
        : "Nenhuma categoria retornou anúncios nesta atualização.");
      error.status = authFailure?.status || 502;
      throw error;
    }
    const unique = new Map();
    successful.forEach(item => {
      if (!item.id || !item.title || !item.permalink) return;
      const previous = unique.get(item.id);
      if (!previous || item.soldQuantity > previous.soldQuantity) unique.set(item.id, item);
    });
    const ranked = [...unique.values()].sort((a,b) => b.soldQuantity - a.soldQuantity || a.title.localeCompare(b.title, "pt-BR")).slice(0,5)
      .map((item,index) => ({ ...item, rank: index + 1 }));
    const payload = {
      date: dateKey, updatedAt: new Date().toISOString(), count: ranked.length,
      products: ranked, partial: failedCategories.length > 0, failedCategories,
      source: "Mercado Livre — API oficial de busca autenticada; categorias de interesse feminino ordenadas por sold_quantity_desc",
      methodology: "Até cinco anúncios com maior quantidade de vendas exibida entre as categorias consultadas. O campo sold_quantity pode ser apresentado em faixas referenciais; não representa vendas do dia nem garante conversão."
    };
    dailyPicksCache.set(dateKey, { createdAt: Date.now(), payload });
    res.json(payload);
  } catch (error) {
    console.error("[daily-picks]", error.message);
    res.status(error.status === 401 || error.status === 403 ? error.status : 502).json({
      error: error.message,
      action: "Verifique se a conta do Mercado Livre está conectada em Configurações e tente atualizar novamente."
    });
  }
});

app.get("/api/mercadolivre/discovery", async (_req, res) => {
  try {
    const token = await ensureMlToken();
    const response = await fetch("https://api.mercadolibre.com/trends/MLB", { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    const data = await response.json().catch(() => []);
    if (!response.ok) { const error = new Error(data.message || data.error || "Falha ao consultar tendências oficiais do Mercado Livre (HTTP " + response.status + ")."); error.status = response.status; throw error; }
    const classify = keyword => {
      const k = keyword.toLowerCase();
      if (/celular|smartphone|iphone|android|fone|headphone|notebook|tablet|computador|pc gamer|monitor|teclado|mouse|smartwatch|console|playstation|xbox|nintendo|placa de v[ií]deo/.test(k)) return "Tecnologia e games";
      if (/maquiagem|skincare|beleza|cabelo|unha|perfume|escova|secador|chapinha|creme|shampoo|hidratante/.test(k)) return "Beleza e cuidados pessoais";
      if (/bolsa|biqu[ií]ni|legging|academia|t[eê]nis|sapato|sand[aá]lia|vestido|blusa|cal[cç]a|joia|biju|acess[oó]rio|camiseta|roupa|rel[oó]gio/.test(k)) return "Moda e acessórios";
      if (/organizador|cozinha|decora[cç][aã]o|casa|pote|lumin[aá]ria|cama|mesa|banho|m[oó]vel|colch[aã]o|eletrodom[eé]stico/.test(k)) return "Casa e decoração";
      if (/carro|moto|autom[oó]vel|pneu|capacete|pe[cç]a automotiva|acess[oó]rio automotivo/.test(k)) return "Automotivo";
      if (/cachorro|gato|pet|ra[cç][aã]o|aqu[aá]rio/.test(k)) return "Pets";
      if (/beb[eê]|infantil|brinquedo|boneca|carrinho de beb[eê]|fralda/.test(k)) return "Bebês e brinquedos";
      if (/livro|papelaria|caderno|caneta|material escolar|curso/.test(k)) return "Livros e papelaria";
      if (/ferramenta|parafusadeira|furadeira|constru[cç][aã]o|jardim|grama|hidráulica|el[eé]trica/.test(k)) return "Ferramentas e construção";
      if (/suplemento|whey|creatina|halter|bicicleta|fitness|esporte|corrida/.test(k)) return "Esporte e fitness";
      return "Outros nichos";
    };
    const trends = (Array.isArray(data) ? data : [])
      .map((item, index) => ({ keyword: String(item.keyword || "").trim(), url: String(item.url || ""), trendRank: index + 1 }))
      .filter(item => item.keyword)
      .slice(0, 30)
      .map(item => ({
        id: "trend-" + item.trendRank + "-" + Buffer.from(item.keyword).toString("base64url").slice(0, 12),
        title: item.keyword,
        price: null,
        permalink: item.url || "https://lista.mercadolivre.com.br/" + encodeURIComponent(item.keyword),
        thumbnail: null,
        category: classify(item.keyword),
        trendRank: item.trendRank,
        trendType: item.trendRank <= 10 ? "Top 10" : item.trendRank <= 30 ? "Top 30" : "Popular",
        sourceType: "mercadolivre_weekly_trend",
        isTrend: true
      }));
    res.json({ products: trends, updatedAt: new Date().toISOString(), source: "API oficial de Tendências do Mercado Livre", rankingScope: "Todos os nichos", scoring: "A posição corresponde à ordem recebida da lista oficial; não representa volume, crescimento, vendas ou conversão.", note: "Tendências são sinais para pesquisa, não anúncios de produtos." });
  } catch(e) {
    const status = e.status === 401 ? 401 : e.status === 403 ? 403 : 502;
    res.status(status).json({ error: status === 401 ? "A autorização do Mercado Livre expirou ou não está ativa neste servidor. Reconecte a conta em Configurações." : e.message || "Falha no garimpo de tendências do Mercado Livre." });
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
app.get("/api/gemini/status", requireDashboardToken, async (_req, res) => {
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
      "Você é estrategista sênior de conteúdo, conversão e SEO para marketing de afiliados no Brasil, trabalhando para a Vitrine Certa.",
      "Entregue um pacote editorial pronto para a pessoa gravar e editar o vídeo por conta própria. Você NÃO grava, edita nem publica vídeos.",
      "Escreva em português brasileiro, com linguagem natural, específica, clara e persuasiva, sem exageros, clichês ou introdução genérica.",
      "REGRA DE CONFIABILIDADE: não invente nem transforme em fato características, composição, espessura, opacidade, conforto, caimento, durabilidade, benefícios, compatibilidade, avaliações, vendas, descontos, preço atual, comissão, estoque, escassez, prazo de entrega ou experiência pessoal. O nome comercial do produto e palavras promocionais do anúncio (por exemplo, 'zero transparência', 'premium' ou 'não marca') NÃO são comprovação independente.",
      "Use somente fatos explicitamente fornecidos nos dados do produto e nas informações adicionais. Se um atributo não estiver comprovado, trate-o como ponto a verificar e formule a fala como pergunta, hipótese ou demonstração a ser feita pela pessoa antes de publicar. Nunca escreva 'testei', 'usei', 'aprovei' ou 'comprovei' se isso não foi informado.",
      "Se não houver informação suficiente para sustentar uma promessa, mude o ângulo: apresente o produto, mostre detalhes observáveis, explique o que conferir no anúncio e convide o público a comparar. Não invente dados para preencher lacunas.",
      "PREÇO E OFERTA: se houver preço informado, identifique-o como preço fornecido e sujeito a alteração; não diga que está barato, em promoção ou com desconto sem preço de comparação e comprovação. Não crie urgência artificial. Recomende conferir o valor final, frete, vendedor e disponibilidade no link antes de publicar. Se o preço não foi informado, não inclua valor.",
      "ROTEIRO: crie gancho forte nos primeiros 2 segundos, mas fiel aos fatos. Entregue todas as falas/narração completas, separadas do texto na tela. Inclua demonstração que possa ser realmente filmada com celular, sem pressupor que a pessoa possui o produto ou já o testou. Quando o produto não estiver em mãos, proponha roteiro baseado em pesquisa do anúncio e imagens permitidas, sem fingir demonstração própria.",
      "STORYBOARD: a soma das cenas deve corresponder exatamente à duração total sugerida. Informe início, fim e duração de cada cena; não deixe lacunas nem sobreposições. A narração de cada cena deve corresponder ao roteiro falado naquele intervalo. Para cada cena inclua enquadramento, ação filmável, movimento de câmera, texto na tela e áudio/efeito opcional. Use instruções práticas, específicas e executáveis com celular.",
      "SEO: não prometa viralização, alcance ou posição no ranking. Use palavras-chave com intenção de busca e compra, naturalmente, sem repetição artificial. Não invente especificações para inserir palavras-chave. Hashtags poucas, específicas e relevantes.",
      "Organize obrigatoriamente a resposta com estas seções e nesta ordem:",
      "1. ÂNGULO E OBJETIVO: público provável (identifique como hipótese quando não houver dados), necessidade que o produto pode atender, fatos confirmados, pontos ainda não confirmados e objetivo editorial.",
      "2. ROTEIRO DE GRAVAÇÃO: duração total, gancho nos primeiros 2 segundos, falas/narração completas com marcação de tempo, desenvolvimento e CTA. Separe claramente FALA/NARRAÇÃO e TEXTO NA TELA.",
      "3. STORYBOARD CENA A CENA: tabela com início/fim, duração, enquadramento, o que filmar, ação/câmera, texto na tela, fala/narração e áudio. Os tempos precisam bater com o roteiro e somar a duração total.",
      "4. SEO POR PLATAFORMA: TikTok, Instagram Reels e YouTube Shorts, cada um com título/gancho, descrição pronta, palavra-chave principal, palavras-chave secundárias e hashtags. Adapte a intenção e o texto para cada plataforma.",
      "5. LEGENDA E CTA: legenda pronta para copiar, CTA claro e aviso transparente de link de afiliado. Não inclua placeholders como [SEU LINK] se o link fornecido puder ser usado; se não houver link, indique objetivamente onde inserir.",
      "6. CHECKLIST ANTES DE PUBLICAR: validar atributos, tamanho/medidas, material, preço, frete, vendedor, avaliações, disponibilidade, link e regras da plataforma; listar expressamente qualquer alegação do roteiro que dependa de confirmação.",
      "Faça uma checagem final antes de responder: (a) cada afirmação factual está sustentada pelos dados? (b) nenhuma experiência pessoal foi inventada? (c) storyboard e roteiro têm tempos coerentes? (d) preço e oferta não foram tratados como atuais sem confirmação? Corrija qualquer falha antes de entregar.",
      "Formato ou plataforma priorizada: " + format,
      "Produto: " + product,
      "Preço informado pelo cadastro (não presumir que ainda está vigente): " + (price || "não informado"),
      "Link de afiliado fornecido: " + (link || "não informado"),
      "Informações adicionais fornecidas pelo usuário: " + (details || "nenhuma")
    ].join("\n");
    const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent";
    const requestBody = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 5000, thinkingConfig: { thinkingLevel: "low" } }
    });
    let response, data = {};
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const requestTimeout = setTimeout(() => controller.abort(), 70000);
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
          return res.status(504).json({ error: "O Gemini não respondeu em 70 segundos. A solicitação foi encerrada; tente novamente." });
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
    res.json({ text, model: "gemini-3.1-flash-lite-preview" });
  } catch (e) { console.error("Gemini generation failed:", e); res.status(502).json({ error: "Falha na comunicação com o serviço de IA: " + (e.message || "erro desconhecido") }); }
});

app.get("/api/dashboard/state", requireDashboardToken, async (_req, res) => {
  if (!db) return res.status(503).json({ error: "Banco de dados não configurado." });
  try {
    const result = await db.query("SELECT state, updated_at FROM dashboard_state WHERE id = 1");
    if (!result.rows.length) return res.json({ exists: false, state: null, updatedAt: null });
    return res.json({ exists: true, state: result.rows[0].state, updatedAt: result.rows[0].updated_at });
  } catch (error) {
    console.error("[Dashboard state GET]", error.message);
    return res.status(500).json({ error: "Não foi possível carregar os dados salvos." });
  }
});
app.put("/api/dashboard/state", requireDashboardToken, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Banco de dados não configurado." });
  const state = req.body?.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return res.status(400).json({ error: "Estado do painel inválido." });
  if (!Array.isArray(state.products) || state.products.length > 2000) return res.status(400).json({ error: "Lista de produtos inválida ou acima do limite." });
  if (state.metricEntries !== undefined && (!Array.isArray(state.metricEntries) || state.metricEntries.length > 5000)) return res.status(400).json({ error: "Histórico de resultados inválido ou acima do limite." });
  if (!state.metrics || typeof state.metrics !== "object" || !state.calendar || typeof state.calendar !== "object" || !state.settings || typeof state.settings !== "object") return res.status(400).json({ error: "Dados de resultados, calendário ou configurações inválidos." });
  try {
    const payload = JSON.stringify({ products: state.products, metrics: state.metrics, calendar: state.calendar, settings: state.settings, campaigns: Array.isArray(state.campaigns) ? state.campaigns.slice(0, 500) : [], metricEntries: Array.isArray(state.metricEntries) ? state.metricEntries.slice(0, 5000) : [], commissionGoal: state.commissionGoal && typeof state.commissionGoal === "object" ? state.commissionGoal : null, updatedAt: new Date().toISOString() });
    if (Buffer.byteLength(payload, "utf8") > 900000) return res.status(413).json({ error: "Os dados do painel excedem o limite permitido." });
    const result = await db.query("INSERT INTO dashboard_state (id, state, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW() RETURNING updated_at", [payload]);
    return res.json({ saved: true, updatedAt: result.rows[0].updated_at });
  } catch (error) {
    console.error("[Dashboard state PUT]", error.message);
    return res.status(500).json({ error: "Não foi possível salvar os dados no banco." });
  }
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
