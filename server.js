const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

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

app.get("/api/status", (_req, res) => {
  res.json({
    shopee: { configured: Boolean(APP_ID && APP_SECRET) },
    mercadoLivre: { mode: "manual", note: "Links e relatórios devem ser inseridos pelo painel oficial; não há API pública de afiliados confirmada para esta integração." }
  });
});

app.post("/api/shopee/short-link", async (req, res) => {
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

app.get("/api/shopee/products", async (req, res) => {
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

app.get("/api/shopee/conversions", async (req, res) => {
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

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log("Vitrine Certa API listening on " + PORT));
