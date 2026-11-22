const categoryPath = $("categoryPath");
const rankingStatus = $("rankingStatus");
const rankingCards = $("rankingCards");
let rankingVersion = 0;
let pendingEstimates = [];
let selectedProduct = null;
let shareText = "";

function savedLink(id) {
  try { return localStorage.getItem("vcAffiliateLink:" + id) || ""; }
  catch { return ""; }
}

function officialLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      (url.hostname === "meli.la" || url.hostname === "mercadolivre.com.br" ||
       url.hostname.endsWith(".mercadolivre.com.br"));
  } catch { return false; }
}

function renderBars(id, data, format, empty) {
  const root = $(id);
  root.replaceChildren();
  if (!data.length) {
    root.textContent = empty;
    return;
  }
  const max = Math.max(...data.map(point => point.value));
  for (const point of data) {
    const row = document.createElement("div");
    row.className = "chart-row";
    const label = document.createElement("div");
    label.className = "chart-label";
    const name = document.createElement("span");
    name.textContent = point.label;
    const amount = document.createElement("strong");
    amount.textContent = format(point.value);
    label.append(name, amount);
    const track = document.createElement("div");
    track.className = "chart-track";
    track.setAttribute("aria-hidden", "true");
    const bar = document.createElement("div");
    bar.className = "chart-fill";
    bar.style.width = (100 * point.value / max) + "%";
    track.append(bar);
    row.append(label, track);
    root.append(row);
  }
}

function categorySelect(categories, label, first = "") {
  const select = document.createElement("select");
  select.className = "field";
  select.setAttribute("aria-label", label);
  select.add(new Option(label === "Categoria" ? "Todas as categorias" : label, ""));
  for (const { id, name } of categories) select.add(new Option(name, id));
  select.value = first;
  categoryPath.append(select);
}

function secureMarketplaceUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && [ "mercadolivre.com.br", "mlstatic.com" ]
      .some(host => url.hostname === host || url.hostname.endsWith("." + host))) return url.href;
  } catch {}
  return "";
}

function rankingCard(product, category) {
  const card = document.createElement("article");
  card.className = "offer";
  const imageUrl = secureMarketplaceUrl(product.image?.replace(/^http:/, "https:"));
  const url = secureMarketplaceUrl(product.url);
  if (imageUrl) {
    const photo = document.createElement("div");
    photo.className = "photo";
    const image = new Image();
    image.src = imageUrl;
    image.alt = "";
    image.loading = "lazy";
    image.onerror = () => photo.remove();
    if (url) {
      const imageLink = document.createElement("a");
      imageLink.className = "photo";
      imageLink.href = url;
      imageLink.target = "_blank";
      imageLink.rel = "noopener noreferrer";
      imageLink.setAttribute("aria-label", "Abrir " + product.title + " no Mercado Livre");
      imageLink.append(image);
      image.onerror = () => imageLink.remove();
      card.append(imageLink);
    } else {
      photo.append(image);
      card.append(photo);
    }
  }
  const body = document.createElement("div");
  body.className = "offerbody";
  const rank = document.createElement("small");
  rank.textContent = product.position ? product.position + "º no ranking oficial" : "";
  const title = document.createElement("strong");
  title.textContent = product.title || product.id + " · detalhes indisponíveis";
  if (product.freeShipping) { const shipping = document.createElement("small"); shipping.textContent = "Frete grátis"; body.append(shipping); }
  if (product.position) {
    if (product.category) rank.textContent += " · " + product.category;
    body.append(rank);
  }
  body.append(title);
  if (product.price != null) {
    const price = document.createElement("div");
    price.className = "price";
    price.textContent = currency(product.price);
    body.append(price);
    if (product.priceSource === "product-page") {
      const source = document.createElement("small");
      source.textContent = "Preço consultado na página do produto";
      body.append(source);
    }
    if (product.originalPrice > product.price) {
      const discount = document.createElement("small");
      const percent = Math.round((1 - product.price / product.originalPrice) * 100);
      discount.textContent = "De " + currency(product.originalPrice) + (percent > 0 ? " · " + percent + "% OFF" : "");
      body.append(discount);
    }
    if (product.installments) {
      const note = document.createElement("small");
      note.textContent = product.installments.quantity + "× de " + currency(product.installments.amount);
      body.append(note);
    }
  }
  if (product.price == null && product.title) {
    const note = document.createElement("small");
    note.textContent = "Preço disponível no anúncio";
    body.append(note);
    pendingEstimates.push({ id: product.id, title: product.title, note });
  }
  if (url) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Ver no Mercado Livre";
    body.append(link);
  }
  if (product.title) {
    const create = document.createElement("button");
    create.className = "btn secondary";
    create.type = "button";
    create.textContent = "Criar conteúdo";
    create.onclick = () => {
      selectedProduct = { ...product, category: product.category || category };
      $("creativeProduct").value = product.title;
      $("creativePrice").value = product.price ?? "";
      refreshCreativePrice(selectedProduct);
      $("creativeLink").value = savedLink(product.id);
      $("creativeImage").value = imageUrl;
      $("openSavedDrafts").hidden = true;
      $("creativeOutput").hidden = true;
      $("creativeStatus").textContent = "";
      tab("creative");
      $("creativeProduct").focus();
    };
    body.append(create);
  }
  card.append(body);
  return card;
}

