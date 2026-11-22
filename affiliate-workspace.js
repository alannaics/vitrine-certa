const categoryPath = $("categoryPath");
const rankingStatus = $("rankingStatus");
const rankingCards = $("rankingCards");
let rankingVersion = 0;

function categorySelect(categories, label, first = "") {
  const select = document.createElement("select");
  select.className = "field";
  select.setAttribute("aria-label", label);
  if (!first) select.add(new Option(label, ""));
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

function rankingCard(product) {
  const card = document.createElement("article");
  card.className = "offer";
  const imageUrl = secureMarketplaceUrl(product.image?.replace(/^http:/, "https:"));
  if (imageUrl) {
    const photo = document.createElement("div");
    photo.className = "photo";
    const image = new Image();
    image.src = imageUrl;
    image.alt = "";
    image.loading = "lazy";
    image.onerror = () => photo.remove();
    photo.append(image);
    card.append(photo);
  }
  const body = document.createElement("div");
  body.className = "offerbody";
  const rank = document.createElement("small");
  rank.textContent = product.position + "º no ranking";
  const title = document.createElement("strong");
  title.textContent = product.title || product.id + " · detalhes indisponíveis";
  body.append(rank, title);
  if (product.price != null) {
    const price = document.createElement("div");
    price.className = "price";
    price.textContent = currency(product.price);
    body.append(price);
  }
  const url = secureMarketplaceUrl(product.url);
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
      $("creativeProduct").value = product.title;
      $("creativePrice").value = product.price ?? "";
      $("creativeLink").value = "";
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

async function loadRanking() {
  const current = ++rankingVersion;
  rankingCards.replaceChildren();
  rankingStatus.textContent = "Consultando o Mercado Livre…";
  try {
    if (!authToken) throw Error("Valide o acesso administrativo em Integrações.");
    if (!categoryPath.children.length) {
      const { categories } = await request("/api/mercadolivre/categories");
      if (current !== rankingVersion) return;
      if (!categories.length) throw Error("O Mercado Livre não retornou categorias.");
      const first = categories.find(entry => entry.id === "MLB1051") || categories[0];
      categorySelect(categories, "Categoria", first.id);
    }
    const selection = [...categoryPath.querySelectorAll("select")].findLast(select => select.value);
    const category = encodeURIComponent(selection.value);
    request("/api/mercadolivre/categories?parent=" + category).then(detail => {
      if (current === rankingVersion && detail.categories.length && !selection.nextElementSibling) {
        categorySelect(detail.categories, "Escolher subcategoria");
      }
    }).catch(() => {});
    const { products } = await request("/api/mercadolivre/bestsellers?category=" + category);
    if (current !== rankingVersion) return;
    rankingStatus.textContent = products.length
      ? selection.selectedOptions[0].text + " · " + products.length + " posições"
      : "O Mercado Livre não retornou um ranking para esta categoria. Consulte uma subcategoria, se houver.";
    rankingCards.append(...products.map(rankingCard));
  } catch (error) {
    if (current === rankingVersion) rankingStatus.textContent = error.message;
  }
}

categoryPath.onchange = ({ target }) => {
  while (target.nextElementSibling) target.nextElementSibling.remove();
  loadRanking();
};
$("rankingRefresh").onclick = loadRanking;
$("rankingAccess").onclick = () => tab("settings");
$("creativeAccess").onclick = () => tab("settings");

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
    if (data.price) data.price = currency(data.price);
    const result = await request("/api/gemini/generate", { method: "POST", body: JSON.stringify(data) });
    $("creativeText").textContent = result.text;
    output.hidden = false;
    status.textContent = "Conteúdo pronto.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

$("creativeCopy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("creativeText").textContent);
    $("creativeStatus").textContent = "Conteúdo copiado.";
  } catch {
    $("creativeStatus").textContent = "Selecione o texto para copiar.";
  }
};

async function loadCommissions() {
  if (!authToken) return;
  try {
    const { entries, summary } = await request("/api/finance/entries");
    $("commissionTotal").textContent = entries.some(entry => entry.type === "sale")
      ? currency(summary.sales)
      : "Nenhuma comissão registrada";
  } catch (error) {
    $("commissionTotal").textContent = error.message;
  }
}

if (authToken) {
  $("token").value = authToken;
  loadAdmin();
  loadRanking();
  loadCommissions();
}
