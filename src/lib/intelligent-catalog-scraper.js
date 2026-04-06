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
const DEFAULT_WORKER_COUNT = 3;
const DEFAULT_VIEWPORT = { width: 1440, height: 2200 };
const ROOT_DISCOVERY_LIMIT = 10;
const SECTION_EXPANSION_MULTIPLIER = 4;
const EXTRA_SECTION_PAGE_BUFFER = 6;
const MAX_DISCOVERED_SECTION_LINKS = 12;

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
  workerCount = DEFAULT_WORKER_COUNT,
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
    workerCount,
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
    workerCount,
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
  workerCount,
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
    const failedSections = [];

    for (const section of effectiveSections) {
      log(onLog, "info", "Iniciando processamento de secao do catalogo.", {
        sectionId: section.id,
        sectionLabel: section.label,
        sectionUrl: section.url,
      });

      let result;

      try {
        result = await scrapeCatalogSection(context, section, {
          maxPagesPerSection,
          maxItemsPerPage,
          workerCount,
          onLog,
        });
      } catch (error) {
        failedSections.push({
          id: section.id,
          label: section.label,
          url: section.url,
          error: error.message,
        });
        log(onLog, "warn", "Secao falhou durante processamento.", {
          sectionId: section.id,
          sectionLabel: section.label,
          sectionUrl: section.url,
          error: error.message,
        });
        continue;
      }

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
      workerCount,
      failedSections,
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
        workerCount,
        failedSections: failedSections.length,
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
        workerCount,
        failedSections,
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
  const inputUrl = String(candidate.inputUrl || "");
  let score =
    Math.min(candidate.selected.items.length, 120) * 9 +
    Math.min(candidate.discoveredLinks.length, 40) * 7;

  if (candidate.selected.strategy === "network") {
    score += 30;
  }

  if (/categorias?|category|departamentos?|department/i.test(url)) {
    score += 180;
  }

  if (/produt|catalog|shop|listar/i.test(url)) {
    score += 60;
  }

  if (/\/$/.test(url) && candidate.selected.items.length > 20) {
    score += 32;
  }

  if (/oferta|encarte|promoc/i.test(url)) {
    score -= 140;
  }

  if (
    /formas-de-pagamento|pagamento|institucional|privacidade|cookie|contato|fale-conosco|blog|login|conta/i.test(
      url,
    )
  ) {
    score -= 420;
  }

  if (
    /categor|depart|produt|catalog|shop|busca/i.test(inputUrl) &&
    /formas-de-pagamento|pagamento|institucional|privacidade|contato|blog|login/i.test(url)
  ) {
    score -= 240;
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
        /(categoria|categorias|departamento|departamentos|secao|secoes|setor|catalog|category|department|shop|produto|produtos|mercado|promoc|ofertas?|festival|clube|especial|barato|carne|páscoa|pascoa|ver mais|ver tudo)/i;
      const excludePattern =
        /(login|conta|institucional|blog|contato|faq|privacidade|cookie|carrinho|cart|favorito|wishlist|checkout|pagamento|formas-de-pagamento)/i;
      const productPattern = /\/produto\/|\/p\/|sku=|product_id=/i;
      const currentOrigin = window.location.origin;
      const headingCandidates = [];

      const headings = Array.from(
        document.querySelectorAll("h1, h2, h3, h4, [class*=title], [class*=heading]"),
      )
        .filter((element) => !element.closest("header, nav, footer"))
        .map((element) => ({
          element,
          label: String(element.innerText || element.textContent || "")
            .replace(/\s+/g, " ")
            .trim(),
        }))
        .filter((entry) => entry.label && entry.label.length >= 3 && entry.label.length <= 80)
        .filter((entry) => !excludePattern.test(entry.label));

      for (const heading of headings.slice(0, 60)) {
        const roots = [
          heading.element.closest("section, article"),
          heading.element.closest("[class*=section]"),
          heading.element.closest("[class*=shelf]"),
          heading.element.closest("[class*=carousel]"),
          heading.element.closest("[class*=slider]"),
          heading.element.parentElement,
          heading.element.parentElement?.parentElement,
        ].filter(Boolean);

        const seenRoots = new Set();

        for (const root of roots) {
          if (!root || seenRoots.has(root)) {
            continue;
          }

          seenRoots.add(root);

          const linkCandidates = Array.from(root.querySelectorAll("a[href]"))
            .filter((anchor) => !anchor.closest("header, nav, footer"))
            .map((anchor) => ({
              href: anchor.href,
              text: String(anchor.innerText || anchor.textContent || "")
                .replace(/\s+/g, " ")
                .trim(),
              hasImage: Boolean(anchor.querySelector("img")),
            }))
            .filter((entry) => entry.href && entry.href.startsWith(currentOrigin))
            .filter((entry) => !productPattern.test(entry.href))
            .filter((entry) => !excludePattern.test(`${entry.text} ${entry.href}`))
            .map((entry) => ({
              ...entry,
              score: scoreSectionLink(entry),
            }))
            .sort((left, right) => right.score - left.score);

          const bestLink = linkCandidates[0];

          if (!bestLink || bestLink.score <= 0) {
            continue;
          }

          headingCandidates.push({
            id: heading.label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            label: heading.label,
            url: bestLink.href,
            score: 80 + bestLink.score,
          });
          break;
        }
      }

      const candidates = Array.from(document.querySelectorAll("a[href]"))
        .filter((anchor) => !anchor.closest("header, nav, footer"))
        .map((anchor) => ({
          label: String(anchor.innerText || anchor.textContent || "")
            .replace(/\s+/g, " ")
            .trim(),
          url: anchor.href,
          hasImage: Boolean(anchor.querySelector("img")),
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

      const mergedCandidates = [...headingCandidates, ...candidates]
        .sort((left, right) => right.score - left.score)
        .slice(0, maxCount * 6);

      const unique = [];
      const seen = new Set();

      for (const entry of mergedCandidates) {
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

        if (/promoc|oferta|festival|clube|barato|carne|páscoa|pascoa/i.test(haystack)) {
          score += 22;
        }

        if (entry.hasImage) {
          score += 10;
        }

        if (entry.label.length > 2 && entry.label.length <= 80) {
          score += 8;
        }

        return score;
      }

      function scoreSectionLink(entry) {
        const haystack = `${entry.text} ${entry.href}`;
        let score = 0;

        if (/ver mais|ver tudo|mostrar mais|mostrar tudo/i.test(haystack)) {
          score += 34;
        }

        if (/promoc|oferta|festival|clube|barato|carne|páscoa|pascoa/i.test(haystack)) {
          score += 22;
        }

        if (/categor|depart|produt|busca|search|shop|listar/i.test(haystack)) {
          score += 18;
        }

        if (entry.hasImage) {
          score += 10;
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
  { maxPagesPerSection, maxItemsPerPage, workerCount, onLog },
) {
  const maxPagesToVisit = Math.max(
    maxPagesPerSection,
    maxPagesPerSection * SECTION_EXPANSION_MULTIPLIER,
    maxPagesPerSection + EXTRA_SECTION_PAGE_BUFFER,
  );
  const effectiveWorkerCount = normalizeWorkerCount(workerCount, maxPagesToVisit);
  const initialPageUrls = await discoverSectionPageUrls(context, section, maxPagesToVisit, onLog);
  const queue = [...initialPageUrls];
  const queuedUrls = new Set(initialPageUrls);
  const processedUrls = new Set();
  const inProgressUrls = new Set();
  const activeWorkers = new Set();
  const pages = [];
  const products = [];
  const seenPageFingerprints = new Set();

  log(onLog, "info", "Paginas da secao descobertas.", {
    sectionId: section.id,
    sectionLabel: section.label,
    sectionUrl: section.url,
    totalPagesDiscovered: initialPageUrls.length,
    pageUrls: initialPageUrls.slice(0, 20),
    maxPagesToVisit,
    workerCount: effectiveWorkerCount,
  });
  log(onLog, "info", "Fila de paginas da secao inicializada.", {
    sectionId: section.id,
    sectionLabel: section.label,
    sectionUrl: section.url,
    pageUrls: initialPageUrls.slice(0, 20),
    queueSize: queue.length,
    totalPagesDiscovered: queuedUrls.size,
    analyzedPages: processedUrls.size,
    workerCount: effectiveWorkerCount,
    activeWorkers: activeWorkers.size,
    maxPagesToVisit,
  });

  const buildSectionProgressContext = (extra = {}) => ({
    sectionId: section.id,
    sectionLabel: section.label,
    sectionUrl: section.url,
    queueSize: queue.length,
    totalPagesDiscovered: queuedUrls.size,
    analyzedPages: processedUrls.size,
    workerCount: effectiveWorkerCount,
    activeWorkers: activeWorkers.size,
    ...extra,
  });

  const takeNextPageFromQueue = () => {
    if (processedUrls.size + inProgressUrls.size >= maxPagesToVisit) {
      return null;
    }

    while (queue.length > 0) {
      const pageUrl = queue.shift();

      if (!pageUrl || processedUrls.has(pageUrl) || inProgressUrls.has(pageUrl)) {
        continue;
      }

      inProgressUrls.add(pageUrl);
      return pageUrl;
    }

    return null;
  };

  async function workerLoop(workerId) {
    let idleLogged = false;

    log(onLog, "info", "Worker da secao iniciado.", buildSectionProgressContext({ workerId }));

    while (true) {
      const pageUrl = takeNextPageFromQueue();

      if (!pageUrl) {
        if (queue.length === 0 && activeWorkers.size === 0) {
          log(
            onLog,
            "info",
            "Worker finalizou execucao da secao.",
            buildSectionProgressContext({ workerId }),
          );
          return;
        }

        if (!idleLogged) {
          log(
            onLog,
            "info",
            "Worker ocioso aguardando novas paginas.",
            buildSectionProgressContext({ workerId }),
          );
          idleLogged = true;
        }

        await delay(250);
        continue;
      }

      idleLogged = false;
      activeWorkers.add(workerId);
      log(
        onLog,
        "info",
        "Worker assumiu pagina da fila.",
        buildSectionProgressContext({
          workerId,
          pageUrl,
        }),
      );

      try {
        const candidate = await inspectCandidate(context, pageUrl, { maxItems: maxItemsPerPage });

        if (candidate.error) {
          log(onLog, "warn", "Pagina da fila falhou ao abrir.", {
            ...buildSectionProgressContext({
              workerId,
              pageUrl,
            }),
            finalUrl: candidate.finalUrl,
            error: candidate.error,
          });
          continue;
        }

        const fingerprint = buildItemsFingerprint(candidate.selected.items);
        const relatedLinks = selectRelatedSectionLinks(candidate.discoveredLinks || [], section.url)
          .filter((url) => !queuedUrls.has(url) && !processedUrls.has(url) && !inProgressUrls.has(url))
          .slice(0, MAX_DISCOVERED_SECTION_LINKS);

        for (const relatedUrl of relatedLinks) {
          if (queuedUrls.size >= maxPagesToVisit) {
            break;
          }

          queue.push(relatedUrl);
          queuedUrls.add(relatedUrl);
        }

        if (relatedLinks.length > 0) {
          log(onLog, "info", "Novas paginas relacionadas foram descobertas dentro da secao.", {
            ...buildSectionProgressContext({
              workerId,
              pageUrl,
            }),
            discoveredLinks: relatedLinks.slice(0, 12),
          });
        }

        if (seenPageFingerprints.has(fingerprint)) {
          log(onLog, "info", "Pagina ignorada por fingerprint duplicada.", {
            ...buildSectionProgressContext({
              workerId,
              pageUrl,
            }),
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
            ...buildSectionProgressContext({
              workerId,
              pageUrl,
            }),
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
          workerId,
        });
        products.push(...pageProducts);

        log(onLog, "info", "Pagina da secao processada.", {
          ...buildSectionProgressContext({
            workerId,
            pageUrl,
          }),
          finalUrl: candidate.finalUrl,
          strategy: candidate.selected.strategy,
          productsFound: pageProducts.length,
          products: summarizeProductsForLog(pageProducts),
        });
      } finally {
        activeWorkers.delete(workerId);
        inProgressUrls.delete(pageUrl);
        processedUrls.add(pageUrl);
      }
    }
  }

  await Promise.all(
    Array.from({ length: effectiveWorkerCount }, (_value, index) => workerLoop(index + 1)),
  );

  const dedupedProducts = dedupeProducts(products);

  log(
    onLog,
    dedupedProducts.length > 0 ? "info" : "warn",
    "Secao concluida.",
    {
      sectionId: section.id,
      sectionLabel: section.label,
      totalPagesDiscovered: queuedUrls.size,
      pagesScraped: pages.length,
      totalProducts: dedupedProducts.length,
      workerCount: effectiveWorkerCount,
    },
  );

  return {
    id: section.id,
    label: section.label,
    url: section.url,
    totalPages: queuedUrls.size,
    workerCount: effectiveWorkerCount,
    pages,
    products: dedupedProducts,
  };
}

async function discoverSectionPageUrls(context, section, maxPagesPerSection, onLog = null) {
  const page = await context.newPage();

  try {
    const sectionUrl = section.url;
    const navigation = await gotoWithRetries(page, sectionUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
      attempts: 2,
    });

    if (!navigation.ok) {
      log(onLog, "warn", "Falha ao abrir URL base da secao; usando fallback minimo.", {
        sectionId: section.id,
        sectionLabel: section.label,
        sectionUrl,
        error: navigation.error.message,
      });
      return uniqueUrls([sectionUrl]);
    }

    await settleCatalogPage(page);

    const discovered = await page.evaluate(({ limit }) => {
      const current = new URL(window.location.href);
      const sameOrigin = current.origin;
      const includePattern =
        /(page=|pagina=|\/page\/\d+|ver mais|mostrar mais|mais produtos|todos os produtos|ver tudo|mostrar tudo|categoria|subcategoria|departamento|produt|busca|search|shop|listar)/i;
      const excludePattern =
        /(login|conta|institucional|blog|contato|faq|privacidade|cookie|carrinho|cart|favorito|wishlist|formas-de-pagamento|pagamento)/i;
      const productPattern = /\/produto\/|\/produtos\/\d+|\/p\/|sku=|product_id=/i;
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => ({
          text: String(anchor.innerText || anchor.textContent || "")
            .replace(/\s+/g, " ")
            .trim(),
          href: anchor.href,
        }))
        .filter((entry) => entry.href && entry.href.startsWith(sameOrigin))
        .filter((entry) => !productPattern.test(entry.href))
        .filter((entry) => !excludePattern.test(`${entry.text} ${entry.href}`));

      const numericTexts = links
        .filter((entry) => /page=|pagina=|\/page\/|\b\d+\b/.test(`${entry.text} ${entry.href}`))
        .map((entry) => Number.parseInt(entry.text, 10))
        .filter((value) => Number.isFinite(value) && value > 1 && value <= limit);

      const explicitUrls = links
        .filter((entry) => /page=|pagina=|\/page\/\d+/i.test(entry.href))
        .map((entry) => entry.href);

      const relatedUrls = links
        .filter((entry) => includePattern.test(`${entry.text} ${entry.href}`))
        .map((entry) => ({
          href: entry.href,
          score: scoreRelated(entry),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit * 2)
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

      return [current.toString(), ...relatedUrls, ...explicitUrls, ...synthesized];

      function scoreRelated(entry) {
        const haystack = `${entry.text} ${entry.href}`;
        let score = 0;

        if (/todos os produtos|ver tudo|mostrar tudo/i.test(haystack)) {
          score += 42;
        }

        if (/ver mais|mostrar mais|mais produtos/i.test(haystack)) {
          score += 34;
        }

        if (/categoria|subcategoria|departamento/i.test(haystack)) {
          score += 20;
        }

        if (/\/categorias?\//i.test(entry.href)) {
          score += 16;
        }

        if (/page=|pagina=|\/page\/\d+/i.test(entry.href)) {
          score += 18;
        }

        if (entry.href.startsWith(current.href.replace(/\/+$/, ""))) {
          score += 14;
        }

        return score;
      }
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
  const normalizedBadges = normalizeProductBadges(item.badges);
  const campaignLabel = deriveProductCampaignLabel(item, section, normalizedBadges);
  const limitText = normalizeLimitText(item.limitText || normalizedBadges.find((badge) => /cpf|cliente|limite|máx|max/i.test(badge)));

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
    badges: normalizedBadges,
    campaignLabel,
    limitText,
    isClubOffer:
      Boolean(item.isClubOffer) ||
      normalizedBadges.some((badge) => /\bclub\b|\bclube\b/i.test(badge)),
    isSiteExclusive:
      Boolean(item.isSiteExclusive) ||
      normalizedBadges.some((badge) => /exclusiv|site/i.test(badge)),
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

function normalizeProductBadges(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const badges = [];

  for (const entry of value) {
    const normalized = String(entry || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized || normalized.length > 80) {
      continue;
    }

    const key = normalized.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    badges.push(normalized);
  }

  return badges.slice(0, 8);
}

function normalizeLimitText(value) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return null;
  }

  return /cpf|cliente|limite|máx|max/i.test(normalized) ? normalized : null;
}

function deriveProductCampaignLabel(item, section, badges) {
  const direct = String(item.campaignLabel || item.promotionLabel || "")
    .replace(/\s+/g, " ")
    .trim();

  if (direct && !/^oferta$/i.test(direct)) {
    return direct;
  }

  for (const badge of badges) {
    if (/festival|sexta|carne|super barato|exclusiv|site|clube|real|páscoa|pascoa/i.test(badge)) {
      return badge;
    }
  }

  if (/festival|sexta|carne|super barato|clube|promo|oferta|páscoa|pascoa/i.test(section.label || "")) {
    return section.label;
  }

  return direct || null;
}

async function settleCatalogPage(page) {
  await page.waitForTimeout(1_500);

  for (let index = 0; index < 3; index += 1) {
    await page.mouse.wheel(0, 1_200);
    await page.waitForTimeout(900);
  }

  await clickCatalogLoadMoreButtons(page);
  await clickCatalogCarouselControls(page);
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(1_000);
}

async function clickCatalogLoadMoreButtons(page) {
  const labels = [/carregar mais/i, /ver mais/i, /mostrar mais/i, /mais produtos/i];

  for (const label of labels) {
    const locator = page.locator("button, a").filter({ hasText: label }).first();

    try {
      if (await locator.isVisible({ timeout: 250 })) {
        await locator.click({ timeout: 2_000 });
        await page.waitForTimeout(900);
      }
    } catch {
      // Links opcionais.
    }
  }
}

async function clickCatalogCarouselControls(page) {
  const selectors = [
    ".swiper-button-next",
    ".slick-next",
    "[class*=carousel] button[class*=next]",
    "[class*=slider] button[class*=next]",
    "button[aria-label*=próx i]",
    "button[aria-label*=prox i]",
    "button[aria-label*=next i]",
    "button[title*=próx i]",
    "button[title*=prox i]",
    "button[title*=next i]",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    try {
      if (await locator.isVisible({ timeout: 250 })) {
        await locator.click({ timeout: 1_500 });
        await page.waitForTimeout(700);
      }
    } catch {
      // Carrosseis sao opcionais.
    }
  }
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
  workerCount,
  failedSections = [],
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
    workerCount,
    totalSections: sections.length,
    totalProducts: products.length,
    rootUrl: discovery.rootUrl,
    failedSections,
    sections: sections.map((section) => ({
      id: section.id,
      label: section.label,
      url: section.url,
      workerCount: section.workerCount || workerCount || null,
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

function selectRelatedSectionLinks(discoveredLinks, sectionUrl) {
  return uniqueUrls(
    discoveredLinks
      .map((url) => ({
        url: normalizeUrl(url),
        score: scoreRelatedSectionLink(url, sectionUrl),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_DISCOVERED_SECTION_LINKS * 2)
      .map((entry) => entry.url),
  );
}

function scoreRelatedSectionLink(candidateUrl, sectionUrl) {
  try {
    const candidate = new URL(normalizeUrl(candidateUrl));
    const section = new URL(normalizeUrl(sectionUrl));

    if (candidate.origin !== section.origin) {
      return -1;
    }

    if (/\/produto\/|\/produtos\/\d+|\/p\/|sku=|product_id=/i.test(candidate.href)) {
      return -1;
    }

    if (
      /login|conta|institucional|blog|contato|faq|privacidade|cookie|carrinho|cart|favorito|wishlist|formas-de-pagamento|pagamento/i.test(
        candidate.href,
      )
    ) {
      return -1;
    }

    let score = 0;
    const normalizedSectionPath = section.pathname.replace(/\/+$/, "");
    const normalizedCandidatePath = candidate.pathname.replace(/\/+$/, "");

    if (normalizedSectionPath && normalizedCandidatePath.startsWith(normalizedSectionPath)) {
      score += 34;
    }

    if (/page=|pagina=|\/page\/\d+/i.test(candidate.href)) {
      score += 22;
    }

    if (/categor|subcategor|depart|busca|search|shop|produt|listar/i.test(candidate.href)) {
      score += 18;
    }

    if (/ver-mais|mostrar-mais|todos|tudo/i.test(candidate.href)) {
      score += 10;
    }

    if (/oferta|promoc|encarte/i.test(candidate.href)) {
      score -= 28;
    }

    return score;
  } catch (_error) {
    return -1;
  }
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

function summarizeProductsForLog(products) {
  return products.map((product) => ({
    id: product.id || null,
    name: product.name,
    price: product.price || null,
    originalPrice: product.originalPrice || null,
    unit: product.unit || null,
    sectionLabel: product.sectionLabel || null,
    promotionLabel: product.promotionLabel || null,
    campaignLabel: product.campaignLabel || null,
    badges: Array.isArray(product.badges) ? product.badges.slice(0, 6) : [],
    link: product.link || null,
    image: product.image || null,
  }));
}

function compareCatalogProducts(left, right) {
  const richnessDiff = scoreCatalogProduct(right) - scoreCatalogProduct(left);

  if (richnessDiff !== 0) {
    return richnessDiff;
  }

  if ((left.priceValue || Infinity) !== (right.priceValue || Infinity)) {
    return (left.priceValue || Infinity) - (right.priceValue || Infinity);
  }

  return String(left.link || "").localeCompare(String(right.link || ""), "pt-BR");
}

function scoreCatalogProduct(item) {
  let score = 0;

  if (item.image) score += 3;
  if (item.link) score += 3;
  if (item.originalPrice) score += 2;
  if (item.discountPercent !== null && item.discountPercent !== undefined) score += 2;
  if (item.promotionLabel) score += 2;
  if (item.campaignLabel) score += 3;
  if (item.limitText) score += 2;
  if (item.unit) score += 1;
  if (item.isClubOffer) score += 1;
  if (item.isSiteExclusive) score += 1;
  if (Array.isArray(item.badges)) score += item.badges.length;

  return score;
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

function normalizeWorkerCount(value, maxPagesToVisit) {
  const parsed = Number.parseInt(value, 10);
  const normalized = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WORKER_COUNT;
  return Math.max(1, Math.min(normalized, Math.max(maxPagesToVisit, 1)));
}

async function gotoWithRetries(
  page,
  url,
  { waitUntil = "domcontentloaded", timeout = 60_000, attempts = 2 } = {},
) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, {
        waitUntil,
        timeout,
      });
      return {
        ok: true,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;

      if (attempt < attempts) {
        await delay(1_000 * attempt);
      }
    }
  }

  return {
    ok: false,
    attempts,
    error: lastError,
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  DEFAULT_WORKER_COUNT,
  DEFAULT_OUTPUT_ROOT,
  scrapeIntelligentCatalog,
};
