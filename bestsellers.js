const api = "https://api.mercadolibre.com";
const endpoints = { ITEM: "items", PRODUCT: "products", USER_PRODUCT: "user-products" };
const categoryId = /^MLB\d+$/;

function registerBestsellers(app, authenticate, ensureToken) {
  async function get(endpoint, token) {
    const response = await fetch(api + endpoint, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      signal: AbortSignal.timeout(6500)
    });
    if (!response.ok) {
      const error = new Error("O Mercado Livre retornou HTTP " + response.status + ".");
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  function handleError(res, error) {
    const accessDenied = [401, 403].includes(error.status);
    res.status(accessDenied ? 403 : 502).json({
      error: accessDenied
        ? "O Mercado Livre recusou o acesso. Confira a autorização em Integrações."
        : error.status ? error.message : "Não foi possível consultar o Mercado Livre agora."
    });
  }

  app.get("/api/mercadolivre/categories", authenticate, async (req, res) => {
    const parent = req.query.parent;
    if (parent !== undefined && (typeof parent !== "string" || !categoryId.test(parent))) {
      return res.status(400).json({ error: "Categoria inválida." });
    }
    try {
      const token = await ensureToken();
      const data = await get(parent ? "/categories/" + parent : "/sites/MLB/categories", token);
      const categories = parent ? data.children_categories : data;
      res.json({ categories: (categories || []).filter(entry => categoryId.test(entry.id) && entry.name)
        .map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")) });
    } catch (error) {
      handleError(res, error);
    }
  });

  async function publicCatalogPrice(id) {
    // Read structured price data only from the exact public product page.
    try {
      const response = await fetch("https://www.mercadolivre.com.br/p/" + id, {
        headers: { Accept: "text/html" }, redirect: "manual", signal: AbortSignal.timeout(3500)
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html") || !response.body) return null;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let html = "";
      try {
        while (html.length < 1_500_000) {
          const { value, done } = await reader.read();
          if (done) {
            html += decoder.decode();
            break;
          }
          html += decoder.decode(value, { stream: true });
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return structuredCatalogPrice(html, id);
    } catch {
      return null;
    }
  }

  function hasStock(item) {
    return item?.status === "active" && Number(item.available_quantity) > 0 &&
      !item.sub_status?.includes("out_of_stock") && typeof item.permalink === "string" &&
      /^https:\/\/(?:[\w-]+\.)?mercadolivre\.com\.br\//i.test(item.permalink);
  }

  async function searchCatalog(term, category, token) {
    const params = new URLSearchParams({ site_id: "MLB", status: "active", q: term, limit: "20" });
    const data = await get("/products/search?" + params, token);
    const categoryChecks = new Map();
    async function inCategory(id) {
      if (!category) return true;
      if (id === category) return true;
      if (!categoryId.test(id)) return false;
      if (!categoryChecks.has(id)) categoryChecks.set(id,
        get("/categories/" + id, token).then(row => row.path_from_root?.some(entry => entry.id === category)).catch(() => false));
      return categoryChecks.get(id);
    }
    const results = await Promise.all((data.results || []).slice(0, 20).map(async row => {
      if (!categoryId.test(row.id)) return null;
      const item = row.buy_box_winner && row.pictures?.length
        ? row : await get("/products/" + row.id, token).catch(() => row);
      const winner = item.buy_box_winner || row.buy_box_winner || {};
      const listingId = winner.item_id;
      if (!categoryId.test(listingId)) return null;
      const listing = await get("/items/" + listingId, token).catch(() => null);
      if (!hasStock(listing)) return null;
      if (!await inCategory(winner.category_id || listing.category_id || item.category_id || row.category_id)) return null;
      const picture = item.pictures?.[0] || row.pictures?.[0];
      const price = priceInReais(winner.price, winner.currency_id) ?? priceInReais(listing.price, listing.currency_id);
      const sale = price === null && categoryId.test(listingId)
        ? await get("/items/" + listingId + "/sale_price?context=channel_marketplace", token).catch(() => null)
        : null;
      const apiPrice = price ?? (sale?.currency_id === "BRL" ? priceInReais(sale.amount, "BRL") : null);
      const publicPrice = apiPrice === null ? await publicCatalogPrice(row.id) : null;
      return {
        id: row.id, type: "PRODUCT",
        title: listing.title || item.name || row.name,
        image: picture?.secure_url || picture?.url || listing.secure_thumbnail || winner.thumbnail || null,
        price: apiPrice ?? publicPrice,
        priceSource: publicPrice !== null ? "product-page" : null,
        originalPrice: sale?.currency_id === "BRL" ? priceInReais(sale.regular_amount, "BRL") : priceInReais(winner.original_price, winner.currency_id),
        installments: installmentsInReais(winner.installments || listing.installments),
        url: listing.permalink
      };
    }));
    return results.filter(row => row?.title);
  }

  function priceInReais(value, currency) {
    return Number.isFinite(value) && value > 0 && (!currency || currency === "BRL") ? value : null;
  }

  function installmentsInReais(value) {
    if (!Number.isInteger(value?.quantity) || value.quantity < 2) return null;
    const amount = priceInReais(value.amount, value.currency_id);
    return amount === null ? null : { quantity: value.quantity, amount };
  }

  app.get("/api/mercadolivre/search", authenticate, async (req, res) => {
    const term = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const { category } = req.query;
    if (!term || (category !== undefined && (typeof category !== "string" || !categoryId.test(category)))) {
      return res.status(400).json({ error: "Informe uma palavra-chave e confira a categoria." });
    }
    try {
      const token = await ensureToken();
      const params = new URLSearchParams({ q: term, limit: "20" });
      if (category) params.set("category", category);
      if (["price_asc", "price_desc"].includes(req.query.sort)) params.set("sort", req.query.sort);
      try {
        const data = await get("/sites/MLB/search?" + params, token);
        const products = await Promise.all((data.results || []).filter(row => categoryId.test(row.id) && row.title).map(async row => {
          const listing = await get("/items/" + row.id, token).catch(() => null);
          if (!hasStock(listing)) return null;
          return {
          id: row.id, type: "ITEM", title: row.thumbnail || null, url: listing.permalink,
          price: priceInReais(row.price, row.currency_id) ?? priceInReais(listing.price, listing.currency_id),
          originalPrice: priceInReais(row.original_price, row.currency_id),
          installments: installmentsInReais(row.installments)
          };
        }));
        const confirmed = products.filter(Boolean);
        if (confirmed.length || !data.results?.length) return res.json({ products: confirmed, source: "marketplace" });
      } catch (error) {
        if (![401, 403, 404].includes(error.status)) throw error;
      }
      const products = await searchCatalog(term, category, token);
      res.json({ products, source: "catalog" });
    } catch (error) {
      handleError(res, error);
    }
  });

  async function categoryRanking(category, token) {
    const ranking = await get("/highlights/MLB/category/" + category, token);
    return (ranking.content || []).slice(0, 20).sort((a, b) => a.position - b.position);
  }

  async function productDetails(entry, token, lookupPrice = true) {
    const { id, position, type } = entry;
    if (!Object.hasOwn(endpoints, type) || !/^MLBU?\d+$/.test(id) || !Number.isInteger(position)) return null;
    const item = await get("/" + endpoints[type] + "/" + id, token).catch(() => ({}));
    const picture = item.pictures?.[0];
    const winner = item.buy_box_winner;
    const listingId = type === "ITEM" && /^MLB\d+$/.test(id) ? id : winner?.item_id;
    if (!categoryId.test(listingId)) return null;
    const listing = type === "ITEM" ? item : await get("/items/" + listingId, token).catch(() => null);
    if (!hasStock(listing)) return null;
    const sale = lookupPrice && priceInReais(listing.price, listing.currency_id) === null
      ? await get("/items/" + listingId + "/sale_price?context=channel_marketplace", token).catch(() => null)
      : null;
    const apiPrice = (sale?.currency_id === "BRL" ? priceInReais(sale.amount, "BRL") : null)
      ?? priceInReais(listing.price, listing.currency_id) ?? priceInReais(winner?.price, winner?.currency_id);
    const publicPrice = lookupPrice && apiPrice === null && type === "PRODUCT" ? await publicCatalogPrice(id) : null;
    return {
      id, position, type, listingId, title: item.title || item.name || null,
      image: picture?.secure_url || picture?.url || item.secure_thumbnail || null,
      price: apiPrice ?? publicPrice,
      priceSource: publicPrice !== null ? "product-page" : null,
      originalPrice: sale?.currency_id === "BRL" ? priceInReais(sale.regular_amount, "BRL") : priceInReais(item.original_price, item.currency_id),
      installments: installmentsInReais(item.installments || winner?.installments),
      url: listing.permalink
    };
  }

  const collectionCategories = [
    "Beleza e Cuidado Pessoal", "Casa, Móveis e Decoração", "Calçados, Roupas e Bolsas",
    "Eletrônicos, Áudio e Vídeo", "Esportes e Fitness", "Celulares e Telefones", "Ferramentas"
  ];
  let selectionCache = null;
  let pendingSelection = null;

  async function buildSelection(token) {
    const categories = (await get("/sites/MLB/categories", token))
      .filter(category => collectionCategories.includes(category.name) && categoryId.test(category.id));
    const lists = await Promise.all(categories.map(async category => {
      try {
        const entries = await categoryRanking(category.id, token);
        return entries.map(entry => ({ ...entry, category: category.name }));
      } catch {
        return [];
      }
    }));
    const candidates = new Map();
    for (let position = 0; position < 20; position++) {
      for (const list of lists) {
        const entry = list[position];
        if (entry && !candidates.has(entry.id)) candidates.set(entry.id, entry);
      }
    }
    const products = [];
    const ordered = [...candidates.values()];
    const listings = new Set();
    for (let i = 0; i < ordered.length && products.length < 100; i += 20) {
      const batch = await Promise.all(ordered.slice(i, i + 20).map(async entry => {
        const row = await productDetails(entry, token);
        return row?.title ? { ...row, category: entry.category } : null;
      }));
      for (const product of batch.filter(Boolean)) {
        if (listings.has(product.listingId)) continue;
        listings.add(product.listingId);
        products.push(product);
      }
    }
    return { products: products.slice(0, 100), updatedAt: new Date().toISOString() };
  }

  app.get("/api/mercadolivre/selection", authenticate, async (_req, res) => {
    if (selectionCache && Date.now() - Date.parse(selectionCache.updatedAt) < 60 * 1000) {
      return res.json(selectionCache);
    }
    try {
      if (!pendingSelection) {
        pendingSelection = ensureToken().then(buildSelection).then(result => {
          selectionCache = result;
          return result;
        }).finally(() => { pendingSelection = null; });
      }
      res.json(await pendingSelection);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/mercadolivre/selection-price", authenticate, async (req, res) => {
    const { id, type } = req.query;
    if (typeof id !== "string" || !/^MLBU?\d+$/.test(id) || typeof type !== "string" || !Object.hasOwn(endpoints, type)) {
      return res.status(400).json({ error: "Identificação do produto inválida." });
    }
    try {
      const row = await productDetails({ id, type, position: 0 }, await ensureToken());
      res.json({ price: row?.price ?? null, available: Boolean(row) });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/mercadolivre/bestsellers", authenticate, async (req, res) => {
    const category = req.query.category;
    if (typeof category !== "string" || !categoryId.test(category)) {
      return res.status(400).json({ error: "Escolha uma categoria do Mercado Livre." });
    }
    try {
      const token = await ensureToken();
      const ranking = await categoryRanking(category, token);
      const products = await Promise.all(ranking.map(entry => productDetails(entry, token)));
      res.json({ products: products.filter(Boolean).sort((a, b) => a.position - b.position) });
    } catch (error) {
      if (error.status === 404) return res.json({ products: [] });
      handleError(res, error);
    }
  });
}

function structuredCatalogPrice(html, id) {
  if (!/^MLB\d+$/.test(id)) return null;
  const productId = value => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== "www.mercadolivre.com.br") return "";
      return url.pathname.match(/\/p\/(MLB\d+)(?:\/|$)/)?.[1] || "";
    } catch {
      return "";
    }
  };
  for (const [, payload] of html.matchAll(/<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(payload);
      const nodes = (Array.isArray(data) ? data : [data]).flatMap(node => [node, ...(Array.isArray(node?.["@graph"]) ? node["@graph"] : [])]);
      for (const node of nodes) {
        if (![].concat(node?.["@type"]).includes("Product") ||
            ![node.url, node["@id"]].some(value => productId(value) === id)) continue;
        for (const offer of [].concat(node.offers || [])) {
          if (offer?.["@type"] !== "Offer" || offer.priceCurrency !== "BRL" ||
              /(?:OutOfStock|SoldOut|Discontinued)$/i.test(offer.availability || "")) continue;
          const price = Number(offer.price);
          if (Number.isFinite(price) && price > 0) return price;
        }
      }
    } catch {
      // Other structured-data blocks may still be usable.
    }
  }
  return null;
}

module.exports = { registerBestsellers, structuredCatalogPrice };
