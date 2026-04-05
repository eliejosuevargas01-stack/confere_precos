const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");
const {
  inspectCandidate,
  normalizeUrl,
  parsePriceValue,
  sanitizeProductText,
} = require("./auto-site-profiler");
const { ensureDir, slugify, toCsv } = require("./output-utils");
const { exportRedeTopCatalog } = require("./redetop-catalog");
const { resolveFromCwd } = require("./scraper-core");
const { prepareCatalogSiteContext } = require("./city-context-discovery");

const DEFAULT_OUTPUT_ROOT = "data/catalog-api/catalog-runs";
const DEFAULT_MAX_SECTIONS = 20;
const DEFAULT_MAX_PAGES_PER_SECTION = 8;
const DEFAULT_MAX_ITEMS_PER_PAGE = 250;
const DEFAULT_VIEWPORT = { width: 1440, height: 2200 };
const ROOT_DISCOVERY_LIMIT = 10;

async function scrapeIntelligentCatalog({
  url,
  label = null,
  city = null,
  headless = true,
  adapterHint = "auto",
  outputRoot = DEFAULT_OUTPUT_ROOT,
  maxSections = DEFAULT_MAX_SECTIONS,
  maxPagesPerSection = DEFAULT_MAX_PAGES_PER_SECTION,
  maxItemsPerPage = DEFAULT_MAX_ITEMS_PER_PAGE,
  onLog = null,
} = {}) {
  const sourceUrl = normalizeUrl(url);
  const hostname = new URL(sourceUrl).hostname.replace(/^www\./, "");
  const adapterId = resolveCatalogAdapter(sourceUrl, adapterHint);

  log(onLog, "info", "Iniciando descoberta inteligente de catalogo.", {
    sourceUrl,
    hostname,
    adapterId,
    city,
    maxSections,
    maxPagesPerSection,
    maxItemsPerPage,
  });

  if (adapterId === "redetop-full") {
    const result = await exportRedeTopCatalog({
      city,
      headless,
      outputRoot,
      maxDepartments: maxSections,
      maxPagesPerDepartment: maxPagesPerSection,
      baseUrl: sourceUrl,
      onLog,
    });

    return {
      metadata: {
        ...result.metadata,
        label: label || result.metadata.storeLabel || hostname,
        adapterId,
        sourceUrl,
        catalogDetected: (result.products?.length || 0) > 0,
      },
      discovery: {
        rootUrl: sourceUrl,
        sectionsDiscovered: result.departments.length,
        adapterId,
      },
      sections: result.departments.map((department) => ({
        id: department.departmentId,
        label: department.departmentLabel,
        url: department.departmentUrl,
        totalPages: department.totalPages,
        totalProducts: department.totalProducts,
        scrapedProducts: department.scrapedProducts,
      })),
      products: result.products,
      paths: result.paths,
    };
  }

  return scrapeGenericFullCatalog({
    url: sourceUrl,
    label,
    city,
    headless,
    outputRoot,
    hostname,
    adapterId,
    maxSections,
    maxPagesPerSection,
    maxItemsPerPage,
    onLog,
  });
}

