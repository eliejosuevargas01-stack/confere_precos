const heroCity = document.querySelector("#hero-city");
const heroUpdated = document.querySelector("#hero-updated");
const heroRefresh = document.querySelector("#hero-refresh");
const statProducts = document.querySelector("#stat-products");
const statCategories = document.querySelector("#stat-categories");
const statSites = document.querySelector("#stat-sites");
const statFeatured = document.querySelector("#stat-featured");
const statusPill = document.querySelector("#status-pill");
const statusText = document.querySelector("#status-text");
const storeStrip = document.querySelector("#store-strip");
const categoryNav = document.querySelector("#category-nav");
const subcategoryNav = document.querySelector("#subcategory-nav");
const featuredGrid = document.querySelector("#featured-grid");
const categorySections = document.querySelector("#category-sections");
const catalogSearch = document.querySelector("#catalog-search");
const filterTabs = document.querySelector("#filter-tabs");
const catalogMeta = document.querySelector("#catalog-meta");
const catalogEyebrow = document.querySelector("#catalog-eyebrow");
const catalogHeading = document.querySelector("#catalog-heading");
const catalogSummary = document.querySelector("#catalog-summary");
const plannerContent = document.querySelector("#planner-content");

const REFRESH_POLL_MS = 60_000;
const USER_CITY_STORAGE_KEY = "storefront-user-city";
const USER_CITY_CACHE_MS = 12 * 60 * 60 * 1000;
const SHOPPING_LIST_STORAGE_KEY = "storefront-shopping-list-v1";
const SEARCH_PAGE_SIZE = 24;
const SUBCATEGORY_PAGE_SIZE = 12;
const CATEGORY_PREVIEW_SIZE = 4;
const DEFAULT_CATEGORY_ID = "all";
const DEFAULT_SUBCATEGORY_ID = "all";

const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
});

const SUBCATEGORY_DEFINITIONS = {
  basicos: [
    {
      id: "graos",
      label: "Graos E Arroz",
      productIds: ["arroz", "feijao"],
    },
    {
      id: "despensa",
      label: "Despensa Basica",
      productIds: ["acucar", "sal", "oleo_de_soja"],
    },
    {
      id: "cafe_e_leite",
      label: "Cafe E Leite",
      productIds: ["cafe", "leite"],
    },
    {
      id: "massas_e_farinhas",
      label: "Massas E Farinhas",
      productIds: ["macarrao", "farinha_de_trigo", "farinha_de_milho", "fuba"],
    },
    {
      id: "padaria_e_ovos",
      label: "Padaria E Ovos",
      productIds: ["ovos", "pao_de_forma"],
    },
  ],
  mercearia: [
    {
      id: "tomate",
      label: "Tomate E Molhos",
      productIds: ["molho_de_tomate", "extrato_de_tomate"],
    },
    {
      id: "conservas",
      label: "Conservas",
      productIds: ["sardinha"],
    },
  ],
  higiene: [
    {
      id: "banho",
      label: "Banho E Papel",
      productIds: ["papel_higienico", "sabonete"],
    },
    {
      id: "bucal",
      label: "Saude Bucal",
      productIds: ["creme_dental", "escova_dental"],
    },
    {
      id: "cabelo_e_corpo",
      label: "Cabelo E Corpo",
      productIds: ["shampoo", "condicionador", "desodorante"],
    },
    {
      id: "cuidados",
      label: "Cuidados Diarios",
      productIds: ["absorvente", "algodao"],
    },
  ],
  limpeza: [
    {
      id: "lavanderia",
      label: "Lavanderia",
      productIds: ["sabao_em_po", "sabao_liquido", "amaciante"],
    },
    {
      id: "louca",
      label: "Louca",
      productIds: ["detergente", "esponja_de_louca"],
    },
    {
      id: "desinfeccao",
      label: "Desinfeccao",
      productIds: ["agua_sanitaria", "desinfetante", "alcool_70"],
    },
    {
      id: "descartaveis",
      label: "Descartaveis",
      productIds: ["saco_de_lixo"],
    },
  ],
  bebe: [
    {
      id: "troca",
      label: "Troca E Cuidado",
      productIds: ["fralda", "lenco_umedecido"],
    },
  ],
};

const SUBCATEGORY_INDEX = buildSubcategoryIndex(SUBCATEGORY_DEFINITIONS);

const state = {
  snapshot: null,
  status: null,
  requestedCity: null,
  locationStatus: null,
  catalog: null,
  view: {
    query: "",
    mode: "all",
    activeCategoryId: DEFAULT_CATEGORY_ID,
    activeSubcategoryId: DEFAULT_SUBCATEGORY_ID,
    searchLimit: SEARCH_PAGE_SIZE,
    subcategoryLimits: {},
    expandedFamilies: {},
    expandedProducts: {},
  },
  shoppingList: readShoppingList(),
};

attachEventListeners();

bootstrap().catch((error) => {
  renderFatalState(error.message);
});

async function bootstrap() {
  renderLoadingState("Detectando sua cidade e preparando a vitrine.");
  state.requestedCity = await resolvePreferredCity();
  await loadStorefront({ city: state.requestedCity });
  window.setInterval(() => {
    loadStorefront({ city: state.requestedCity, silent: true }).catch(() => {});
  }, REFRESH_POLL_MS);
}

function attachEventListeners() {
  catalogSearch?.addEventListener("input", (event) => {
    state.view.query = event.target.value.trim();
    state.view.searchLimit = SEARCH_PAGE_SIZE;
    renderCurrentView();
  });

  filterTabs?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mode]");

    if (!button) {
      return;
    }

    state.view.mode = button.dataset.mode || "all";
    state.view.searchLimit = SEARCH_PAGE_SIZE;
    renderCurrentView();
  });

  categoryNav?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category-id]");

    if (!button) {
      return;
    }

    state.view.activeCategoryId = button.dataset.categoryId || DEFAULT_CATEGORY_ID;
    state.view.activeSubcategoryId = DEFAULT_SUBCATEGORY_ID;
    renderCurrentView();
  });

  subcategoryNav?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-subcategory-id]");

    if (!button) {
      return;
    }

    state.view.activeSubcategoryId = button.dataset.subcategoryId || DEFAULT_SUBCATEGORY_ID;
    renderCurrentView();
  });

  categorySections?.addEventListener("click", (event) => {
    const control = event.target.closest("[data-action]");

    if (!control) {
      return;
    }

    const action = control.dataset.action;
    const groupId = control.dataset.groupId || null;
    const categoryId = control.dataset.categoryId || null;
    const subcategoryId = control.dataset.subcategoryId || null;

    if (action === "show-category" && categoryId) {
      state.view.activeCategoryId = categoryId;
      state.view.activeSubcategoryId = DEFAULT_SUBCATEGORY_ID;
      renderCurrentView();
      return;
    }

    if (action === "show-subcategory" && categoryId && subcategoryId) {
      state.view.activeCategoryId = categoryId;
      state.view.activeSubcategoryId = subcategoryId;
      renderCurrentView();
      return;
    }

    if (action === "show-more-subcategory" && categoryId && subcategoryId) {
      const key = getSubcategoryLimitKey(categoryId, subcategoryId);
      const current = state.view.subcategoryLimits[key] || SUBCATEGORY_PAGE_SIZE;
      state.view.subcategoryLimits[key] = current + SUBCATEGORY_PAGE_SIZE;
      renderCurrentView();
      return;
    }

    if (action === "toggle-family" && categoryId && subcategoryId && control.dataset.essentialId) {
      const familyKey = getFamilyExpansionKey(
        categoryId,
        subcategoryId,
        control.dataset.essentialId,
      );
      state.view.expandedFamilies[familyKey] = !state.view.expandedFamilies[familyKey];
      renderCurrentView();
      return;
    }

    if (action === "show-more-search") {
      state.view.searchLimit += SEARCH_PAGE_SIZE;
      renderCurrentView();
      return;
    }

    if (action === "toggle-offers" && groupId) {
      state.view.expandedProducts[groupId] = !state.view.expandedProducts[groupId];
      renderCurrentView();
      return;
    }

    if (action === "add-to-list" && groupId) {
      addGroupToShoppingList(groupId);
      return;
    }
  });

  plannerContent?.addEventListener("click", (event) => {
    const control = event.target.closest("[data-action]");

    if (!control) {
      return;
    }

    const action = control.dataset.action;
    const groupId = control.dataset.groupId || null;

    if (action === "increase-qty" && groupId) {
      updateShoppingListQuantity(groupId, 1);
      return;
    }

    if (action === "decrease-qty" && groupId) {
      updateShoppingListQuantity(groupId, -1);
      return;
    }

    if (action === "remove-item" && groupId) {
      removeGroupFromShoppingList(groupId);
      return;
    }

    if (action === "clear-list") {
      state.shoppingList = {};
      persistShoppingList();
      renderPlanner();
    }
  });
}