async function refreshCreativePrice(product) {
  const input = $("creativePrice");
  const status = $("creativePriceStatus");
  status.textContent = "";
  if (input.value || !product.type || !authToken) return;
  status.textContent = "Consultando o preço do anúncio…";
  try {
    const { price } = await request("/api/mercadolivre/selection-price?id=" + encodeURIComponent(product.id) + "&type=" + encodeURIComponent(product.type));
    if (selectedProduct !== product) return;
    if (price > 0 && !input.value) input.value = price.toFixed(2);
  } catch {
    if (selectedProduct !== product) return;
  }
  if (selectedProduct === product) status.textContent = input.value
    ? "Confira o valor no anúncio antes de divulgar."
    : "Você pode gerar conteúdo sem citar preço. O público confere o valor no anúncio.";
}

async function loadRanking() {
  const current = ++rankingVersion;
  rankingCards.replaceChildren();
  pendingEstimates = [];
  $("estimatedPricesStatus").textContent = "";
  $("estimateMore").hidden = true;
  $("missingPrices").hidden = true;
  rankingStatus.textContent = "Consultando o Mercado Livre…";
  try {
    if (!authToken) throw Error("Valide o acesso administrativo em Integrações.");
    if (!categoryPath.children.length) {
      const { categories } = await request("/api/mercadolivre/categories");
      if (current !== rankingVersion) return;
      if (!categories.length) throw Error("O Mercado Livre não retornou categorias.");
      categorySelect(categories, "Categoria");
    }
    const selection = [...categoryPath.querySelectorAll("select")].findLast(select => select.value);
    const category = encodeURIComponent(selection?.value || "");
    const categoryName = selection?.selectedOptions[0].text;
    const term = $("intelligenceTerm").value.trim();
    const sort = $("intelligenceSort").value;
    const ranked = !term || sort === "bestsellers";
    if (category) request("/api/mercadolivre/categories?parent=" + category).then(detail => {
      if (current === rankingVersion && detail.categories.length && !selection.nextElementSibling) {
        categorySelect(detail.categories, "Escolher subcategoria");
      }
    }).catch(() => {});
    const automatic = !category && (!term || sort === "bestsellers");
    const marketplaceSort = { priceAsc: "price_asc", priceDesc: "price_desc" }[sort];
    const path = automatic ? "/api/mercadolivre/selection"
      : ranked ? "/api/mercadolivre/bestsellers?category=" + category
      : "/api/mercadolivre/search?q=" + encodeURIComponent(term) + (category ? "&category=" + category : "") +
        (marketplaceSort ? "&sort=" + marketplaceSort : "");
    const response = await request(path);
    if (current !== rankingVersion) return;
    let products = response.products;
    if (ranked && term) {
      const normalize = text => (text || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
      const words = normalize(term).split(/\s+/);
      products = products.filter(product => words.every(word => normalize(product.title).includes(word)));
    }
    const min = $("minDiscoveryPrice").value;
    const max = $("maxDiscoveryPrice").value;
    if (min && max && Number(min) > Number(max)) throw Error("O preço máximo deve ser maior ou igual ao mínimo.");
    if ($("discoveryFreeShipping").checked) products = products.filter(product => product.freeShipping);
    if (min || max) products = products.filter(product => product.price > 0 &&
      (!min || product.price >= Number(min)) && (!max || product.price <= Number(max)));
    let missing = 0;
    if (sort === "priceAsc" || sort === "priceDesc") {
      const direction = sort === "priceAsc" ? 1 : -1;
      const priced = products.filter(product => Number.isFinite(product.price) && product.price > 0);
      missing = products.length - priced.length;
      products = priced.sort((a, b) => direction * (a.price - b.price));
      if (missing) {
        $("openMarketplaceSearch").href = "https://lista.mercadolivre.com.br/" + encodeURIComponent(term || categoryName);
        $("missingPrices").hidden = false;
      }
    }
    const source = automatic ? "Seleção automática · Anúncios disponíveis" : ranked ? "Top 20 oficial · " + categoryName
      : response.source === "catalog" ? "Catálogo do Mercado Livre" : "Busca do Mercado Livre";
    rankingStatus.textContent = products.length
      ? source + " · " + products.length + " resultado(s)" + (ranked && term ? " no ranking para esta palavra-chave" : "")
      : ranked ? source + " · Nenhum produto encontrado. Tente outra palavra-chave ou subcategoria."
      : source + " · Nenhum produto encontrado. Tente outra palavra-chave ou categoria.";
    if (!products.length && !missing) rankingStatus.textContent = source + " · Nenhum anúncio confirmado atende a esta busca e aos filtros.";
    if (missing) rankingStatus.textContent = source + " · " + products.length + " com preço consultado. " + missing + " sem preço ficam na lista por relevância.";
    rankingCards.append(...products.map(product => rankingCard(product, categoryName)));
    if (pendingEstimates.length) estimatePrices(current);
  } catch (error) {
    if (current === rankingVersion) rankingStatus.textContent = error.message;
  }
}

categoryPath.onchange = ({ target }) => {
  while (target.nextElementSibling) target.nextElementSibling.remove();
  loadRanking();
};
async function estimatePrices(version) {
  const status = $("estimatedPricesStatus");
  const button = $("estimateMore");
  const batch = pendingEstimates.splice(0, 12);
  if (!batch.length) return;
  button.hidden = true;
  status.textContent = "Consultando faixas de preço estimadas por IA…";
  try {
    const { estimates } = await request("/api/gemini/estimate-prices", {
      method: "POST", body: JSON.stringify({ items: batch.map(({ id, title }) => ({ id, title })) })
    });
    if (version !== rankingVersion) return;
    for (const { id, note } of batch) {
      const estimate = estimates[id];
      if (estimate) note.textContent = "Preço estimado (IA) · " + currency(estimate.minPrice) + " a " + currency(estimate.maxPrice);
    }
    status.textContent = Object.keys(estimates).length
      ? "As faixas de IA são referências. Confira o valor real no anúncio."
      : "A IA não retornou uma faixa para esses produtos.";
  } catch (error) {
    if (version !== rankingVersion) return;
    pendingEstimates.unshift(...batch);
    status.textContent = error.message;
  }
  button.hidden = pendingEstimates.length === 0;
}

$("estimateMore").onclick = () => estimatePrices(rankingVersion);
$("discoveryFilters").onsubmit = event => {
  event.preventDefault();
  loadRanking();
};
$("rankingRefresh").onclick = loadRanking;
$("showSelection").onclick = () => {
  $("intelligenceTerm").value = "";
  $("intelligenceSort").value = "relevance";
  const root = categoryPath.querySelector("select");
  if (root) {
    root.value = "";
    while (root.nextElementSibling) root.nextElementSibling.remove();
  }
  loadRanking();
};
$("intelligenceForm").onsubmit = event => {
  event.preventDefault();
  loadRanking();
};
$("intelligenceSort").onchange = loadRanking;
$("showRelevant").onclick = () => {
  $("intelligenceSort").value = "relevance";
  loadRanking();
};
$("rankingAccess").onclick = () => tab("settings");
$("creativeAccess").onclick = () => tab("settings");

$("openSavedDrafts").onclick = () => $("manageDrafts").click();

$("creativeSaveDraft").onclick = async () => {
  const form = $("creativeForm");
  const status = $("creativeStatus");
  if (!form.reportValidity()) return;
  if (!authToken) {
    status.textContent = "Valide o acesso administrativo em Integrações.";
    return;
  }
  const data = Object.fromEntries(new FormData(form));
  const link = data.link.trim();
  if (!officialLink(link)) {
    status.textContent = "Cole o link HTTPS gerado na sua conta de afiliado do Mercado Livre.";
    return;
  }
  if (!Number(data.price)) {
    status.textContent = "Informe o preço conferido no anúncio para salvar uma oferta na vitrine. Para criar conteúdo, o preço é opcional.";
    return;
  }
  const button = $("creativeSaveDraft");
  button.disabled = true;
  status.textContent = "Salvando rascunho…";
  try {
    const product = selectedProduct;
    const result = await request("/api/v2/affiliate-links/import", {
      method: "POST",
      body: JSON.stringify({ offers: [{
        title: data.product, price: Number(data.price), affiliateUrl: link,
        image: data.image.trim(), category: product?.category
      }] })
    });
    if (product) {
      try { localStorage.setItem("vcAffiliateLink:" + product.id, link); } catch {}
    }
    $("openSavedDrafts").hidden = false;
    status.textContent = result.created
      ? "Rascunho salvo. Revise e publique em Ofertas → Gerenciar rascunhos."
      : "Esse link já está cadastrado. Confira em Ofertas → Gerenciar rascunhos.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

$("creativeProduct").oninput = () => { selectedProduct = null; $("creativePriceStatus").textContent = ""; };
$("creativeForm").onsubmit = async event => {
  event.preventDefault();
  const status = $("creativeStatus");
  if (!authToken) {
    status.textContent = "Valide o acesso administrativo em Integrações.";
    return;
  }
  const button = $("creativeGenerate");
  const output = $("creativeOutput");
  button.disabled = true;
  output.hidden = true;
  status.textContent = "O Gemini está preparando seu roteiro, storyboard e legenda…";
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    data.link = data.link.trim();
    if (!officialLink(data.link)) throw Error("Cole o link HTTPS gerado na sua conta de afiliado do Mercado Livre.");
    data.price = data.price ? currency(data.price) : "";
    if (selectedProduct) {
      try { localStorage.setItem("vcAffiliateLink:" + selectedProduct.id, data.link); } catch {}
    }
    shareText = data.product + "\n" + (data.price ? data.price + " · preço sujeito a alteração" : "Confira o preço atual no anúncio") + "\nLink de afiliado: " + data.link;
    $("shareOffer").textContent = shareText;
    output.hidden = false;
    $("creativeText").textContent = "";
    $("creativeCopy").hidden = true;
    const result = await request("/api/gemini/generate", { method: "POST", body: JSON.stringify(data) });
    $("creativeText").textContent = result.text;
    $("creativeCopy").hidden = false;
    status.textContent = "Conteúdo pronto.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

$("copyOffer").onclick = async () => {
  try {
    await navigator.clipboard.writeText(shareText);
    $("creativeStatus").textContent = "Preço e link copiados.";
  } catch {
    $("creativeStatus").textContent = "Selecione o preço e o link para copiar.";
  }
};

$("creativeCopy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("creativeText").textContent + "\n\n" + shareText);
    $("creativeStatus").textContent = "Conteúdo copiado.";
  } catch {
    $("creativeStatus").textContent = "Selecione o texto para copiar.";
  }
};

async function loadCommissions() {
  if (!authToken) return;
  try {
    const { entries, summary } = await request("/api/finance/entries");
    const days = summary.daily.filter(day => day.sales > 0).slice(-14).map(day => ({
      label: day.date.split("-").reverse().join("/"),
      value: day.sales
    }));
    renderBars("commissionChart", days, currency, "Nenhuma comissão registrada.");
    $("commissionTotal").textContent = entries.some(entry => entry.type === "sale")
      ? currency(summary.sales)
      : "Nenhuma comissão registrada";
  } catch (error) {
    $("commissionChart").textContent = error.message;
    $("commissionTotal").textContent = error.message;
  }
}

$("toggleDemo").onclick = () => {
  const panel = $("demoResults");
  panel.hidden = !panel.hidden;
  $("toggleDemo").setAttribute("aria-expanded", String(!panel.hidden));
  $("toggleDemo").textContent = panel.hidden ? "Ver exemplo" : "Ocultar exemplo";
};

renderBars("demoSalesChart", [
  { label: "Fone Bluetooth", value: 9 },
  { label: "Organizador de gaveta", value: 6 },
  { label: "Luminária de mesa", value: 3 }
], String, "");
renderBars("demoCommissionChart", [
  { label: "Segunda-feira", value: 28 },
  { label: "Terça-feira", value: 42 },
  { label: "Quarta-feira", value: 56 }
], currency, "");

if (authToken) {
  $("token").value = authToken;
  loadAdmin();
  loadRanking();
  loadCommissions();
}