async function scrapeGenericFullCatalog({
  url,
  label,
  city,
  headless,
  outputRoot,
  hostname,
  adapterId,
  maxSections,
  maxPagesPerSection,
  maxItemsPerPage,
  onLog,
}) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    locale: "pt-BR",
  });

  try {
    const siteContext = await prepareCatalogSiteContext({
      context,
      sourceUrl: url,
      city,
      adapterId,
      onLog,
    });
    const discoveryStartUrl = siteContext.contextUrl || url;
    const rootDiscovery = await discoverCatalogRoot(
      context,
      discoveryStartUrl,
      maxItemsPerPage,
      onLog,
      siteContext.preferredCatalogRoots,
    );
    const sections = await discoverCatalogSections(
      context,
      rootDiscovery.rootUrl,
      maxSections,
      onLog,
    );
    const effectiveSections =
      sections.length > 0
        ? sections
        : [
            {
              id: slugify(rootDiscovery.rootUrl),
              label: "Catalogo principal",
              url: rootDiscovery.rootUrl,
              score: 0,
            },
          ];

    log(
      onLog,
      sections.length > 0 ? "info" : "warn",
      sections.length > 0
        ? "Secoes de catalogo descobertas."
        : "Nenhuma secao explicita encontrada; sera usado apenas o catalogo principal.",
      {
        rootUrl: rootDiscovery.rootUrl,
        sectionsDiscovered: sections.length,
      },
    );

    const sectionResults = [];
    const allProducts = [];

    for (const section of effectiveSections) {
      log(onLog, "info", "Iniciando processamento de secao do catalogo.", {
        sectionId: section.id,
        sectionLabel: section.label,
        sectionUrl: section.url,
      });

      const result = await scrapeCatalogSection(context, section, {
        maxPagesPerSection,
        maxItemsPerPage,
        onLog,
      });

      if (result.products.length === 0) {
        log(onLog, "warn", "Secao processada sem produtos aproveitaveis.", {
          sectionId: section.id,
          sectionLabel: section.label,
          sectionUrl: section.url,
          totalPages: result.totalPages,
        });
        continue;
      }

      sectionResults.push(result);
      allProducts.push(...result.products);
    }

    const products = dedupeProducts(allProducts);
    const paths = await writeCatalogArtifacts({
      outputRoot,
      hostname,
      label,
      city,
      siteContext,
      sourceUrl: url,
      adapterId,
      discovery: rootDiscovery,
      sections: sectionResults,
      products,
    });

    log(
      onLog,
      products.length > 0 ? "info" : "warn",
      products.length > 0
        ? "Catalogo generico concluido com produtos encontrados."
        : "Catalogo generico concluido sem produtos aproveitaveis.",
      {
        rootUrl: rootDiscovery.rootUrl,
        totalSections: sectionResults.length,
        totalProducts: products.length,
        catalogDetected: products.length > 0,
      },
    );

    return {
      metadata: {
        generatedAt: new Date().toISOString(),
        label: label || hostname,
        requestedCity: city || null,
        effectiveCity: siteContext.effectiveCity || null,
        storeLabel: siteContext.storeLabel || null,
        cityCoverage: siteContext.cityCoverage || null,
        cityEligible: siteContext.cityEligible,
        contextUrl: siteContext.contextUrl || null,
        citySelectionStrategy: siteContext.strategy || null,
        citySelectionNote: siteContext.note || null,
        adapterId,
        sourceUrl: url,
        hostname,
        totalSections: sectionResults.length,
        totalProducts: products.length,
        catalogDetected: products.length > 0,
      },
      discovery: {
        ...rootDiscovery,
        siteContext,
      },
      sections: sectionResults.map((section) => ({
        id: section.id,
        label: section.label,
        url: section.url,
        totalPages: section.totalPages,
        scrapedPages: section.pages.length,
        totalProducts: section.products.length,
      })),
      products,
      paths,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function discoverCatalogRoot(
  context,
  sourceUrl,
  maxItemsPerPage,
  onLog,
  preferredCatalogRoots = [],
) {
  const inspected = [];
  const seen = new Set();
  const initialCandidates = uniqueUrls([
    ...preferredCatalogRoots,
    sourceUrl,
    ...buildCatalogRootCandidates(sourceUrl),
  ]).slice(0, ROOT_DISCOVERY_LIMIT);

  log(onLog, "info", "Iniciando descoberta da raiz do catalogo.", {
    sourceUrl,
    initialCandidates,
  });

  let pending = [...initialCandidates];

  while (pending.length > 0 && inspected.length < ROOT_DISCOVERY_LIMIT) {
    const candidateUrl = pending.shift();

    if (!candidateUrl || seen.has(candidateUrl)) {
      continue;
    }

    seen.add(candidateUrl);
    const candidate = await inspectCandidate(context, candidateUrl, { maxItems: maxItemsPerPage });
    inspected.push(candidate);

    log(
      onLog,
      candidate.selected.items.length > 0 ? "info" : "warn",
      "Candidato de catalogo inspecionado.",
      {
        inputUrl: candidate.inputUrl,
        finalUrl: candidate.finalUrl,
        title: candidate.title,
        strategy: candidate.selected.strategy,
        productsFound: candidate.selected.items.length,
        discoveredLinks: candidate.discoveredLinks.length,
        error: candidate.error || null,
      },
    );

    for (const discovered of candidate.discoveredLinks || []) {
      const normalized = normalizeUrl(discovered);

      if (seen.has(normalized) || pending.includes(normalized)) {
        continue;
      }

      if (isLikelyCatalogLink(normalized)) {
        pending.push(normalized);
      }
    }
  }

  const scored = inspected
    .map((candidate) => ({
      candidate,
      score: scoreCatalogRootCandidate(candidate),
    }))
    .sort((left, right) => right.score - left.score);
  const best = scored[0]?.candidate || inspected[0];

  log(
    onLog,
    best ? "info" : "warn",
    best
      ? "Raiz do catalogo selecionada."
      : "Nenhum candidato claro encontrado; sera usada a URL original.",
    {
      selectedRootUrl: best?.finalUrl || best?.inputUrl || sourceUrl,
      inspectedCandidates: scored.length,
    },
  );

  return {
    rootUrl: best?.finalUrl || best?.inputUrl || sourceUrl,
    inspectedCandidates: scored.map((entry) => ({
      inputUrl: entry.candidate.inputUrl,
      finalUrl: entry.candidate.finalUrl,
      title: entry.candidate.title,
      strategy: entry.candidate.selected.strategy,
      productsFound: entry.candidate.selected.items.length,
      discoveredLinks: entry.candidate.discoveredLinks.length,
      score: entry.score,
    })),
  };
}

function scoreCatalogRootCandidate(candidate) {
  const url = String(candidate.finalUrl || candidate.inputUrl || "");
  let score =
    Math.min(candidate.selected.items.length, 40) * 5 +
    Math.min(candidate.discoveredLinks.length, 30) * 12;

  if (candidate.selected.strategy === "network") {
    score += 30;
  }

  if (/categorias?|category|departamentos?|department/i.test(url)) {
    score += 180;
  }

  if (/produt|catalog|shop|listar/i.test(url)) {
    score += 60;
  }

  if (/oferta|encarte|promoc/i.test(url)) {
    score -= 260;
  }

  return score;
}

async function discoverCatalogSections(context, rootUrl, maxSections, onLog) {
  const page = await context.newPage();

  try {
    await page.goto(rootUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await settleCatalogPage(page);

    const sections = await page.evaluate(({ maxCount }) => {
      const includePattern =
        /(categoria|categorias|departamento|departamentos|secao|secoes|setor|catalog|category|department|shop|produto|produtos|mercado)/i;
      const excludePattern =
        /(login|conta|institucional|blog|contato|faq|privacidade|cookie|carrinho|cart|encarte|ofertas|promoc|favorito|wishlist|club)/i;
      const productPattern = /\/produto\/|\/p\/|sku=|product_id=/i;
      const currentOrigin = window.location.origin;

      const candidates = Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => ({
          label: String(anchor.innerText || anchor.textContent || "")
            .replace(/\s+/g, " ")
            .trim(),
          url: anchor.href,
        }))
        .filter((entry) => entry.url && entry.url.startsWith(currentOrigin))
        .filter((entry) => !productPattern.test(entry.url))
        .filter((entry) => includePattern.test(`${entry.label} ${entry.url}`))
        .filter((entry) => !excludePattern.test(`${entry.label} ${entry.url}`))
        .map((entry) => ({
          ...entry,
          score: scoreSection(entry),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, maxCount * 3);

      const unique = [];
      const seen = new Set();

      for (const entry of candidates) {
        if (seen.has(entry.url)) {
          continue;
        }

        seen.add(entry.url);
        unique.push({
          id: entry.label ? entry.label.toLowerCase().replace(/[^a-z0-9]+/g, "-") : entry.url,
          label: entry.label || "Secao",
          url: entry.url,
          score: entry.score,
        });

        if (unique.length >= maxCount) {
          break;
        }
      }

      return unique;

      function scoreSection(entry) {
        const haystack = `${entry.label} ${entry.url}`;
        let score = 0;

        if (/departamento|departamentos|department/i.test(haystack)) {
          score += 25;
        }

        if (/categoria|categorias|category/i.test(haystack)) {
          score += 20;
        }

        if (/produtos|catalog|shop/i.test(haystack)) {
          score += 12;
        }

        if (entry.label.length > 2 && entry.label.length <= 80) {
          score += 8;
        }

        return score;
      }
    }, { maxCount: maxSections });

    const uniqueSections = uniqueUrlsByKey(
      sections.map((section) => ({
        ...section,
        id: slugify(section.id || section.label || section.url),
        label: section.label || "Secao",
      })),
      (section) => section.url,
    );

    log(
      onLog,
      uniqueSections.length > 0 ? "info" : "warn",
      "Descoberta de secoes do catalogo concluida.",
      {
        rootUrl,
        totalSections: uniqueSections.length,
        sections: uniqueSections.slice(0, 20).map((section) => ({
          label: section.label,
          url: section.url,
        })),
      },
    );

    return uniqueSections;
  } finally {
    await page.close();
  }
}

async function scrapeCatalogSection(
  context,
  section,
  { maxPagesPerSection, maxItemsPerPage, onLog },
) {
  const pageUrls = await discoverSectionPageUrls(context, section.url, maxPagesPerSection);
  const pages = [];
  const products = [];
  const seenPageFingerprints = new Set();

  log(onLog, "info", "Paginas da secao descobertas.", {
    sectionId: section.id,
    sectionLabel: section.label,
    sectionUrl: section.url,
    totalPagesDiscovered: pageUrls.length,
    pageUrls: pageUrls.slice(0, 20),
  });

  for (const pageUrl of pageUrls) {
    const candidate = await inspectCandidate(context, pageUrl, { maxItems: maxItemsPerPage });
    const fingerprint = buildItemsFingerprint(candidate.selected.items);

    if (seenPageFingerprints.has(fingerprint)) {
      log(onLog, "info", "Pagina ignorada por fingerprint duplicada.", {
        sectionId: section.id,
        sectionLabel: section.label,
        pageUrl,
        finalUrl: candidate.finalUrl,
      });
      continue;
    }

    seenPageFingerprints.add(fingerprint);
    const pageProducts = candidate.selected.items
      .map((item) => normalizeCatalogProduct(item, section, pageUrl))
      .filter(Boolean);

    if (pageProducts.length === 0) {
      log(onLog, "warn", "Pagina processada sem produtos validos.", {
        sectionId: section.id,
        sectionLabel: section.label,
        pageUrl,
        finalUrl: candidate.finalUrl,
        strategy: candidate.selected.strategy,
      });
      continue;
    }

    pages.push({
      url: pageUrl,
      finalUrl: candidate.finalUrl,
      strategy: candidate.selected.strategy,
      productsFound: pageProducts.length,
    });
    products.push(...pageProducts);

    log(onLog, "info", "Pagina da secao processada.", {
      sectionId: section.id,
      sectionLabel: section.label,
      pageUrl,
      finalUrl: candidate.finalUrl,
      strategy: candidate.selected.strategy,
      productsFound: pageProducts.length,
    });
  }

  const dedupedProducts = dedupeProducts(products);

  log(
    onLog,
    dedupedProducts.length > 0 ? "info" : "warn",
    "Secao concluida.",
    {
      sectionId: section.id,
      sectionLabel: section.label,
      totalPagesDiscovered: pageUrls.length,
      pagesScraped: pages.length,
      totalProducts: dedupedProducts.length,
    },
  );

  return {
    id: section.id,
    label: section.label,
    url: section.url,
    totalPages: pageUrls.length,
    pages,
    products: dedupedProducts,
  };
}

async function discoverSectionPageUrls(context, sectionUrl, maxPagesPerSection) {
  const page = await context.newPage();

  try {
    await page.goto(sectionUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await settleCatalogPage(page);

    const discovered = await page.evaluate(({ limit }) => {
      const current = new URL(window.location.href);
      const sameOrigin = current.origin;
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => ({
          text: String(anchor.innerText || anchor.textContent || "")
            .replace(/\s+/g, " ")
            .trim(),
          href: anchor.href,
        }))
        .filter((entry) => entry.href && entry.href.startsWith(sameOrigin))
        .filter((entry) => /page=|pagina=|\/page\/|\b\d+\b/.test(`${entry.text} ${entry.href}`));

      const numericTexts = links
        .map((entry) => Number.parseInt(entry.text, 10))
        .filter((value) => Number.isFinite(value) && value > 1 && value <= limit);

      const explicitUrls = links
        .filter((entry) => /page=|pagina=|\/page\/\d+/i.test(entry.href))
        .map((entry) => entry.href);

      const synthesized = [];
      const maxNumeric = numericTexts.length > 0 ? Math.max(...numericTexts) : 1;

      if (maxNumeric > 1) {
        for (let pageNumber = 2; pageNumber <= Math.min(maxNumeric, limit); pageNumber += 1) {
          const next = new URL(current.href);
          next.searchParams.set("page", String(pageNumber));
          synthesized.push(next.toString());
        }
      }

      return [current.toString(), ...explicitUrls, ...synthesized];
    }, { limit: maxPagesPerSection });

    return uniqueUrls(discovered).slice(0, Math.max(maxPagesPerSection, 1));
  } finally {
    await page.close();
  }
}

function normalizeCatalogProduct(item, section, pageUrl) {
  const priceValue = parsePriceValue(item.priceValue ?? item.price);

  if (!priceValue || priceValue <= 0) {
    return null;
  }

  const originalPriceValue = parsePriceValue(item.originalPriceValue ?? item.originalPrice);
  const normalizedName = sanitizeProductText(item.name);

  if (!normalizedName) {
    return null;
  }

  return {
    id: item.id || null,
    name: normalizedName,
    price: item.price || `R$ ${priceValue.toFixed(2).replace(".", ",")}`,
    priceValue,
    originalPrice:
      originalPriceValue && originalPriceValue > priceValue
        ? item.originalPrice || `R$ ${originalPriceValue.toFixed(2).replace(".", ",")}`
        : null,
    originalPriceValue:
      originalPriceValue && originalPriceValue > priceValue ? originalPriceValue : null,
    isPromotion:
      Boolean(item.isPromotion) ||
      Boolean(originalPriceValue && originalPriceValue > priceValue),
    promotionLabel: item.promotionLabel || null,
    discountPercent: normalizeDiscountPercent(
      item.discountPercent,
      priceValue,
      originalPriceValue,
    ),
    unit: item.unit || null,
    image: item.image || null,
    link: item.link || null,
    sectionId: section.id,
    sectionLabel: section.label,
    sectionUrl: section.url,
    pageUrl,
  };
}

async function settleCatalogPage(page) {
  await page.waitForTimeout(1_500);

  for (let index = 0; index < 3; index += 1) {
    await page.mouse.wheel(0, 1_200);
    await page.waitForTimeout(900);
  }

  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(1_000);
}

async function writeCatalogArtifacts({
  outputRoot,
  hostname,
  label,
  city,
  siteContext,
  sourceUrl,
  adapterId,
  discovery,
  sections,
  products,
}) {
  const rootDir = resolveFromCwd(outputRoot);
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const runDir = path.join(rootDir, `${stamp}-${slugify(label || hostname)}`);
  const summaryPath = path.join(runDir, "summary.json");
  const jsonPath = path.join(runDir, "catalog.json");
  const csvPath = path.join(runDir, "catalog.csv");

  await ensureDir(runDir);

  const summary = {
    generatedAt: new Date().toISOString(),
    label: label || hostname,
    requestedCity: city || null,
    effectiveCity: siteContext?.effectiveCity || null,
    storeLabel: siteContext?.storeLabel || null,
    cityCoverage: siteContext?.cityCoverage || null,
    cityEligible:
      typeof siteContext?.cityEligible === "boolean" ? siteContext.cityEligible : null,
    contextUrl: siteContext?.contextUrl || null,
    citySelectionStrategy: siteContext?.strategy || null,
    citySelectionNote: siteContext?.note || null,
    sourceUrl,
    adapterId,
    totalSections: sections.length,
    totalProducts: products.length,
    rootUrl: discovery.rootUrl,
    sections: sections.map((section) => ({
      id: section.id,
      label: section.label,
      url: section.url,
      totalPages: section.totalPages,
      scrapedPages: section.pages.length,
      totalProducts: section.products.length,
    })),
  };

  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        metadata: summary,
        discovery,
        sections,
        products,
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(csvPath, toCsv(products), "utf8");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  return {
    runDir,
    summaryPath,
    jsonPath,
    csvPath,
  };
}

function resolveCatalogAdapter(url, adapterHint) {
  if (adapterHint && adapterHint !== "auto") {
    return adapterHint;
  }

  const hostname = new URL(url).hostname.replace(/^www\./, "");

  if (hostname === "redetoponline.com.br") {
    return "redetop-full";
  }

  return "generic-full";
}

function buildCatalogRootCandidates(sourceUrl) {
  const origin = new URL(sourceUrl).origin;

  return [
    `${origin}/produtos`,
    `${origin}/categorias`,
    `${origin}/categoria`,
    `${origin}/departamentos`,
    `${origin}/departamento`,
    `${origin}/shop`,
    `${origin}/catalog`,
    `${origin}/catalogo`,
    `${origin}/listar.php`,
    `${origin}/loja`,
  ];
}

function isLikelyCatalogLink(url) {
  return /depart|categoria|produt|catalog|shop|listar/i.test(url) && !/oferta|encarte|promoc/i.test(url);
}

function buildItemsFingerprint(items) {
  return items
    .slice(0, 20)
    .map((item) => `${item.id || ""}:${sanitizeProductText(item.name) || ""}:${item.price || ""}`)
    .join("|");
}

function dedupeProducts(products) {
  const byKey = new Map();

  for (const product of products) {
    if (!product?.name || !product?.priceValue) {
      continue;
    }

    const key = [product.id, product.link, product.name.toLowerCase(), product.price].filter(Boolean).join("|");
    const existing = byKey.get(key);

    if (!existing || compareCatalogProducts(product, existing) < 0) {
      byKey.set(key, product);
    }
  }

  return Array.from(byKey.values()).sort((left, right) => {
    if (left.sectionLabel !== right.sectionLabel) {
      return left.sectionLabel.localeCompare(right.sectionLabel, "pt-BR");
    }

    return left.name.localeCompare(right.name, "pt-BR");
  });
}

function compareCatalogProducts(left, right) {
  if ((left.priceValue || Infinity) !== (right.priceValue || Infinity)) {
    return (left.priceValue || Infinity) - (right.priceValue || Infinity);
  }

  return String(left.link || "").localeCompare(String(right.link || ""), "pt-BR");
}

function normalizeDiscountPercent(value, currentPriceValue, originalPriceValue) {
  const numeric = parsePriceValue(value);

  if (numeric !== null) {
    return Math.round(numeric);
  }

  if (
    Number.isFinite(currentPriceValue) &&
    Number.isFinite(originalPriceValue) &&
    originalPriceValue > currentPriceValue
  ) {
    return Math.round(((originalPriceValue - currentPriceValue) / originalPriceValue) * 100);
  }

  return null;
}

function uniqueUrls(urls) {
  return Array.from(new Set(urls.filter(Boolean).map((url) => normalizeUrl(url))));
}

function uniqueUrlsByKey(items, getKey) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = getKey(item);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function log(onLog, level, message, context = null) {
  if (typeof onLog !== "function") {
    return;
  }

  onLog({
    scope: "catalog-discovery",
    level,
    message,
    context,
    at: new Date().toISOString(),
  });
}

module.exports = {
  DEFAULT_MAX_ITEMS_PER_PAGE,
  DEFAULT_MAX_PAGES_PER_SECTION,
  DEFAULT_MAX_SECTIONS,
  DEFAULT_OUTPUT_ROOT,
  scrapeIntelligentCatalog,
};