async function loadStorefront({ city = null, silent = false } = {}) {
  if (!silent && !state.snapshot) {
    renderLoadingState("Buscando a vitrine salva da sua cidade.");
  }

  const query = new URLSearchParams();
  query.set("ts", Date.now());

  if (city) {
    query.set("city", city);
  }

  const response = await fetch(`/api/storefront?${query.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok && !data.snapshot) {
    throw new Error(data.error || "Não foi possível carregar a vitrine.");
  }

  state.status = data.status || null;

  if (!state.requestedCity && data.city) {
    state.requestedCity = data.city;
  }

  if (data.snapshot) {
    state.snapshot = data.snapshot;
    state.catalog = buildCatalogModel(data.snapshot);
    sanitizeShoppingList();
    renderSnapshot(data.snapshot, data.status || null, data.city || city);
    return;
  }

  renderPendingState(data.status, data.error, data.city || city);
}

function renderSnapshot(snapshot, status, city) {
  const categories = Array.isArray(snapshot.categories) ? snapshot.categories : [];
  const featured = Array.isArray(snapshot.featured) ? snapshot.featured : [];
  const products = categories.reduce((total, category) => total + (category.productCount || 0), 0);
  const stores = (snapshot.siteStatus || []).filter((site) => readSiteFlag(site, "cityEligible")).length;
  const displayCity = city || snapshot.metadata?.requestedCity || status?.city || "não definida";

  heroCity.textContent = `Cidade: ${toTitleCase(displayCity)}`;
  heroUpdated.textContent = `Atualizado: ${formatDate(snapshot.metadata?.generatedAt)}`;
  heroRefresh.textContent = `Nova rodada: ${formatDate(snapshot.metadata?.nextRefreshAt)}`;

  statProducts.textContent = String(products);
  statCategories.textContent = String(snapshot.metadata?.totalCategories || categories.length);
  statSites.textContent = String(stores);
  statFeatured.textContent = String(featured.length);

  renderStatus(snapshot, status, displayCity);
  renderStoreStrip(snapshot.siteStatus || []);
  renderFeatured(featured);
  renderCurrentView();
}

function renderCurrentView() {
  if (!state.snapshot || !state.catalog) {
    return;
  }

  ensureValidNavigation();
  syncToolbarState();
  renderCategoryNav();
  renderSubcategoryNav();
  renderCatalogMeta();
  renderCatalogContent();
  renderPlanner();
}

function renderLoadingState(message = "Buscando o snapshot salvo para montar a vitrine.") {
  statusPill.textContent = "Carregando";
  statusPill.className = "status-pill is-loading";
  statusText.textContent = message;
  storeStrip.innerHTML = "";
  categoryNav.innerHTML = "";
  subcategoryNav.innerHTML = "";
  if (catalogMeta) {
    catalogMeta.textContent = "Lendo a vitrine salva.";
  }
  if (catalogSummary) {
    catalogSummary.textContent = "Assim que o snapshot for carregado, o catálogo aparece aqui.";
  }
  featuredGrid.innerHTML = buildEmptyBlock(
    "Lendo a vitrine salva",
    "Assim que o snapshot for carregado, os cards aparecem aqui.",
  );
  categorySections.innerHTML = "";
  plannerContent.innerHTML = buildPlannerEmpty(
    "Sua lista vai aparecer aqui",
    "Adicione produtos do catálogo para comparar o total entre as lojas.",
  );
}

function renderPendingState(status, message, city) {
  statusPill.textContent = "Processando";
  statusPill.className = "status-pill is-loading";
  statusText.textContent =
    message ||
    `Ainda não existe snapshot salvo para ${toTitleCase(city || status?.city || "sua cidade")}. O primeiro processamento está montando a vitrine agora.`;
  storeStrip.innerHTML = buildMiniInfo(status);
  categoryNav.innerHTML = "";
  subcategoryNav.innerHTML = "";
  if (catalogMeta) {
    catalogMeta.textContent = "Primeira carga em andamento.";
  }
  if (catalogSummary) {
    catalogSummary.textContent = "Quando o processamento terminar, a vitrine abre imediatamente com o arquivo salvo.";
  }
  featuredGrid.innerHTML = buildEmptyBlock(
    "Primeira carga em andamento",
    "Quando o processamento terminar, a vitrine passa a abrir imediatamente com o arquivo salvo.",
  );
  categorySections.innerHTML = "";
  plannerContent.innerHTML = buildPlannerEmpty(
    "Monte a lista depois da primeira carga",
    "Assim que o snapshot ficar pronto, você poderá montar o carrinho ideal por loja.",
  );
}

function renderFatalState(message) {
  statusPill.textContent = "Erro";
  statusPill.className = "status-pill is-error";
  statusText.textContent = message || "A vitrine não pôde ser carregada.";
  featuredGrid.innerHTML = buildEmptyBlock(
    "Sem vitrine disponível",
    message || "Não foi possível ler o snapshot salvo no momento.",
  );
  categorySections.innerHTML = "";
  plannerContent.innerHTML = buildPlannerEmpty(
    "Sem lista disponível",
    "A lista inteligente depende do catálogo carregado.",
  );
}

function renderStatus(snapshot, status, city) {
  if (status?.refreshing) {
    statusPill.textContent = "Atualizando";
    statusPill.className = "status-pill is-loading";
    statusText.textContent =
      `Vitrine disponível para ${toTitleCase(city || status?.city || "sua cidade")}. Uma nova rodada está sendo processada em segundo plano.`;
    return;
  }

  if (status?.lastError) {
    statusPill.textContent = "Parcial";
    statusPill.className = "status-pill is-warning";
    statusText.textContent = `Vitrine exibida com o último snapshot válido. Último erro: ${status.lastError.message}`;
    return;
  }

  statusPill.textContent = "Pronto";
  statusPill.className = "status-pill is-ready";
  statusText.textContent = `Dados prontos para ${toTitleCase(
    city || snapshot.metadata?.requestedCity || status?.city || "a cidade atual",
  )}. Atualização automática a cada ${snapshot.metadata?.refreshIntervalMinutes || status?.intervalMinutes || 0} minutos.`;
}

function renderStoreStrip(sites) {
  if (!Array.isArray(sites) || sites.length === 0) {
    storeStrip.innerHTML = "";
    return;
  }

  storeStrip.innerHTML = sites
    .map((site) => {
      const label = escapeHtml(
        readSiteValue(site, "storeLabel") || extractDomain(readSiteValue(site, "sourceUrl") || ""),
      );
      const city = escapeHtml(readSiteValue(site, "effectiveCity") || "cidade não informada");
      const chipClass = readSiteFlag(site, "cityEligible")
        ? "store-chip is-ready"
        : "store-chip is-muted";
      return `
        <article class="${chipClass}">
          <strong>${label}</strong>
          <span>${city}</span>
        </article>
      `;
    })
    .join("");
}

function syncToolbarState() {
  if (catalogSearch && catalogSearch.value !== state.view.query) {
    catalogSearch.value = state.view.query;
  }

  filterTabs?.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === state.view.mode);
  });
}

function renderCategoryNav() {
  const counts = getCategoryCounts();
  const totalVisible = counts.reduce((total, entry) => total + entry.count, 0);

  categoryNav.innerHTML = [
    `
      <button
        class="nav-chip ${state.view.activeCategoryId === DEFAULT_CATEGORY_ID ? "is-active" : ""}"
        data-category-id="${DEFAULT_CATEGORY_ID}"
        type="button"
      >
        <span>Visão geral</span>
        <strong>${totalVisible}</strong>
      </button>
    `,
    ...counts.map(
      (entry) => `
        <button
          class="nav-chip ${state.view.activeCategoryId === entry.id ? "is-active" : ""}"
          data-category-id="${escapeAttribute(entry.id)}"
          type="button"
        >
          <span>${escapeHtml(entry.label)}</span>
          <strong>${entry.count}</strong>
        </button>
      `,
    ),
  ].join("");
}

function renderSubcategoryNav() {
  const category = getActiveCategory();

  if (!category) {
    subcategoryNav.innerHTML = `
      <span class="status-mini">
        Escolha uma categoria para abrir as subcategorias.
      </span>
    `;
    return;
  }

  const subcategories = getFilteredSubcategories(category);

  if (subcategories.length === 0) {
    subcategoryNav.innerHTML = `
      <span class="status-mini">
        Nenhuma subcategoria disponível com o filtro atual.
      </span>
    `;
    return;
  }

  subcategoryNav.innerHTML = [
    `
      <button
        class="subcategory-chip ${state.view.activeSubcategoryId === DEFAULT_SUBCATEGORY_ID ? "is-active" : ""}"
        data-subcategory-id="${DEFAULT_SUBCATEGORY_ID}"
        type="button"
      >
        <span>Visão da categoria</span>
        <strong>${subcategories.reduce((total, subcategory) => total + countEssentialFamilies(subcategory.groups), 0)}</strong>
      </button>
    `,
    ...subcategories.map(
      (subcategory) => `
        <button
          class="subcategory-chip ${state.view.activeSubcategoryId === subcategory.id ? "is-active" : ""}"
          data-subcategory-id="${escapeAttribute(subcategory.id)}"
          type="button"
        >
          <span>${escapeHtml(subcategory.label)}</span>
          <strong>${countEssentialFamilies(subcategory.groups)}</strong>
        </button>
      `,
    ),
  ].join("");
}

function renderCatalogMeta() {
  const contextGroups = getContextGroups();
  const comparableCount = contextGroups.filter((group) => group.isComparable).length;
  const promoCount = contextGroups.filter((group) => group.hasPromotion).length;

  if (catalogMeta) {
    catalogMeta.textContent = [
      `${contextGroups.length} produto(s) visíveis`,
      `${comparableCount} comparável(is)`,
      `${promoCount} em promoção`,
    ].join(" · ");
  }
}

function renderFeatured(items) {
  if (!Array.isArray(items) || items.length === 0) {
    featuredGrid.innerHTML = buildEmptyBlock(
      "Sem destaques no momento",
      "Nenhum produto elegível entrou na vitrine salva desta rodada.",
    );
    return;
  }

  featuredGrid.innerHTML = items
    .slice(0, 8)
    .map((item) => {
      const href = `#product-${toDomId(item.groupId)}`;
      const originalLine = item.originalPrice
        ? `<span class="featured-original">${escapeHtml(item.originalPrice)}</span>`
        : "";
      const badge = Number.isFinite(item.discountPercent)
        ? `<span class="offer-badge is-promo">-${item.discountPercent}%</span>`
        : `<span class="offer-badge">mais barato</span>`;

      return `
        <article class="featured-card">
          <a class="featured-link" href="${href}">
            <div class="featured-media ${item.image ? "" : "is-empty"}">
              ${buildImage(item.image, item.title)}
            </div>
            <div class="featured-body">
              <div class="featured-topline">
                <span class="section-tag">${escapeHtml(resolveCategoryLabel(item.categoryId))}</span>
                ${badge}
              </div>
              <h3>${escapeHtml(item.title)}</h3>
              <p class="featured-meta">${escapeHtml(item.packageLabel || "Embalagem informada no anúncio")}</p>
              <div class="featured-price-row">
                <strong>${escapeHtml(item.price)}</strong>
                ${originalLine}
              </div>
              <p class="featured-store">${escapeHtml(item.storeLabel || item.siteDomain || "")}</p>
              <p class="featured-note">
                ${item.isComparable ? `${item.storeCount || 0} loja(s) com o mesmo produto` : "Produto encontrado em 1 loja"}
                ${Number.isFinite(item.priceSpreadValue) ? ` · diferença de ${formatCurrency(item.priceSpreadValue)}` : ""}
              </p>
            </div>
          </a>
        </article>
      `;
    })
    .join("");
}

function renderCatalogContent() {
  if (state.view.query) {
    renderSearchResults();
    return;
  }

  if (state.view.activeCategoryId === DEFAULT_CATEGORY_ID) {
    renderCategoryOverview();
    return;
  }

  const category = getActiveCategory();

  if (!category) {
    categorySections.innerHTML = buildEmptyBlock(
      "Categoria indisponível",
      "Escolha outra categoria para continuar navegando.",
    );
    return;
  }

  if (state.view.activeSubcategoryId === DEFAULT_SUBCATEGORY_ID) {
    renderCategoryFocus(category);
    return;
  }

  renderSubcategoryFocus(category);
}

function renderSearchResults() {
  const query = state.view.query;
  const results = getSearchResults();

  catalogEyebrow.textContent = "Busca";
  catalogHeading.textContent = `Resultados para "${query}"`;
  catalogSummary.textContent = results.length
    ? `${results.length} produto(s) encontrados com o filtro atual.`
    : "Nenhum item corresponde ao termo digitado.";

  if (results.length === 0) {
    categorySections.innerHTML = buildEmptyBlock(
      "Nenhum resultado encontrado",
      "Tente outra marca, embalagem, nome de produto ou mude o filtro ativo.",
    );
    return;
  }

  const limited = results.slice(0, state.view.searchLimit);
  const hasMore = results.length > limited.length;

  categorySections.innerHTML = `
    <section class="results-shell">
      <div class="results-toolbar">
        <p class="status-mini">
          ${limited.length} de ${results.length} produto(s) renderizados
        </p>
      </div>
      <div class="product-grid">
        ${limited.map((group) => renderProductCard(group)).join("")}
      </div>
      ${
        hasMore
          ? `
            <div class="load-more-row">
              <button class="action-button is-secondary" data-action="show-more-search" type="button">
                Carregar mais resultados
              </button>
            </div>
          `
          : ""
      }
    </section>
  `;
}

function renderCategoryOverview() {
  const categories = state.catalog.categories
    .map((category) => ({
      ...category,
      filteredGroups: applyModeFilter(category.groups),
    }))
    .filter((category) => category.filteredGroups.length > 0);

  catalogEyebrow.textContent = "Visão geral";
  catalogHeading.textContent = "Escolha um corredor";
  catalogSummary.textContent =
    "Abra uma categoria para navegar por subcategorias sem transformar a página em uma lista infinita.";

  if (categories.length === 0) {
    categorySections.innerHTML = buildEmptyBlock(
      "Nada para mostrar com este filtro",
      "Troque o modo de visualização para voltar ao catálogo completo.",
    );
    return;
  }

  categorySections.innerHTML = `
    <div class="overview-grid">
      ${categories.map((category) => renderCategoryOverviewCard(category)).join("")}
    </div>
  `;
}

function renderCategoryFocus(category) {
  const subcategories = getFilteredSubcategories(category);

  catalogEyebrow.textContent = "Categoria";
  catalogHeading.textContent = category.label;
  catalogSummary.textContent = [
    `${subcategories.length} subcategoria(s)`,
    `${subcategories.reduce((total, subcategory) => total + subcategory.groups.length, 0)} produto(s)`,
    `${subcategories.reduce((total, subcategory) => total + countEssentialFamilies(subcategory.groups), 0)} família(s)`,
  ].join(" · ");

  if (subcategories.length === 0) {
    categorySections.innerHTML = buildEmptyBlock(
      "Nenhuma subcategoria disponível",
      "O filtro atual não deixou itens visíveis nesta categoria.",
    );
    return;
  }

  categorySections.innerHTML = subcategories
    .map((subcategory) => renderSubcategoryPreview(category, subcategory))
    .join("");
}

function renderSubcategoryFocus(category) {
  const subcategories = getFilteredSubcategories(category);
  const subcategory = subcategories.find(
    (entry) => entry.id === state.view.activeSubcategoryId,
  );

  if (!subcategory) {
    state.view.activeSubcategoryId = DEFAULT_SUBCATEGORY_ID;
    renderCategoryFocus(category);
    return;
  }

  const families = buildEssentialFamilies(subcategory.groups, category.id, subcategory.id);

  catalogEyebrow.textContent = "Subcategoria";
  catalogHeading.textContent = subcategory.label;
  catalogSummary.textContent = [
    `${families.length} família(s)`,
    `${subcategory.groups.length} produto(s)`,
    `${subcategory.comparableCount} comparável(is)`,
    Number.isFinite(subcategory.lowestPriceValue)
      ? `a partir de ${formatCurrency(subcategory.lowestPriceValue)}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  categorySections.innerHTML = `
    <section class="subcategory-focus">
      <div class="results-toolbar">
        <p class="status-mini">
          ${families.length} família(s) com ${subcategory.groups.length} produto(s)
        </p>
      </div>
      <div class="family-grid">
        ${families.map((family) => renderFamilyCard(category, subcategory, family)).join("")}
      </div>
    </section>
  `;
}

function renderCategoryOverviewCard(category) {
  const cheapest = category.filteredGroups[0]?.lowestPriceValue ?? null;
  const subcategories = buildSubcategories(category.filteredGroups, category.id);
  const spotlight = subcategories.slice(0, 3);

  return `
    <article class="overview-card">
      <div class="overview-topline">
        <span class="section-tag">${escapeHtml(category.label)}</span>
        <span class="offer-badge">${category.filteredGroups.filter((group) => group.isComparable).length} comparável(is)</span>
      </div>
      <h3>${escapeHtml(category.label)}</h3>
      <p class="overview-text">
        ${category.filteredGroups.length} produto(s) organizados em ${subcategories.length} subcategoria(s)
      </p>
      <div class="overview-chip-row">
        ${spotlight
          .map(
            (subcategory) => `
              <span class="status-mini">
                ${escapeHtml(subcategory.label)} · ${subcategory.groups.length}
              </span>
            `,
          )
          .join("")}
      </div>
      <div class="overview-footer">
        <strong>${Number.isFinite(cheapest) ? `A partir de ${formatCurrency(cheapest)}` : "Preço sob consulta"}</strong>
        <button
          class="action-button is-secondary"
          data-action="show-category"
          data-category-id="${escapeAttribute(category.id)}"
          type="button"
        >
          Abrir categoria
        </button>
      </div>
    </article>
  `;
}

function renderSubcategoryPreview(category, subcategory) {
  const families = buildEssentialFamilies(subcategory.groups, category.id, subcategory.id);
  const previewFamilies = families.slice(0, CATEGORY_PREVIEW_SIZE);

  return `
    <section class="subcategory-block">
      <header class="subcategory-head">
        <div>
          <p class="section-eyebrow">Subcategoria</p>
          <h3>${escapeHtml(subcategory.label)}</h3>
        </div>
        <div class="subcategory-meta">
          <p class="category-summary">
            ${families.length} família(s) · ${subcategory.groups.length} produto(s)
            ${Number.isFinite(subcategory.lowestPriceValue) ? ` · a partir de ${formatCurrency(subcategory.lowestPriceValue)}` : ""}
          </p>
          <button
            class="action-button is-secondary"
            data-action="show-subcategory"
            data-category-id="${escapeAttribute(category.id)}"
            data-subcategory-id="${escapeAttribute(subcategory.id)}"
            type="button"
          >
            Ver tudo
          </button>
        </div>
      </header>
      <div class="family-grid family-grid-compact">
        ${previewFamilies.map((family) => renderFamilyCard(category, subcategory, family)).join("")}
      </div>
    </section>
  `;
}

function renderFamilyCard(category, subcategory, family) {
  const familyKey = getFamilyExpansionKey(category.id, subcategory.id, family.essentialId);
  const expanded = Boolean(state.view.expandedFamilies[familyKey]);
  const highlight = family.highlightGroup;
  const cheapest = family.cheapestGroup;
  const labelPlural = family.groupCount === 1 ? "item" : "itens";
  const reasonLabel =
    family.highlightReason === "discount"
      ? `Maior desconto da família · ${family.bestDiscountPercent}%`
      : "Menor preço da família";
  const expandLabel = expanded
    ? `Ocultar produtos de ${family.essentialLabel.toLowerCase()}`
    : `Ver produtos de ${family.essentialLabel.toLowerCase()}`;

  return `
    <article class="family-card ${expanded ? "is-expanded" : ""}">
      <div class="family-head">
        <div>
          <p class="section-eyebrow">Família</p>
          <h3>${escapeHtml(family.essentialLabel)}</h3>
        </div>
        <div class="family-meta">
          <span class="offer-badge">${family.groupCount} ${labelPlural}</span>
          ${family.comparableCount > 0 ? `<span class="offer-badge">${family.comparableCount} comparável(is)</span>` : ""}
        </div>
      </div>

      <div class="family-highlight">
        <div class="family-highlight-copy">
          <span class="status-mini">${escapeHtml(reasonLabel)}</span>
          <strong>${escapeHtml(highlight.title)}</strong>
          <p>${escapeHtml(highlight.packageLabel || "Embalagem não detalhada")}</p>
          <p>
            Melhor preço geral: <strong>${escapeHtml(cheapest.cheapestOffer?.price || formatCurrency(cheapest.lowestPriceValue))}</strong>
            em ${escapeHtml(cheapest.cheapestOffer?.storeLabel || cheapest.cheapestOffer?.siteDomain || "loja não informada")}
          </p>
        </div>
        <div class="family-highlight-price">
          <strong>${escapeHtml(highlight.cheapestOffer?.price || formatCurrency(highlight.lowestPriceValue))}</strong>
          <span>${escapeHtml(highlight.cheapestOffer?.storeLabel || highlight.cheapestOffer?.siteDomain || "Loja")}</span>
        </div>
      </div>

      <div class="product-actions">
        <button
          class="action-button ${state.shoppingList[highlight.id] ? "is-active" : ""}"
          data-action="add-to-list"
          data-group-id="${escapeAttribute(highlight.id)}"
          type="button"
        >
          ${escapeHtml(state.shoppingList[highlight.id] ? `Destaque na lista: ${state.shoppingList[highlight.id]}` : "Adicionar destaque")}
        </button>
        <button
          class="action-button is-secondary"
          data-action="toggle-family"
          data-category-id="${escapeAttribute(category.id)}"
          data-subcategory-id="${escapeAttribute(subcategory.id)}"
          data-essential-id="${escapeAttribute(family.essentialId)}"
          type="button"
        >
          ${escapeHtml(expandLabel)}
        </button>
      </div>

      ${
        expanded
          ? `
            <div class="family-products">
              <div class="product-grid">
                ${family.groups.map((group) => renderProductCard(group)).join("")}
              </div>
            </div>
          `
          : ""
      }
    </article>
  `;
}

function renderProductCard(group) {
  const cheapestOffer = group.cheapestOffer || (group.offers || []).find((offer) => offer.isCheapest) || null;
  const expanded = Boolean(state.view.expandedProducts[group.id]);
  const selectedQuantity = state.shoppingList[group.id] || 0;
  const previewOffers = expanded ? group.offers : group.offers.slice(0, 2);
  const comparisonBadge = group.isComparable
    ? `<span class="offer-badge">comparável</span>`
    : `<span class="offer-badge">1 loja</span>`;
  const promotionBadge = group.hasPromotion
    ? `<span class="offer-badge is-promo">promoção</span>`
    : "";
  const addLabel = selectedQuantity > 0 ? `Na lista: ${selectedQuantity}` : "Adicionar à lista";
  const toggleLabel = expanded
    ? "Ocultar ofertas"
    : group.offers.length > 1
      ? `Ver ofertas (${group.offers.length})`
      : "Ver detalhes";
  const hasMorePreview = !expanded && group.offers.length > previewOffers.length;

  return `
    <article
      class="product-card ${selectedQuantity > 0 ? "is-selected" : ""}"
      id="product-${toDomId(group.id)}"
    >
      <div class="product-media ${group.image ? "" : "is-empty"}">
        ${buildImage(group.image, group.title)}
      </div>

      <div class="product-content">
        <div class="product-topline">
          <span class="section-tag">${escapeHtml(group.essentialLabel || group.categoryLabel || "")}</span>
          <span class="store-count">${group.storeCount || 0} loja(s)</span>
        </div>

        <div class="product-flag-row">
          ${comparisonBadge}
          ${promotionBadge}
        </div>

        <h4>${escapeHtml(group.title)}</h4>
        <p class="product-package">${escapeHtml(group.packageLabel || group.subcategoryLabel || "Embalagem não detalhada")}</p>

        <div class="best-price">
          <span class="best-price-label">Menor preço</span>
          <strong>${escapeHtml(cheapestOffer?.price || formatCurrency(group.lowestPriceValue))}</strong>
          <p>${escapeHtml(cheapestOffer?.storeLabel || cheapestOffer?.siteDomain || "Loja não informada")}</p>
          ${
            cheapestOffer?.link
              ? `<a class="offer-link" href="${escapeAttribute(cheapestOffer.link)}" target="_blank" rel="noreferrer">abrir oferta</a>`
              : ""
          }
        </div>

        <div class="price-strip">
          <span>${Number.isFinite(group.lowestPriceValue) ? formatCurrency(group.lowestPriceValue) : "--"}</span>
          <div class="price-strip-bar">
            <div class="price-strip-fill" style="width:${computeSpreadWidth(group)}%"></div>
          </div>
          <span>${Number.isFinite(group.highestPriceValue) ? formatCurrency(group.highestPriceValue) : "--"}</span>
        </div>

        <div class="offer-preview">
          ${previewOffers.map((offer) => renderOfferPreviewRow(offer)).join("")}
          ${
            hasMorePreview
              ? `<p class="offer-preview-note">+ ${group.offers.length - previewOffers.length} oferta(s) nesta mesma comparação</p>`
              : ""
          }
        </div>

        ${
          expanded
            ? `
              <ul class="offer-list">
                ${group.offers.map((offer) => renderOfferRow(offer)).join("")}
              </ul>
            `
            : ""
        }

        <div class="product-actions">
          <button
            class="action-button ${selectedQuantity > 0 ? "is-active" : ""}"
            data-action="add-to-list"
            data-group-id="${escapeAttribute(group.id)}"
            type="button"
          >
            ${escapeHtml(addLabel)}
          </button>
          <button
            class="action-button is-secondary"
            data-action="toggle-offers"
            data-group-id="${escapeAttribute(group.id)}"
            type="button"
          >
            ${escapeHtml(toggleLabel)}
          </button>
        </div>
      </div>
    </article>
  `;
}

function renderOfferPreviewRow(offer) {
  return `
    <div class="offer-preview-row ${offer.isCheapest ? "is-cheapest" : ""}">
      <strong>${escapeHtml(offer.storeLabel || offer.siteDomain || "Loja")}</strong>
      <span>${escapeHtml(offer.price || "--")}</span>
    </div>
  `;
}

function renderOfferRow(offer) {
  const priceSecondary =
    offer.originalPrice && offer.originalPrice !== offer.price
      ? `<span class="offer-original">${escapeHtml(offer.originalPrice)}</span>`
      : "";
  const offerBadge = offer.isCheapest
    ? `<span class="offer-badge is-cheapest">menor preço</span>`
    : offer.isPromotion
      ? `<span class="offer-badge is-promo">promoção</span>`
      : "";
  const action = offer.link
    ? `<a class="offer-link" href="${escapeAttribute(offer.link)}" target="_blank" rel="noreferrer">ver oferta</a>`
    : "";

  return `
    <li class="offer-row ${offer.isCheapest ? "is-cheapest" : ""}">
      <div class="offer-store">
        <strong>${escapeHtml(offer.storeLabel || offer.siteDomain || "")}</strong>
        <span>${escapeHtml(offer.effectiveCity || "")}</span>
      </div>
      <div class="offer-price-box">
        <strong>${escapeHtml(offer.price)}</strong>
        ${priceSecondary}
      </div>
      <div class="offer-actions">
        ${offerBadge}
        ${action}
      </div>
    </li>
  `;
}

function renderPlanner() {
  if (!state.catalog) {
    plannerContent.innerHTML = buildPlannerEmpty(
      "Aguardando catálogo",
      "Assim que os produtos forem carregados, você poderá montar sua lista.",
    );
    return;
  }

  const selections = getShoppingSelections();

  if (selections.length === 0) {
    plannerContent.innerHTML = buildPlannerEmpty(
      "Adicione produtos para planejar a compra",
      "Use o botão “Adicionar à lista” nos cards para comparar a estratégia mais barata contra a melhor loja única.",
    );
    return;
  }

  const plan = buildSavingsPlan(selections);
  const splitStores = plan.splitStores
    .map(
      (store) => `
        <span class="planner-chip">
          ${escapeHtml(store.label)} · ${store.productCount} produto(s)
        </span>
      `,
    )
    .join("");

  const bestStoreCard = plan.bestCompleteStore
    ? `
      <article class="planner-summary-card">
        <span class="stat-label">Melhor loja única</span>
        <strong>${formatCurrency(plan.bestCompleteStore.total)}</strong>
        <p>${escapeHtml(plan.bestCompleteStore.label)}</p>
      </article>
    `
    : `
      <article class="planner-summary-card is-muted">
        <span class="stat-label">Melhor loja única</span>
        <strong>Sem cobertura total</strong>
        <p>${escapeHtml(plan.bestPartialStore?.label || "Nenhuma loja cobre todos os itens")}</p>
      </article>
    `;

  const savingsCard = plan.bestCompleteStore
    ? `
      <article class="planner-summary-card">
        <span class="stat-label">Economia estimada</span>
        <strong>${formatCurrency(plan.bestCompleteStore.total - plan.splitTotal)}</strong>
        <p>diferença entre loja única e compra item a item</p>
      </article>
    `
    : `
      <article class="planner-summary-card is-muted">
        <span class="stat-label">Cobertura máxima</span>
        <strong>${plan.bestPartialStore?.coveredItems || 0}/${selections.length}</strong>
        <p>itens cobertos na melhor loja parcial</p>
      </article>
    `;

  plannerContent.innerHTML = `
    <div class="planner-summary-grid">
      <article class="planner-summary-card">
        <span class="stat-label">Itens escolhidos</span>
        <strong>${plan.totalUnits}</strong>
        <p>${selections.length} produto(s) diferente(s)</p>
      </article>
      <article class="planner-summary-card">
        <span class="stat-label">Mais barato</span>
        <strong>${formatCurrency(plan.splitTotal)}</strong>
        <p>comprando item a item</p>
      </article>
      ${bestStoreCard}
      ${savingsCard}
    </div>

    <div class="planner-route-card">
      <div class="planner-route-head">
        <div>
          <p class="section-eyebrow">Roteiro sugerido</p>
          <h3>${escapeHtml(plan.routeTitle)}</h3>
        </div>
        <button class="action-button is-secondary" data-action="clear-list" type="button">
          Limpar lista
        </button>
      </div>
      <p class="planner-route-copy">${escapeHtml(plan.routeDescription)}</p>
      <div class="planner-chip-row">${splitStores}</div>
      <div class="planner-route-grid">
        ${plan.splitStores.map((store, index) => renderPlannerStop(store, index)).join("")}
      </div>
    </div>

    <ul class="planner-list">
      ${selections.map((selection) => renderPlannerItem(selection)).join("")}
    </ul>
  `;
}

function renderPlannerStop(store, index) {
  return `
    <article class="planner-stop-card">
      <div class="planner-stop-head">
        <div>
          <p class="section-eyebrow">Loja ${index + 1}</p>
          <h3>${escapeHtml(store.label)}</h3>
        </div>
        <div class="planner-stop-total">
          <strong>${formatCurrency(store.total)}</strong>
          <span>${store.productCount} produto(s) · ${store.totalUnits} unidade(s)</span>
        </div>
      </div>
      <ul class="planner-stop-list">
        ${store.items.map((item) => renderPlannerStopItem(item)).join("")}
      </ul>
    </article>
  `;
}

function renderPlannerStopItem(item) {
  const packageLine = item.group.packageLabel
    ? ` · ${item.group.packageLabel}`
    : "";
  const offerLink = item.offer?.link
    ? `<a class="offer-link" href="${escapeAttribute(item.offer.link)}" target="_blank" rel="noreferrer">abrir oferta</a>`
    : "";

  return `
    <li class="planner-stop-item">
      <div class="planner-stop-item-copy">
        <strong>${item.quantity}x ${escapeHtml(item.group.title)}</strong>
        <span>${escapeHtml(item.offer?.price || formatCurrency(item.offer?.priceValue))}${escapeHtml(packageLine)}</span>
      </div>
      <div class="planner-stop-item-meta">
        <strong>${formatCurrency(item.subtotal)}</strong>
        ${offerLink}
      </div>
    </li>
  `;
}

function renderPlannerItem(selection) {
  const cheapestOffer =
    selection.group.cheapestOffer ||
    (selection.group.offers || []).find((offer) => offer.isCheapest) ||
    null;

  return `
    <li class="planner-item">
      <div class="planner-qty">
        <button
          class="qty-button"
          data-action="decrease-qty"
          data-group-id="${escapeAttribute(selection.group.id)}"
          type="button"
        >
          -
        </button>
        <span>${selection.quantity}</span>
        <button
          class="qty-button"
          data-action="increase-qty"
          data-group-id="${escapeAttribute(selection.group.id)}"
          type="button"
        >
          +
        </button>
      </div>
      <div class="planner-item-body">
        <strong>${escapeHtml(selection.group.title)}</strong>
        <span>
          ${escapeHtml(cheapestOffer?.storeLabel || cheapestOffer?.siteDomain || "Loja não informada")}
          ·
          ${escapeHtml(cheapestOffer?.price || formatCurrency(selection.group.lowestPriceValue))}
        </span>
      </div>
      <button
        class="planner-remove"
        data-action="remove-item"
        data-group-id="${escapeAttribute(selection.group.id)}"
        type="button"
      >
        remover
      </button>
    </li>
  `;
}

function buildPlannerEmpty(title, description) {
  return `
    <article class="planner-empty">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(description)}</p>
    </article>
  `;
}

function buildSavingsPlan(selections) {
  const splitStoresByDomain = new Map();
  let splitTotal = 0;
  let totalUnits = 0;

  for (const selection of selections) {
    totalUnits += selection.quantity;

    const offer =
      selection.group.cheapestOffer ||
      (selection.group.offers || []).find((entry) => entry.isCheapest) ||
      selection.group.offers?.[0] ||
      null;

    if (!offer || !Number.isFinite(offer.priceValue)) {
      continue;
    }

    splitTotal += offer.priceValue * selection.quantity;

    const key = offer.siteDomain || offer.storeLabel || offer.sourceUrl || selection.group.id;
    const current = splitStoresByDomain.get(key) || {
      key,
      label: offer.storeLabel || offer.siteDomain || "Loja",
      productCount: 0,
      totalUnits: 0,
      total: 0,
      items: [],
    };

    const subtotal = offer.priceValue * selection.quantity;
    current.productCount += 1;
    current.totalUnits += selection.quantity;
    current.total += subtotal;
    current.items.push({
      group: selection.group,
      quantity: selection.quantity,
      offer,
      subtotal,
    });
    splitStoresByDomain.set(key, current);
  }

  const storePlans = buildStorePlans(selections);
  const bestCompleteStore = storePlans
    .filter((plan) => plan.allCovered)
    .sort((left, right) => left.total - right.total)[0] || null;
  const bestPartialStore = storePlans
    .slice()
    .sort((left, right) => {
      if (right.coveredItems !== left.coveredItems) {
        return right.coveredItems - left.coveredItems;
      }

      return left.total - right.total;
    })[0] || null;

  const splitStores = Array.from(splitStoresByDomain.values()).sort((left, right) => {
    if (right.productCount !== left.productCount) {
      return right.productCount - left.productCount;
    }

    return left.total - right.total;
  }).map((store) => ({
    ...store,
    items: store.items.slice().sort((left, right) => {
      if (left.offer.priceValue !== right.offer.priceValue) {
        return left.offer.priceValue - right.offer.priceValue;
      }

      return left.group.title.localeCompare(right.group.title, "pt-BR");
    }),
  }));

  return {
    totalUnits,
    splitTotal,
    splitStores,
    bestCompleteStore,
    bestPartialStore,
    routeTitle: bestCompleteStore
      ? "Roteiro por loja para pagar o menor total"
      : "Divida a compra pelas lojas com menor preço",
    routeDescription: bestCompleteStore
      ? `Os produtos selecionados já estão separados por loja. Compre cada item na loja indicada abaixo para economizar ${formatCurrency(bestCompleteStore.total - splitTotal)} em relação à melhor loja única.`
      : `Os produtos já estão agrupados pela loja mais barata disponível. Ainda assim, nenhuma loja única cobre toda a lista no momento.`,
  };
}

function buildStorePlans(selections) {
  const storesByDomain = new Map();

  for (const selection of selections) {
    for (const offer of selection.group.offers || []) {
      if (!Number.isFinite(offer.priceValue)) {
        continue;
      }

      const key = offer.siteDomain || offer.storeLabel || offer.sourceUrl || selection.group.id;

      if (!storesByDomain.has(key)) {
        storesByDomain.set(key, {
          key,
          label: offer.storeLabel || offer.siteDomain || "Loja",
        });
      }
    }
  }

  return Array.from(storesByDomain.values()).map((store) => {
    let total = 0;
    let coveredItems = 0;
    const missingItems = [];

    for (const selection of selections) {
      const offer = (selection.group.offers || []).find(
        (entry) => (entry.siteDomain || entry.storeLabel || entry.sourceUrl) === store.key,
      );

      if (!offer || !Number.isFinite(offer.priceValue)) {
        missingItems.push(selection.group.title);
        continue;
      }

      total += offer.priceValue * selection.quantity;
      coveredItems += 1;
    }

    return {
      ...store,
      total,
      coveredItems,
      allCovered: missingItems.length === 0,
      missingItems,
    };
  });
}

function addGroupToShoppingList(groupId) {
  const current = state.shoppingList[groupId] || 0;
  state.shoppingList[groupId] = current + 1;
  persistShoppingList();
  renderPlanner();
  renderCurrentView();
}

function updateShoppingListQuantity(groupId, delta) {
  const current = state.shoppingList[groupId] || 0;
  const next = current + delta;

  if (next <= 0) {
    delete state.shoppingList[groupId];
  } else {
    state.shoppingList[groupId] = next;
  }

  persistShoppingList();
  renderPlanner();
  renderCurrentView();
}

function removeGroupFromShoppingList(groupId) {
  delete state.shoppingList[groupId];
  persistShoppingList();
  renderPlanner();
  renderCurrentView();
}

function readShoppingList() {
  try {
    const raw = localStorage.getItem(SHOPPING_LIST_STORAGE_KEY);

    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const list = {};

    for (const [key, value] of Object.entries(parsed)) {
      const quantity = Number.parseInt(value, 10);

      if (Number.isFinite(quantity) && quantity > 0) {
        list[key] = quantity;
      }
    }

    return list;
  } catch {
    return {};
  }
}

function persistShoppingList() {
  try {
    localStorage.setItem(SHOPPING_LIST_STORAGE_KEY, JSON.stringify(state.shoppingList));
  } catch {
    // Ignorar falha de persistência local.
  }
}

function sanitizeShoppingList() {
  if (!state.catalog) {
    return;
  }

  const next = {};

  for (const [groupId, quantity] of Object.entries(state.shoppingList)) {
    if (!state.catalog.groupsById.has(groupId)) {
      continue;
    }

    const parsed = Number.parseInt(quantity, 10);

    if (!Number.isFinite(parsed) || parsed < 1) {
      continue;
    }

    next[groupId] = parsed;
  }

  state.shoppingList = next;
  persistShoppingList();
}

function getShoppingSelections() {
  if (!state.catalog) {
    return [];
  }

  return Object.entries(state.shoppingList)
    .map(([groupId, quantity]) => {
      const group = state.catalog.groupsById.get(groupId);

      if (!group) {
        return null;
      }

      return {
        group,
        quantity,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.group.title.localeCompare(right.group.title, "pt-BR"));
}

function ensureValidNavigation() {
  const categoryExists =
    state.view.activeCategoryId === DEFAULT_CATEGORY_ID ||
    state.catalog.categories.some((category) => category.id === state.view.activeCategoryId);

  if (!categoryExists) {
    state.view.activeCategoryId = DEFAULT_CATEGORY_ID;
  }

  if (state.view.activeCategoryId === DEFAULT_CATEGORY_ID) {
    state.view.activeSubcategoryId = DEFAULT_SUBCATEGORY_ID;
    return;
  }

  const category = getActiveCategory();
  const subcategories = getFilteredSubcategories(category);
  const validSubcategoryIds = new Set(subcategories.map((subcategory) => subcategory.id));

  if (
    state.view.activeSubcategoryId !== DEFAULT_SUBCATEGORY_ID &&
    !validSubcategoryIds.has(state.view.activeSubcategoryId)
  ) {
    state.view.activeSubcategoryId = DEFAULT_SUBCATEGORY_ID;
  }
}

function buildCatalogModel(snapshot) {
  const categories = (snapshot.categories || []).map((category) => {
    const groups = (category.groups || []).map((group) =>
      enrichGroup(group, category),
    );

    return {
      ...category,
      groups,
      subcategories: buildSubcategories(groups, category.id),
    };
  });

  const groupsById = new Map();
  const allGroups = [];

  for (const category of categories) {
    for (const group of category.groups) {
      groupsById.set(group.id, group);
      allGroups.push(group);
    }
  }

  return {
    categories,
    groupsById,
    allGroups,
  };
}

function enrichGroup(group, category) {
  const subcategory = resolveSubcategoryMeta(category.id, group.essentialId);
  const cheapestOffer =
    group.cheapestOffer ||
    (group.offers || []).find((offer) => offer.isCheapest) ||
    group.offers?.[0] ||
    null;
  const bestDiscountPercent = Math.max(
    0,
    ...(group.offers || []).map((offer) =>
      Number.isFinite(offer.discountPercent) ? offer.discountPercent : 0,
    ),
  );
  const hasPromotion = (group.offers || []).some(
    (offer) =>
      offer.isPromotion ||
      (Number.isFinite(offer.originalPriceValue) && offer.originalPriceValue > offer.priceValue),
  );
  const searchHaystack = normalizeText(
    [
      group.title,
      group.packageLabel,
      group.essentialLabel,
      category.label,
      subcategory.label,
      ...(group.offers || []).flatMap((offer) => [
        offer.name,
        offer.storeLabel,
        offer.siteDomain,
      ]),
    ]
      .filter(Boolean)
      .join(" "),
  );

  return {
    ...group,
    categoryId: category.id,
    categoryLabel: category.label,
    subcategoryId: subcategory.id,
    subcategoryLabel: subcategory.label,
    cheapestOffer,
    bestDiscountPercent,
    hasPromotion,
    searchHaystack,
  };
}

function buildEssentialFamilies(groups, categoryId, subcategoryId) {
  const byEssential = new Map();

  for (const group of groups) {
    const current = byEssential.get(group.essentialId) || {
      essentialId: group.essentialId,
      essentialLabel: group.essentialLabel || group.title,
      categoryId,
      subcategoryId,
      groups: [],
      comparableCount: 0,
    };

    current.groups.push(group);
    current.comparableCount += group.isComparable ? 1 : 0;
    byEssential.set(group.essentialId, current);
  }

  return Array.from(byEssential.values())
    .map((family) => {
      const sortedGroups = family.groups.slice().sort(compareGroups);
      const cheapestGroup = sortedGroups[0];
      const bestDiscountGroup = sortedGroups
        .slice()
        .sort((left, right) => {
          if (right.bestDiscountPercent !== left.bestDiscountPercent) {
            return right.bestDiscountPercent - left.bestDiscountPercent;
          }

          return compareGroups(left, right);
        })[0] || cheapestGroup;
      const highlightGroup =
        (bestDiscountGroup?.bestDiscountPercent || 0) > 0
          ? bestDiscountGroup
          : cheapestGroup;

      return {
        ...family,
        groupCount: sortedGroups.length,
        groups: sortedGroups,
        cheapestGroup,
        bestDiscountGroup,
        bestDiscountPercent: bestDiscountGroup?.bestDiscountPercent || 0,
        highlightGroup,
        highlightReason:
          (bestDiscountGroup?.bestDiscountPercent || 0) > 0 ? "discount" : "price",
      };
    })
    .sort((left, right) => {
      const leftHighlightValue = left.highlightGroup?.lowestPriceValue;
      const rightHighlightValue = right.highlightGroup?.lowestPriceValue;

      if (leftHighlightValue !== rightHighlightValue) {
        return numericAsc(leftHighlightValue, rightHighlightValue);
      }

      return left.essentialLabel.localeCompare(right.essentialLabel, "pt-BR");
    });
}

function countEssentialFamilies(groups) {
  return new Set(groups.map((group) => group.essentialId)).size;
}

function getFamilyExpansionKey(categoryId, subcategoryId, essentialId) {
  return `${categoryId}:${subcategoryId}:${essentialId}`;
}

function buildSubcategories(groups, categoryId) {
  const byId = new Map();

  for (const group of groups) {
    const subcategory = resolveSubcategoryMeta(categoryId, group.essentialId);
    const current = byId.get(subcategory.id) || {
      id: subcategory.id,
      label: subcategory.label,
      groups: [],
      comparableCount: 0,
      lowestPriceValue: null,
    };

    current.groups.push(group);
    current.comparableCount += group.isComparable ? 1 : 0;

    if (
      Number.isFinite(group.lowestPriceValue) &&
      (!Number.isFinite(current.lowestPriceValue) || group.lowestPriceValue < current.lowestPriceValue)
    ) {
      current.lowestPriceValue = group.lowestPriceValue;
    }

    byId.set(subcategory.id, current);
  }

  return Array.from(byId.values())
    .map((subcategory) => ({
      ...subcategory,
      groups: subcategory.groups.slice().sort(compareGroups),
    }))
    .sort((left, right) => {
      if (right.groups.length !== left.groups.length) {
        return right.groups.length - left.groups.length;
      }

      return left.label.localeCompare(right.label, "pt-BR");
    });
}

function getCategoryCounts() {
  return state.catalog.categories.map((category) => ({
    id: category.id,
    label: category.label,
    count: applySearchAndModeFilters(category.groups).length,
  }));
}

function getFilteredSubcategories(category) {
  return buildSubcategories(applySearchAndModeFilters(category.groups), category.id);
}

function getActiveCategory() {
  if (!state.catalog || state.view.activeCategoryId === DEFAULT_CATEGORY_ID) {
    return null;
  }

  return state.catalog.categories.find((category) => category.id === state.view.activeCategoryId) || null;
}

function getContextGroups() {
  const baseGroups = (() => {
    if (state.view.activeCategoryId === DEFAULT_CATEGORY_ID) {
      return state.catalog?.allGroups || [];
    }

    const category = getActiveCategory();

    if (!category) {
      return [];
    }

    if (state.view.activeSubcategoryId === DEFAULT_SUBCATEGORY_ID) {
      return category.groups;
    }

    return category.groups.filter(
      (group) => group.subcategoryId === state.view.activeSubcategoryId,
    );
  })();

  return applySearchAndModeFilters(baseGroups);
}

function getSearchResults() {
  const groups = getContextGroups();
  const normalizedQuery = normalizeText(state.view.query);

  return groups
    .slice()
    .sort((left, right) => {
      const rightScore = computeSearchRelevance(right, normalizedQuery);
      const leftScore = computeSearchRelevance(left, normalizedQuery);

      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      return compareGroups(left, right);
    });
}

function applyModeFilter(groups) {
  return groups
    .filter((group) => {
      if (state.view.mode === "comparable") {
        return group.isComparable;
      }

      if (state.view.mode === "promo") {
        return group.hasPromotion;
      }

      return true;
    })
    .sort(compareGroups);
}

function applySearchAndModeFilters(groups) {
  const query = normalizeText(state.view.query);
  const filteredByMode = applyModeFilter(groups);

  if (!query) {
    return filteredByMode;
  }

  const tokens = query.split(" ").filter(Boolean);

  return filteredByMode.filter((group) =>
    tokens.every((token) => group.searchHaystack.includes(token)),
  );
}

function computeSearchRelevance(group, normalizedQuery) {
  if (!normalizedQuery) {
    return 0;
  }

  const title = normalizeText(group.title);
  const packageText = normalizeText(group.packageLabel);
  let score = 0;

  if (title === normalizedQuery) {
    score += 100;
  }

  if (title.startsWith(normalizedQuery)) {
    score += 50;
  }

  if (title.includes(normalizedQuery)) {
    score += 30;
  }

  if (packageText && packageText.includes(normalizedQuery)) {
    score += 12;
  }

  if (group.isComparable) {
    score += 6;
  }

  if (group.hasPromotion) {
    score += 4;
  }

  return score;
}

function compareGroups(left, right) {
  if (right.isComparable !== left.isComparable) {
    return Number(right.isComparable) - Number(left.isComparable);
  }

  if (right.hasPromotion !== left.hasPromotion) {
    return Number(right.hasPromotion) - Number(left.hasPromotion);
  }

  if (left.lowestPriceValue !== right.lowestPriceValue) {
    return numericAsc(left.lowestPriceValue, right.lowestPriceValue);
  }

  return left.title.localeCompare(right.title, "pt-BR");
}

function buildSubcategoryIndex(definitions) {
  const index = {};

  for (const [categoryId, subcategories] of Object.entries(definitions)) {
    index[categoryId] = {};

    for (const subcategory of subcategories) {
      for (const productId of subcategory.productIds) {
        index[categoryId][productId] = {
          id: subcategory.id,
          label: subcategory.label,
        };
      }
    }
  }

  return index;
}

function resolveSubcategoryMeta(categoryId, essentialId) {
  return (
    SUBCATEGORY_INDEX[categoryId]?.[essentialId] || {
      id: "outros",
      label: "Outros",
    }
  );
}

function getSubcategoryLimitKey(categoryId, subcategoryId) {
  return `${categoryId}:${subcategoryId}`;
}

function buildImage(url, alt) {
  if (!url) {
    return `
      <div class="image-fallback">
        <span>sem imagem</span>
      </div>
    `;
  }

  return `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt || "Produto")}" loading="lazy" />`;
}

function buildEmptyBlock(title, description) {
  return `
    <article class="empty-block">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(description)}</p>
    </article>
  `;
}

function buildMiniInfo(status) {
  if (!status) {
    return "";
  }

  const parts = [];

  if (status.city) {
    parts.push(`Cidade: ${toTitleCase(status.city)}`);
  }

  if (status.intervalMinutes) {
    parts.push(`Intervalo: ${status.intervalMinutes} min`);
  }

  if (status.startedAt) {
    parts.push(`Início: ${formatDate(status.startedAt)}`);
  }

  if (parts.length === 0) {
    return "";
  }

  return `<span class="status-mini">${escapeHtml(parts.join(" · "))}</span>`;
}

function resolveCategoryLabel(categoryId) {
  const categories = state.snapshot?.categories || [];
  const current = categories.find((category) => category.id === categoryId);
  return current?.label || "Categoria";
}

async function resolvePreferredCity() {
  const urlCity = new URLSearchParams(window.location.search).get("city");

  if (urlCity) {
    cacheUserCity(urlCity, "query");
    state.locationStatus = "query";
    return urlCity;
  }

  const cached = readCachedUserCity();

  if (cached?.city) {
    state.locationStatus = "cache";
    return cached.city;
  }

  if (!("geolocation" in navigator)) {
    state.locationStatus = "fallback";
    return null;
  }

  try {
    const position = await getCurrentPosition({
      enableHighAccuracy: false,
      timeout: 10_000,
      maximumAge: 30 * 60 * 1000,
    });
    const city = await resolveCityFromCoordinates(
      position.coords.latitude,
      position.coords.longitude,
    );

    if (city) {
      cacheUserCity(city, "geolocation");
      state.locationStatus = "geolocation";
      return city;
    }
  } catch {
    // usar fallback do servidor
  }

  state.locationStatus = "fallback";
  return null;
}

