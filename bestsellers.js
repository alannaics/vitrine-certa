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
        return {
          id, position, title: item.title || item.name || null,
          image: picture?.secure_url || picture?.url || item.secure_thumbnail || null,
          price: item.price ?? item.buy_box_winner?.price ?? null,
          url: item.permalink || null
        };
      }));
      res.json({ products: products.filter(Boolean).sort((a, b) => a.position - b.position) });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerBestsellers };
