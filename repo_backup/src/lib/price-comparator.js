const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");
const { ESSENTIAL_PRODUCTS } = require("./essential-products");
const { loadIssuuOffersFromPage } = require("./flyer-extractor");
const {
  DEFAULT_LINKS_FILE,
  inspectCandidate,
  normalizeUrl,
  parsePriceValue,
} = require("./auto-site-profiler");
const { ensureDir, toCsv } = require("./output-utils");
const { resolveFromCwd } = require("./scraper-core");

const DEFAULT_OUTPUT_ROOT = "output/comparisons";
const DEFAULT_VIEWPORT = { width: 1440, height: 2200 };
const DEFAULT_MAX_ITEMS_PER_QUERY = 80;
const MAX_TOP_MATCHES = 5;
const MAX_RELEVANT_MATCHES = 24;
const STOP_WORDS = new Set(["de", "da", "do", "das", "dos", "e", "em", "para", "com"]);

async function runPriceComparator({
  urls,
  inputFile = DEFAULT_LINKS_FILE,
  headless = true,
  city = null,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  maxItemsPerQuery = DEFAULT_MAX_ITEMS_PER_QUERY,
  products = null,
  stdoutOnly = false,
}) {
  const normalizedUrls = await resolveInputUrls(urls, inputFile);
  const selectedProducts = resolveSelectedProducts(products);
  const browser = await chromium.launch({ headless });
  const siteRuns = [];

  try {
    for (const inputUrl of normalizedUrls) {
      siteRuns.push(
        await compareSite(browser, {
          inputUrl,
          city,
          products: selectedProducts,
          maxItemsPerQuery,
        }),
      );
    }
  } finally {
    await browser.close();
  }

  const result = buildComparisonResult({
    city,
    inputUrls: normalizedUrls,
    products: selectedProducts,
    siteRuns,
  });

  const artifacts = stdoutOnly
    ? null
    : await writeComparisonOutputs({
        result,
        outputRoot,
        city,
      });

  return {
    ...result,
    artifacts,
  };
}

async function compareSite(browser, { inputUrl, city, products, maxItemsPerQuery }) {
  const normalizedInputUrl = normalizeUrl(inputUrl);
  const adapter = resolveAdapter(normalizedInputUrl);
  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    locale: "pt-BR",
  });

  try {
    const prepared = await adapter.prepare(context, {
      inputUrl: normalizedInputUrl,
      city,
    });
    const siteRows = [];
    const productResults = [];

    if (prepared.searchSupported !== false) {
      for (const product of products) {
        const searchResult = await adapter.search(context, {
          inputUrl: normalizedInputUrl,
          product,
          maxItems: maxItemsPerQuery,
          prepared,
        });
        const productResult = buildProductResult({
          product,
          searchResult,
          siteInfo: prepared.siteInfo,
        });

        productResults.push(productResult);
        siteRows.push(toComparisonRow(productResult));
      }
    }

    return {
      inputUrl: normalizedInputUrl,
      adapterId: adapter.id,
      siteInfo: prepared.siteInfo,
      searchSupported: prepared.searchSupported !== false,
      note: prepared.note || null,
      productResults,
      rows: siteRows,
    };
  } finally {
    await context.close();
  }
}

function resolveAdapter(inputUrl) {
  const hostname = new URL(normalizeUrl(inputUrl)).hostname.replace(/^www\./, "");

  if (hostname === "superkoch.com.br") {
    return superKochAdapter;
  }

  if (hostname === "redetoponline.com.br") {
    return redeTopAdapter;
  }

  if (hostname === "mercadofelisbino.com.br") {
    return mercadoFelisbinoAdapter;
  }

  if (hostname === "komprao.com.br") {
    return kompraoAdapter;
  }

  return genericAdapter;
}

const genericAdapter = {
  id: "generic",
  async prepare(_context, { inputUrl, city }) {
    const cityCoverage = city ? "unknown" : "default";

    return {
      searchSupported: true,
      note: null,
      siteInfo: {
        adapterId: "generic",
        sourceUrl: inputUrl,
        storeLabel: null,
        effectiveCity: null,
        requestedCity: city || null,
        cityCoverage,
        cityEligible: !city,
      },
    };
  },
  async search(context, { inputUrl, product, maxItems }) {
    const candidates = buildGenericSearchUrls(inputUrl, product.searchTerm);
    return runCandidateInspection(context, candidates, maxItems);
  },
};