async function resolveCityFromCoordinates(latitude, longitude) {
  const url = new URL("/api/location/resolve", window.location.origin);
  url.searchParams.set("lat", latitude);
  url.searchParams.set("lon", longitude);
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Não foi possível resolver a cidade da localização.");
  }

  return data.city || null;
}

function getCurrentPosition(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function readCachedUserCity() {
  try {
    const raw = localStorage.getItem(USER_CITY_STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);

    if (!parsed?.city || !parsed?.at) {
      return null;
    }

    if (Date.now() - parsed.at > USER_CITY_CACHE_MS) {
      localStorage.removeItem(USER_CITY_STORAGE_KEY);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function cacheUserCity(city, source) {
  try {
    localStorage.setItem(
      USER_CITY_STORAGE_KEY,
      JSON.stringify({
        city,
        source,
        at: Date.now(),
      }),
    );
  } catch {
    // Ignorar falha de cache local.
  }
}

function computeSpreadWidth(group) {
  if (
    !Number.isFinite(group.lowestPriceValue) ||
    !Number.isFinite(group.highestPriceValue) ||
    group.highestPriceValue <= 0
  ) {
    return 0;
  }

  const ratio = (group.lowestPriceValue / group.highestPriceValue) * 100;
  return Math.max(12, Math.min(Math.round(ratio), 100));
}

function numericAsc(left, right) {
  if (left === right) {
    return 0;
  }

  if (left === null || left === undefined) {
    return 1;
  }

  if (right === null || right === undefined) {
    return -1;
  }

  return left - right;
}

function formatCurrency(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }

  return currencyFormatter.format(value);
}

function formatDate(value) {
  if (!value) {
    return "aguardando";
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return "aguardando";
  }

  return dateFormatter.format(parsed);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function readSiteValue(site, key) {
  if (!site || typeof site !== "object") {
    return null;
  }

  const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return site[key] ?? site[snakeKey] ?? null;
}

function readSiteFlag(site, key) {
  const value = readSiteValue(site, key);
  return value === true || value === "true" || value === 1;
}

function toTitleCase(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1).toLowerCase())
    .join(" ");
}

function toDomId(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
