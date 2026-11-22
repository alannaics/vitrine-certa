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
      const listing = category && !winner.category_id && categoryId.test(listingId)
        ? await get("/items/" + listingId, token).catch(() => ({})) : {};
      if (!await inCategory(winner.category_id || listing.category_id || item.category_id || row.category_id)) return null;
      const picture = item.pictures?.[0] || row.pictures?.[0];
      const price = priceInReais(winner.price, winner.currency_id) ?? priceInReais(listing.price, listing.currency_id);
      const sale = price === null && categoryId.test(listingId)
        ? await get("/items/" + listingId + "/sale_price?context=channel_marketplace", token).catch(() => null)
        : null;
      return {
        id: row.id,
        title: listing.title || item.name || row.name,
        image: picture?.secure_url || picture?.url || listing.secure_thumbnail || winner.thumbnail || null,
        price: price ?? (sale?.currency_id === "BRL" ? priceInReais(sale.amount, "BRL") : null),
        originalPrice: sale?.currency_id === "BRL" ? priceInReais(sale.regular_amount, "BRL") : priceInReais(winner.original_price, winner.currency_id),
        installments: installmentsInReais(winner.installments || listing.installments),
        url: listing.permalink || winner.permalink || "https://www.mercadolivre.com.br/p/" + row.id
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
      try {
        const data = await get("/sites/MLB/search?" + params, token);
        const products = (data.results || []).filter(row => categoryId.test(row.id) && row.title).map(row => ({
          id: row.id, title: row.title, image: row.thumbnail || null, url: row.permalink || null,
          price: priceInReais(row.price, row.currency_id),
          originalPrice: priceInReais(row.original_price, row.currency_id),
          installments: installmentsInReais(row.installments)
        }));
        return res.json({ products, source: "marketplace" });
      } catch (error) {
        if (![401, 403, 404].includes(error.status)) throw error;
      }
      const products = await searchCatalog(term, category, token);
      res.json({ products, source: "catalog" });
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
      const ranking = await get("/highlights/MLB/category/" + category, token);
      const products = await Promise.all((ranking.content || []).slice(0, 20).map(async entry => {
        const { id, position, type } = entry;
        if (!Object.hasOwn(endpoints, type) || !/^MLBU?\d+$/.test(id) || !Number.isInteger(position)) return null;
        const item = await get("/" + endpoints[type] + "/" + id, token).catch(() => ({}));
        const picture = item.pictures?.[0];
        const winner = item.buy_box_winner;
        const listingId = type === "ITEM" && /^MLB\d+$/.test(id) ? id : winner?.item_id;
        const sale = /^MLB\d+$/.test(listingId)
          ? await get("/items/" + listingId + "/sale_price?context=channel_marketplace", token).catch(() => null)
          : null;
        return {
          id, position, title: item.title || item.name || null,
          image: picture?.secure_url || picture?.url || item.secure_thumbnail || null,
          price: (sale?.currency_id === "BRL" ? sale.amount : null) ?? item.price ?? winner?.price ?? null,
          originalPrice: sale?.currency_id === "BRL" ? priceInReais(sale.regular_amount, "BRL") : priceInReais(item.original_price, item.currency_id),
          installments: installmentsInReais(item.installments || winner?.installments),
          url: item.permalink || (type === "PRODUCT" ? "https://www.mercadolivre.com.br/p/" + id : null)
        };
      }));
      res.json({ products: products.filter(Boolean).sort((a, b) => a.position - b.position) });
    } catch (error) {
      if (error.status === 404) return res.json({ products: [] });
      handleError(res, error);
    }
  });
}

module.exports = { registerBestsellers };