const superKochAdapter = {
  id: "superkoch",
  async prepare(context, { inputUrl, city }) {
    const page = await context.newPage();

    try {
      await page.goto(inputUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.waitForTimeout(4_000);

      let locationNote = null;

      if (city) {
        const selection = await selectSuperKochStore(page, city);
        locationNote = selection.note || null;
      }

      const storeLabel = await readSuperKochStoreLabel(page);
      const effectiveCity = extractSuperKochCity(storeLabel);
      const storeCookie = parseSuperKochStoreCookie(await context.cookies());

      return {
        searchSupported: true,
        note: locationNote,
        siteInfo: {
          adapterId: "superkoch",
          sourceUrl: inputUrl,
          storeId: storeCookie?.id || null,
          storeLabel,
          effectiveCity,
          requestedCity: city || null,
          cityCoverage: determineCityCoverage({
            requestedCity: city,
            effectiveCity,
          }),
          cityEligible: isCityEligible({
            requestedCity: city,
            effectiveCity,
          }),
        },
      };
    } finally {
      await page.close();
    }
  },
  async search(context, { inputUrl, product, maxItems }) {
    const urlObject = new URL(inputUrl);
    const searchUrl = `${urlObject.origin}/busca/${encodeURIComponent(product.searchTerm)}`;
    const result = await runCandidateInspection(
      context,
      [searchUrl, `${urlObject.origin}/promocoes?search=${encodeURIComponent(product.searchTerm)}`],
      maxItems,
    );

    return preferSearchUrl(result, searchUrl, /\/busca\//i);
  },
};

const redeTopAdapter = {
  id: "redetop",
  async prepare(context, { inputUrl, city }) {
    const page = await context.newPage();

    try {
      await page.goto(inputUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.waitForTimeout(3_000);

      let storeLabel = null;
      let effectiveCity = null;
      let note = null;

      if (city) {
        const selection = await selectRedeTopStore(page, city);
        storeLabel = selection.storeLabel || null;
        effectiveCity = selection.effectiveCity || null;
        note = selection.note || null;
      }

      if (!storeLabel) {
        const body = await page.locator("body").innerText();
        storeLabel = extractRedeTopStoreLabel(body);
      }

      return {
        searchSupported: true,
        note,
        siteInfo: {
          adapterId: "redetop",
          sourceUrl: inputUrl,
          storeLabel,
          effectiveCity,
          requestedCity: city || null,
          cityCoverage: determineCityCoverage({
            requestedCity: city,
            effectiveCity,
          }),
          cityEligible: isCityEligible({
            requestedCity: city,
            effectiveCity,
          }),
        },
      };
    } finally {
      await page.close();
    }
  },
  async search(context, { inputUrl, product, maxItems }) {
    const urlObject = new URL(inputUrl);
    const searchUrl = `${urlObject.origin}/busca?termo=${encodeURIComponent(
      product.searchTerm,
    )}&departamento=0&page=1`;

    return preferSearchUrl(await runCandidateInspection(context, [searchUrl], maxItems), searchUrl);
  },
};

const mercadoFelisbinoAdapter = {
  id: "mercadofelisbino",
  async prepare(_context, { inputUrl, city }) {
    const effectiveCity = "Gaspar";

    return {
      searchSupported: true,
      note: null,
      siteInfo: {
        adapterId: "mercadofelisbino",
        sourceUrl: inputUrl,
        storeLabel: "Mercado Felisbino - Gaspar",
        effectiveCity,
        requestedCity: city || null,
        cityCoverage: determineCityCoverage({
          requestedCity: city,
          effectiveCity,
        }),
        cityEligible: isCityEligible({
          requestedCity: city,
          effectiveCity,
        }),
      },
    };
  },
  async search(context, { inputUrl, product, maxItems }) {
    const urlObject = new URL(inputUrl);
    const searchUrl = `${urlObject.origin}/listar.php?filtro=${encodeURIComponent(
      product.searchTerm,
    )}`;

    return preferSearchUrl(await runCandidateInspection(context, [searchUrl], maxItems), searchUrl);
  },
};

const kompraoAdapter = {
  id: "komprao",
  async prepare(context, { inputUrl, city }) {
    const page = await context.newPage();
    const cityPageUrl = resolveKompraoCityPageUrl(inputUrl, city);
    const effectiveCity = extractKompraoEffectiveCity(cityPageUrl);
    const cache = {
      flyerItems: [],
      publications: [],
      failedPublications: [],
    };
    let note = null;

    try {
      await page.goto(cityPageUrl || `${new URL(inputUrl).origin}/ofertas-por-cidade`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await page.waitForTimeout(2_000);

      if (!cityPageUrl) {
        note = "Cidade obrigatoria para ler o encarte do Komprão.";
      } else {
        const flyerCatalog = await loadIssuuOffersFromPage(page, {
          sourceUrl: inputUrl,
          cityPageUrl,
        });

        cache.flyerItems = flyerCatalog.items;
        cache.publications = flyerCatalog.publications;
        cache.failedPublications = flyerCatalog.diagnostics.failedPublications;

        if (cache.flyerItems.length > 0) {
          note = [
            `Encarte Issuu de ${effectiveCity || "cidade selecionada"} carregado.`,
            `${cache.publications.length} publicacao(oes), ${cache.flyerItems.length} oferta(s) extraida(s).`,
            cache.failedPublications.length > 0
              ? `${cache.failedPublications.length} publicacao(oes) falharam.`
              : null,
          ]
            .filter(Boolean)
            .join(" ");
        } else {
          note = [
            `Nenhuma oferta legivel foi extraida do encarte do Komprão em ${effectiveCity || "cidade selecionada"}.`,
            cache.failedPublications.length > 0
              ? `${cache.failedPublications.length} publicacao(oes) falharam na leitura.`
              : null,
          ]
            .filter(Boolean)
            .join(" ");
        }
      }
    } finally {
      await page.close();
    }

    return {
      searchSupported: cache.flyerItems.length > 0,
      note,
      siteInfo: {
        adapterId: "komprao",
        sourceUrl: inputUrl,
        storeLabel: effectiveCity ? `Komprao - ${effectiveCity}` : null,
        effectiveCity,
        requestedCity: city || null,
        cityCoverage: cityPageUrl
          ? determineCityCoverage({
              requestedCity: city,
              effectiveCity,
            })
          : city
            ? "unknown"
            : "default",
        cityEligible: cityPageUrl
          ? isCityEligible({
              requestedCity: city,
              effectiveCity,
            })
          : false,
        cityPageUrl,
      },
      cache,
    };
  },
  async search(_context, { prepared }) {
    const flyerItems = prepared.cache?.flyerItems || [];
    const publications = prepared.cache?.publications || [];
    const failedPublications = prepared.cache?.failedPublications || [];

    return {
      items: flyerItems,
      strategy: "flyer-issuu",
      candidateUrl: prepared.siteInfo.cityPageUrl || prepared.siteInfo.sourceUrl,
      finalUrl: prepared.siteInfo.cityPageUrl || prepared.siteInfo.sourceUrl,
      inspected: [
        ...publications.map((publication) => ({
          candidateUrl: publication.publicationUrl,
          finalUrl: prepared.siteInfo.cityPageUrl || prepared.siteInfo.sourceUrl,
          strategy: "flyer-issuu",
          itemsFound: publication.itemsFound,
          error: null,
        })),
        ...failedPublications.map((publication) => ({
          candidateUrl: publication.publicationUrl,
          finalUrl: prepared.siteInfo.cityPageUrl || prepared.siteInfo.sourceUrl,
          strategy: "flyer-issuu",
          itemsFound: 0,
          error: publication.error,
        })),
      ],
      note: prepared.note || null,
    };
  },
};

async function runCandidateInspection(context, candidates, maxItems) {
  const inspected = [];
  let bestCandidate = null;

  for (const candidateUrl of uniqueUrls(candidates)) {
    const candidate = await inspectCandidate(context, candidateUrl, { maxItems });

    inspected.push({
      candidateUrl: candidate.inputUrl,
      finalUrl: candidate.finalUrl,
      strategy: candidate.selected.strategy,
      itemsFound: candidate.selected.items.length,
      error: candidate.error,
    });

    if (!bestCandidate || compareCandidates(candidate, bestCandidate) > 0) {
      bestCandidate = candidate;
    }

    if (
      candidate.selected.strategy === "network" &&
      candidate.selected.items.length >= Math.min(10, maxItems)
    ) {
      break;
    }
  }

  return {
    items: bestCandidate?.selected.items || [],
    strategy: bestCandidate?.selected.strategy || "none",
    candidateUrl: bestCandidate?.inputUrl || null,
    finalUrl: bestCandidate?.finalUrl || null,
    inspected,
    note: bestCandidate?.error || null,
  };
}

function compareCandidates(left, right) {
  const leftCount = left.selected.items.length;
  const rightCount = right.selected.items.length;

  if (leftCount !== rightCount) {
    return leftCount - rightCount;
  }

  if (left.selected.strategy === "network" && right.selected.strategy !== "network") {
    return 1;
  }

  if (right.selected.strategy === "network" && left.selected.strategy !== "network") {
    return -1;
  }

  return 0;
}

function buildProductResult({ product, searchResult, siteInfo }) {
  const matches = searchResult.items
    .map((item) => buildMatchCandidate(product, item))
    .filter((candidate) => candidate.match.relevant)
    .sort((left, right) => {
      if (right.match.score !== left.match.score) {
        return right.match.score - left.match.score;
      }

      if (left.item.priceValue !== right.item.priceValue) {
        return numericAsc(left.item.priceValue, right.item.priceValue);
      }

      return left.item.name.localeCompare(right.item.name, "pt-BR");
    });

  const bestMatch = matches[0] || null;

  return {
    essentialId: product.id,
    essentialLabel: product.label,
    searchTerm: product.searchTerm,
    siteDomain: new URL(siteInfo.sourceUrl).hostname.replace(/^www\./, ""),
    sourceUrl: siteInfo.sourceUrl,
    storeLabel: siteInfo.storeLabel,
    effectiveCity: siteInfo.effectiveCity,
    requestedCity: siteInfo.requestedCity,
    cityCoverage: siteInfo.cityCoverage,
    cityEligible: Boolean(siteInfo.cityEligible),
    strategy: searchResult.strategy,
    candidateUrl: searchResult.candidateUrl,
    finalUrl: searchResult.finalUrl,
    inspected: searchResult.inspected,
    totalItems: searchResult.items.length,
    relevantItems: matches.length,
    found: Boolean(bestMatch),
    bestMatch: bestMatch
      ? {
          ...bestMatch.item,
          matchScore: bestMatch.match.score,
          matchedAliases: bestMatch.match.aliases,
          matchedTokens: bestMatch.match.tokens,
          excludedTokens: bestMatch.match.excludedTokens,
        }
      : null,
    topMatches: matches.slice(0, MAX_TOP_MATCHES).map((candidate) => ({
      ...candidate.item,
      matchScore: candidate.match.score,
      matchedAliases: candidate.match.aliases,
      matchedTokens: candidate.match.tokens,
      excludedTokens: candidate.match.excludedTokens,
    })),
    relevantMatches: matches.slice(0, MAX_RELEVANT_MATCHES).map((candidate) => ({
      ...candidate.item,
      matchScore: candidate.match.score,
      matchedAliases: candidate.match.aliases,
      matchedTokens: candidate.match.tokens,
      excludedTokens: candidate.match.excludedTokens,
    })),
    note: searchResult.note || null,
  };
}

function buildMatchCandidate(product, item) {
  const normalizedItem = normalizeComparableItem(item);

  if (normalizedItem.priceValue === null) {
    return {
      item: normalizedItem,
      match: {
        score: 0,
        relevant: false,
        aliases: [],
        tokens: [],
        excludedTokens: [],
      },
    };
  }

  const normalizedName = normalizeComparisonText(normalizedItem.name);
  const aliases = product.aliases
    .map((alias) => normalizeComparisonText(alias))
    .filter(Boolean);
  const excludeTerms = product.exclude
    .map((alias) => normalizeComparisonText(alias))
    .filter(Boolean);
  const searchTokens = tokenize(product.searchTerm);
  const matchedAliases = aliases.filter((alias) => hasPhrase(normalizedName, alias));
  const matchedTokens = searchTokens.filter((token) => tokenPresent(normalizedName, token));
  const excludedTokens = excludeTerms.filter((token) => hasPhrase(normalizedName, token));

  let score = 0;

  if (matchedAliases.length > 0) {
    score += 70 + matchedAliases[0].length;
  }

  score += matchedTokens.length * 18;

  if (startsWithAnyPhrase(normalizedName, aliases)) {
    score += 15;
  }

  if (item.isPromotion) {
    score += 4;
  }

  score -= excludedTokens.length * 35;

  const minimumTokenHits = searchTokens.length > 1 ? searchTokens.length : 1;
  const relevant =
    excludedTokens.length === 0 &&
    (matchedAliases.length > 0 || matchedTokens.length >= minimumTokenHits);

  return {
    item: normalizedItem,
    match: {
      score,
      relevant,
      aliases: matchedAliases,
      tokens: matchedTokens,
      excludedTokens,
    },
  };
}

function normalizeComparableItem(item) {
  const rawPriceValue = parsePriceValue(item.priceValue ?? item.price);
  const priceValue =
    rawPriceValue !== null && rawPriceValue !== undefined && rawPriceValue > 0
      ? rawPriceValue
      : null;
  const originalPriceValue = parsePriceValue(item.originalPriceValue ?? item.originalPrice);
  const isPromotion =
    Boolean(item.isPromotion) ||
    (originalPriceValue !== null && priceValue !== null && originalPriceValue > priceValue);

  return {
    id: item.id || null,
    name: item.name || null,
    price: item.price || null,
    priceValue,
    originalPrice:
      originalPriceValue !== null && priceValue !== null && originalPriceValue > priceValue
        ? item.originalPrice || formatCurrency(originalPriceValue)
        : null,
    originalPriceValue:
      originalPriceValue !== null && priceValue !== null && originalPriceValue > priceValue
        ? originalPriceValue
        : null,
    isPromotion,
    promotionLabel: item.promotionLabel || null,
    discountPercent: isPromotion
      ? item.discountPercent ??
        computeDiscountPercent({
          currentPriceValue: priceValue,
          originalPriceValue,
        })
      : null,
    unit: item.unit || null,
    image: item.image || null,
    link: item.link || null,
  };
}

function toComparisonRow(result) {
  const best = result.bestMatch || {};

  return {
    essential_id: result.essentialId,
    essential_label: result.essentialLabel,
    search_term: result.searchTerm,
    site_domain: result.siteDomain,
    source_url: result.sourceUrl,
    requested_city: result.requestedCity,
    effective_city: result.effectiveCity,
    city_coverage: result.cityCoverage,
    city_eligible: result.cityEligible,
    store_label: result.storeLabel,
    found: result.found,
    strategy: result.strategy,
    items_found: result.totalItems,
    relevant_items: result.relevantItems,
    product_name: best.name || null,
    price: best.price || null,
    price_value: best.priceValue ?? null,
    original_price: best.originalPrice || null,
    original_price_value: best.originalPriceValue ?? null,
    is_promotion: best.isPromotion ?? null,
    promotion_label: best.promotionLabel || null,
    discount_percent: best.discountPercent ?? null,
    unit: best.unit || null,
    product_url: best.link || null,
    image_url: best.image || null,
    match_score: best.matchScore ?? null,
    candidate_url: result.candidateUrl,
    final_url: result.finalUrl,
    note: result.note,
  };
}

function buildComparisonResult({ city, inputUrls, products, siteRuns }) {
  const comparisonRows = siteRuns.flatMap((run) => run.rows);
  const bestOfferRows = buildBestOfferRows(comparisonRows, city);
  const siteStatusRows = siteRuns.map((run) => ({
    site_domain: new URL(run.inputUrl).hostname.replace(/^www\./, ""),
    adapter_id: run.adapterId,
    source_url: run.inputUrl,
    search_supported: run.searchSupported,
    requested_city: run.siteInfo.requestedCity,
    effective_city: run.siteInfo.effectiveCity,
    city_coverage: run.siteInfo.cityCoverage,
    city_eligible: run.siteInfo.cityEligible,
    store_label: run.siteInfo.storeLabel,
    city_page_url: run.siteInfo.cityPageUrl || null,
    note: run.note,
  }));

  return {
    metadata: {
      comparedAt: new Date().toISOString(),
      requestedCity: city || null,
      totalSites: siteRuns.length,
      totalComparableSites: siteRuns.filter((run) => run.searchSupported).length,
      totalProducts: products.length,
      inputUrls,
    },
    sites: siteRuns.map((run) => ({
      adapterId: run.adapterId,
      searchSupported: run.searchSupported,
      note: run.note,
      ...run.siteInfo,
    })),
    essentials: products.map((product) => ({
      id: product.id,
      label: product.label,
      searchTerm: product.searchTerm,
      results: siteRuns
        .flatMap((run) => run.productResults)
        .filter((result) => result.essentialId === product.id),
    })),
    rows: comparisonRows,
    bestOffers: bestOfferRows,
    siteStatus: siteStatusRows,
  };
}

function buildBestOfferRows(rows, requestedCity) {
  const grouped = new Map();
  const eligibleRows = rows.filter((row) => {
    if (!row.found) {
      return false;
    }

    if (!requestedCity) {
      return true;
    }

    return row.city_eligible;
  });

  for (const row of eligibleRows) {
    const list = grouped.get(row.essential_id) || [];
    list.push(row);
    grouped.set(row.essential_id, list);
  }

  return Array.from(grouped.entries())
    .map(([essentialId, rowsForEssential]) => {
      const bestRow = [...rowsForEssential].sort((left, right) => {
        const priceDiff = numericAsc(left.price_value, right.price_value);

        if (priceDiff !== 0) {
          return priceDiff;
        }

        return right.match_score - left.match_score;
      })[0];

      return {
        essential_id: essentialId,
        essential_label: bestRow.essential_label,
        requested_city: requestedCity || null,
        site_domain: bestRow.site_domain,
        effective_city: bestRow.effective_city,
        store_label: bestRow.store_label,
        product_name: bestRow.product_name,
        price: bestRow.price,
        price_value: bestRow.price_value,
        original_price: bestRow.original_price,
        original_price_value: bestRow.original_price_value,
        is_promotion: bestRow.is_promotion,
        promotion_label: bestRow.promotion_label,
        discount_percent: bestRow.discount_percent,
        product_url: bestRow.product_url,
      };
    })
    .sort((left, right) => left.essential_label.localeCompare(right.essential_label, "pt-BR"));
}

async function writeComparisonOutputs({ result, outputRoot, city }) {
  const requestedCitySlug = city ? `-${slugifyText(city)}` : "";
  const runDir = resolveFromCwd(
    path.join(
      outputRoot,
      `${new Date().toISOString().replaceAll(":", "-")}${requestedCitySlug}`,
    ),
  );

  await ensureDir(runDir);

  const jsonPath = path.join(runDir, "comparison.json");
  const rowsCsvPath = path.join(runDir, "comparisons.csv");
  const bestOffersCsvPath = path.join(runDir, "best-offers.csv");
  const siteStatusCsvPath = path.join(runDir, "site-status.csv");

  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
  await fs.writeFile(rowsCsvPath, toCsv(result.rows), "utf8");
  await fs.writeFile(bestOffersCsvPath, toCsv(result.bestOffers), "utf8");
  await fs.writeFile(siteStatusCsvPath, toCsv(result.siteStatus), "utf8");

  return {
    outputDir: runDir,
    jsonPath,
    rowsCsvPath,
    bestOffersCsvPath,
    siteStatusCsvPath,
  };
}

async function resolveInputUrls(urls, inputFile) {
  if (Array.isArray(urls) && urls.length > 0) {
    return uniqueUrls(urls.map(normalizeUrl));
  }

  const filePath = resolveFromCwd(inputFile);
  const content = await fs.readFile(filePath, "utf8");

  return uniqueUrls(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map(normalizeUrl),
  );
}

function resolveSelectedProducts(products) {
  if (!products || products.length === 0) {
    return ESSENTIAL_PRODUCTS;
  }

  const wanted = new Set(products.map((product) => slugifyText(product)));
  const selected = ESSENTIAL_PRODUCTS.filter(
    (product) => wanted.has(product.id) || wanted.has(slugifyText(product.label)),
  );

  if (selected.length === 0) {
    throw new Error("Nenhum produto essencial valido foi selecionado em --products.");
  }

  return selected;
}

function buildGenericSearchUrls(inputUrl, query) {
  const urlObject = new URL(inputUrl);
  const encodedQuery = encodeURIComponent(query);

  return [
    `${urlObject.origin}/busca/${encodedQuery}`,
    `${urlObject.origin}/busca?termo=${encodedQuery}`,
    `${urlObject.origin}/busca?q=${encodedQuery}`,
    `${urlObject.origin}/buscar?termo=${encodedQuery}`,
    `${urlObject.origin}/buscar?q=${encodedQuery}`,
    `${urlObject.origin}/search?q=${encodedQuery}`,
    `${urlObject.origin}/produtos?search=${encodedQuery}`,
    `${urlObject.origin}/catalogsearch/result/?q=${encodedQuery}`,
    `${urlObject.origin}/listar.php?filtro=${encodedQuery}`,
  ];
}

async function selectSuperKochStore(page, city) {
  const cityPattern = new RegExp(`Superkoch\\s+LJ\\d+\\s+-\\s+${escapeRegex(city)}`, "i");

  await page.waitForSelector("#store-btn", {
    state: "visible",
    timeout: 12_000,
  });
  await page.locator("#store-btn").click({ timeout: 8_000 });
  await page.waitForTimeout(1_500);

  const storeOption = page.getByText(cityPattern, { exact: false }).first();

  if (!(await storeOption.isVisible().catch(() => false))) {
    return {
      note: `Cidade nao encontrada no seletor do Superkoch: ${city}.`,
    };
  }

  await storeOption.click({ timeout: 8_000 });
  await page.waitForTimeout(1_000);

  const confirmButton = page.getByRole("button", { name: /confirmar/i }).last();
  await confirmButton.click({ timeout: 8_000 });
  await page.waitForTimeout(4_000);

  return {
    note: null,
  };
}

async function readSuperKochStoreLabel(page) {
  const directLabel = await page
    .locator("#store-btn")
    .innerText()
    .then((value) => value.replace(/\s+/g, " ").trim())
    .catch(() => null);

  if (directLabel) {
    return directLabel;
  }

  const body = await page.locator("body").innerText();
  const match = body.match(/Loja de\s*([^\n]+)\s*Retirada/i);
  return match ? match[1].trim() : null;
}

function parseSuperKochStoreCookie(cookies) {
  const cookie = cookies.find((entry) => entry.name === "st");

  if (!cookie?.value) {
    return null;
  }

  try {
    return JSON.parse(decodeURIComponent(cookie.value));
  } catch {
    return null;
  }
}

function extractSuperKochCity(storeLabel) {
  if (!storeLabel) {
    return null;
  }

  const match = storeLabel.match(/-\s*([^(]+?)(?:\s*\(|$)/);
  return match ? toTitleCase(match[1].trim()) : null;
}

function extractRedeTopStoreLabel(body) {
  const lines = String(body || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const index = lines.findIndex((line) => /Retirar na loja:/i.test(line));

  if (index === -1) {
    return null;
  }

  return lines.slice(index, index + 2).join(" ");
}

async function selectRedeTopStore(page, city) {
  const cityName = toTitleCase(city);
  const toggleButton = page
    .locator("button.vip-button")
    .filter({ hasText: /Retirar na loja:/i })
    .first();

  if (!(await toggleButton.isVisible().catch(() => false))) {
    return {
      note: `Nao foi possivel localizar o seletor de loja do Rede Top para ${cityName}.`,
    };
  }

  await toggleButton.click({ timeout: 5_000 });
  await page.waitForTimeout(1_500);

  const preferredTile = page
    .locator(".vip-selectable-tile")
    .filter({ hasText: new RegExp(`Rede Top\\s+-\\s*${escapeRegex(cityName)}\\b`, "i") })
    .first();
  const fallbackTile = page
    .locator(".vip-selectable-tile")
    .filter({ hasText: new RegExp(escapeRegex(cityName), "i") })
    .first();

  const tile = (await preferredTile.isVisible().catch(() => false))
    ? preferredTile
    : fallbackTile;

  if (!(await tile.isVisible().catch(() => false))) {
    return {
      note: `Cidade ${cityName} nao encontrada no seletor de lojas do Rede Top.`,
    };
  }

  const tileText = await tile.innerText().catch(() => "");
  await tile.click({ timeout: 5_000 });
  await page.waitForTimeout(1_500);

  const confirmButton = page
    .getByRole("button", { name: /continuar e fechar/i })
    .first();

  if (await confirmButton.isVisible().catch(() => false)) {
    await confirmButton.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(2_500);
  }

  return {
    note: null,
    storeLabel: extractRedeTopStoreLabelFromTile(tileText) || `Rede Top - ${cityName}`,
    effectiveCity: cityName,
  };
}

function extractRedeTopStoreLabelFromTile(tileText) {
  const lines = String(tileText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  return lines[0];
}

function preferSearchUrl(result, searchUrl, expectedPattern = null) {
  if (!result.finalUrl) {
    return {
      ...result,
      finalUrl: searchUrl,
    };
  }

  if (expectedPattern && !expectedPattern.test(result.finalUrl)) {
    return {
      ...result,
      finalUrl: searchUrl,
    };
  }

  return result;
}

function resolveKompraoCityPageUrl(inputUrl, city) {
  const urlObject = new URL(inputUrl);
  const directMatch = urlObject.pathname.match(/^\/ofertas\/([^/]+)\/?$/i);

  if (directMatch && !/por-cidade/i.test(directMatch[1])) {
    return `${urlObject.origin}/ofertas/${directMatch[1]}`;
  }

  if (!city) {
    return null;
  }

  return `${urlObject.origin}/ofertas/${slugifyText(city)}`;
}

function extractKompraoEffectiveCity(cityPageUrl) {
  if (!cityPageUrl) {
    return null;
  }

  const match = String(cityPageUrl).match(/\/ofertas\/([^/?#]+)/i);
  return match ? toTitleCase(match[1].replace(/-/g, " ")) : null;
}

function determineCityCoverage({ requestedCity, effectiveCity }) {
  if (!requestedCity) {
    return "default";
  }

  if (!effectiveCity) {
    return "unknown";
  }

  return normalizeComparisonText(requestedCity) === normalizeComparisonText(effectiveCity)
    ? "match"
    : "mismatch";
}

function isCityEligible({ requestedCity, effectiveCity }) {
  if (!requestedCity) {
    return true;
  }

  if (!effectiveCity) {
    return false;
  }

  return normalizeComparisonText(requestedCity) === normalizeComparisonText(effectiveCity);
}

function normalizeComparisonText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeComparisonText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token && !STOP_WORDS.has(token));
}

function hasPhrase(text, phrase) {
  if (!text || !phrase) {
    return false;
  }

  return ` ${text} `.includes(` ${phrase} `);
}

function startsWithAnyPhrase(text, phrases) {
  return phrases.some((phrase) => text.startsWith(phrase));
}

function tokenPresent(text, token) {
  return tokenize(text).includes(token);
}

function formatCurrency(value) {
  return Number.isFinite(value) ? `R$ ${value.toFixed(2).replace(".", ",")}` : null;
}

function computeDiscountPercent({ currentPriceValue, originalPriceValue }) {
  if (
    currentPriceValue === null ||
    currentPriceValue === undefined ||
    originalPriceValue === null ||
    originalPriceValue === undefined ||
    originalPriceValue <= currentPriceValue
  ) {
    return null;
  }

  return Math.round(((originalPriceValue - currentPriceValue) / originalPriceValue) * 100);
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueUrls(urls) {
  return Array.from(new Set(urls.map((url) => normalizeUrl(url))));
}

function slugifyText(value) {
  return normalizeComparisonText(value).replace(/\s+/g, "-");
}

function toTitleCase(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
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

module.exports = {
  DEFAULT_OUTPUT_ROOT,
  runPriceComparator,
};
