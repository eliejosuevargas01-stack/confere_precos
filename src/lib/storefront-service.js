const fs = require("fs/promises");
const { fork } = require("child_process");
const path = require("path");
const {
  buildCatalogComparisonView,
  buildExactComparisonView,
} = require("./exact-product-comparator");
const { ensureDir } = require("./output-utils");
const { resolveFromCwd } = require("./scraper-core");

const DEFAULT_SNAPSHOT_ROOT = "data/storefront";
const DEFAULT_CITY = process.env.STOREFRONT_CITY || "gaspar";
const DEFAULT_INPUT_FILE = process.env.STOREFRONT_INPUT_FILE || "links.txt";
const DEFAULT_REFRESH_INTERVAL_MINUTES = Number.parseInt(
  process.env.STOREFRONT_REFRESH_MINUTES || "120",
  10,
);
const DEFAULT_MAX_ITEMS_PER_QUERY = Number.parseInt(
  process.env.STOREFRONT_MAX_ITEMS || "80",
  10,
);
const HISTORY_LIMIT = Number.parseInt(process.env.STOREFRONT_HISTORY_LIMIT || "24", 10);
const REFRESH_ON_START = process.env.STOREFRONT_REFRESH_ON_START !== "false";
const CATEGORY_WORKERS = Number.parseInt(process.env.STOREFRONT_CATEGORY_WORKERS || "", 10);
const DEFAULT_CATEGORY_WORKERS = 2;

const CATEGORY_DEFINITIONS = [
  {
    id: "basicos",
    label: "Basicos Do Dia",
    productIds: [
      "arroz",
      "feijao",
      "acucar",
      "sal",
      "oleo_de_soja",
      "cafe",
      "leite",
      "macarrao",
      "farinha_de_trigo",
      "farinha_de_milho",
      "fuba",
      "ovos",
      "pao_de_forma",
    ],
  },
  {
    id: "mercearia",
    label: "Molhos E Enlatados",
    productIds: ["molho_de_tomate", "extrato_de_tomate", "sardinha"],
  },
  {
    id: "higiene",
    label: "Higiene Pessoal",
    productIds: [
      "papel_higienico",
      "creme_dental",
      "escova_dental",
      "sabonete",
      "shampoo",
      "condicionador",
      "desodorante",
      "absorvente",
      "algodao",
    ],
  },
  {
    id: "limpeza",
    label: "Limpeza Da Casa",
    productIds: [
      "detergente",
      "sabao_em_po",
      "sabao_liquido",
      "agua_sanitaria",
      "desinfetante",
      "amaciante",
      "esponja_de_louca",
      "saco_de_lixo",
      "alcool_70",
    ],
  },
  {
    id: "bebe",
    label: "Bebe E Cuidados",
    productIds: ["fralda", "lenco_umedecido"],
  },
];

const CATEGORY_BY_PRODUCT_ID = buildCategoryIndex(CATEGORY_DEFINITIONS);

function normalizeRequestedCity(value) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized ? toTitleCase(normalized) : null;
}

function resolveCitySnapshotRoot(snapshotRoot, city) {
  const normalizedCity = normalizeRequestedCity(city) || DEFAULT_CITY;
  return path.join(snapshotRoot, slugifyCityName(normalizedCity));
}

async function generateStorefrontFiles({
  city = DEFAULT_CITY,
  inputFile = DEFAULT_INPUT_FILE,
  snapshotRoot = DEFAULT_SNAPSHOT_ROOT,
  intervalMinutes = DEFAULT_REFRESH_INTERVAL_MINUTES,
  maxItemsPerQuery = DEFAULT_MAX_ITEMS_PER_QUERY,
  categoryWorkers = CATEGORY_WORKERS,
} = {}) {
  const normalizedCity = normalizeRequestedCity(city) || DEFAULT_CITY;
  const citySnapshotRoot = resolveCitySnapshotRoot(snapshotRoot, normalizedCity);
  const categoryResults = await runCategoryComparisonJobs({
    city: normalizedCity,
    inputFile,
    maxItemsPerQuery,
    categoryWorkers,
  });
  const comparison = mergeCategoryComparisons({
    categoryResults,
    city: normalizedCity,
  });
  const exactView = buildExactComparisonView(comparison);
  const catalogView = buildCatalogComparisonView(comparison);
  const snapshot = buildStorefrontSnapshot({
    comparison,
    exactView,
    catalogView,
    intervalMinutes,
  });
  const paths = await writeStorefrontFiles({
    snapshotRoot: citySnapshotRoot,
    snapshot,
    comparison,
    exactView,
    catalogView,
  });

  return {
    snapshot,
    comparison,
    exactView,
    catalogView,
    paths,
    categoryResults,
  };
}

async function runCategoryComparisonJobs({
  city,
  inputFile,
  maxItemsPerQuery,
  categoryWorkers,
} = {}) {
  const limit = normalizeCategoryWorkerCount(categoryWorkers);
  const results = [];
  const activeChildren = new Set();
  let cursor = 0;

  async function workerLoop() {
    while (cursor < CATEGORY_DEFINITIONS.length) {
      const currentIndex = cursor;
      cursor += 1;
      const category = CATEGORY_DEFINITIONS[currentIndex];

      if (!category) {
        break;
      }

      const result = await runSingleCategoryJob(
        category,
        {
          city,
          inputFile,
          maxItemsPerQuery,
          startDelayMs: currentIndex * 15_000,
        },
        activeChildren,
      );

      results.push(result);
    }
  }

  const workerCount = Math.min(limit, CATEGORY_DEFINITIONS.length);
  const lanes = Array.from({ length: workerCount }, () => workerLoop());

  try {
    await Promise.all(lanes);
  } catch (error) {
    killAllWorkers(activeChildren);
    throw error;
  }

  return results.sort((left, right) => {
    const leftIndex = CATEGORY_DEFINITIONS.findIndex((category) => category.id === left.category.id);
    const rightIndex = CATEGORY_DEFINITIONS.findIndex((category) => category.id === right.category.id);
    return leftIndex - rightIndex;
  });
}

function runSingleCategoryJob(
  category,
  { city, inputFile, maxItemsPerQuery, startDelayMs },
  activeChildren,
) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, "storefront-category-worker.js");
    const child = fork(workerPath, [], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      cwd: process.cwd(),
      env: {
        ...process.env,
      },
    });

    let settled = false;
    activeChildren.add(child);

    const finish = (fn, value) => {
      if (settled) {
        return;
      }

      settled = true;
      activeChildren.delete(child);
      fn(value);
    };

    child.on("message", (message) => {
      if (!message || typeof message !== "object") {
        return;
      }

      if (message.ok) {
        finish(resolve, {
          category,
          comparison: message.result.comparison,
          worker: message.result.worker || null,
        });
        return;
      }

      finish(reject, reviveWorkerError(message.error, category));
      killAllWorkers(activeChildren, child);
    });

    child.on("error", (error) => {
      finish(reject, error);
      killAllWorkers(activeChildren, child);
    });

    child.on("exit", (code, signal) => {
      if (settled) {
        activeChildren.delete(child);
        return;
      }

      finish(
        reject,
        new Error(
          `Worker da categoria ${category.id} encerrou antes de concluir (code=${code}, signal=${signal || "none"}).`,
        ),
      );
      killAllWorkers(activeChildren, child);
    });

    child.send({
      categoryId: category.id,
      categoryLabel: category.label,
      productIds: category.productIds,
      city,
      inputFile,
      maxItemsPerQuery,
      startDelayMs: startDelayMs || 0,
    });
  });
}

function mergeCategoryComparisons({ categoryResults, city }) {
  const comparisons = categoryResults.map((entry) => entry.comparison).filter(Boolean);

  if (comparisons.length === 0) {
    throw new Error("Nenhum worker produziu comparacao para o storefront.");
  }

  const siteStatus = mergeSiteStatusRows(
    comparisons.flatMap((comparison) => comparison.siteStatus || []),
  );
  const baseComparison = comparisons[0];
  const totalProducts = new Set(
    CATEGORY_DEFINITIONS.flatMap((category) => category.productIds),
  ).size;
  const order = buildEssentialOrderIndex();
  const essentials = comparisons
    .flatMap((comparison) => comparison.essentials || [])
    .sort((left, right) => compareByOrder(left.id, right.id, order));
  const rows = comparisons
    .flatMap((comparison) => comparison.rows || [])
    .sort((left, right) => compareByOrder(left.essential_id, right.essential_id, order));
  const bestOffers = comparisons
    .flatMap((comparison) => comparison.bestOffers || [])
    .sort((left, right) => compareByOrder(left.essential_id, right.essential_id, order));
  const sites = baseComparison.sites || [];
  const totalComparableSites = siteStatus.filter((entry) => entry.searchSupported).length;
  const requestedCity = city || baseComparison.metadata?.requestedCity || null;

  return {
    metadata: {
      comparedAt:
        comparisons
          .map((comparison) => comparison.metadata?.comparedAt || null)
          .filter(Boolean)
          .sort()
          .at(-1) || new Date().toISOString(),
      requestedCity,
      totalSites: siteStatus.length || baseComparison.metadata?.totalSites || 0,
      totalComparableSites:
        totalComparableSites || baseComparison.metadata?.totalComparableSites || 0,
      totalProducts,
      inputUrls: baseComparison.metadata?.inputUrls || [],
      totalCategoryWorkers: categoryResults.length,
      categoryWorkers: categoryResults.map((entry) => entry.category.id),
    },
    sites,
    essentials,
    rows,
    bestOffers,
    siteStatus,
  };
}

function buildStorefrontSnapshot({ comparison, exactView, catalogView, intervalMinutes }) {
  const categories = CATEGORY_DEFINITIONS.map((category) => {
    const groups = (catalogView?.groups || [])
      .filter((group) => category.productIds.includes(group.essentialId))
      .map((group) => ({
        id: group.id,
        categoryId: category.id,
        categoryLabel: category.label,
        title: group.title,
        essentialId: group.essentialId,
        essentialLabel: group.essentialLabel,
        packageLabel: group.packageLabel,
        image: group.referenceImage,
        storeCount: group.storeCount,
        isComparable: Boolean(group.isComparable),
        comparisonMode: group.comparisonMode || "single-store",
        lowestPriceValue: group.lowestPriceValue,
        highestPriceValue: group.highestPriceValue,
        priceSpreadValue:
          Number.isFinite(group.lowestPriceValue) && Number.isFinite(group.highestPriceValue)
            ? group.highestPriceValue - group.lowestPriceValue
            : null,
        cheapestOffer: group.offers.find((offer) => offer.isCheapest) || null,
        offers: group.offers,
      }))
      .sort((left, right) => {
        if (right.isComparable !== left.isComparable) {
          return Number(right.isComparable) - Number(left.isComparable);
        }

        if (left.lowestPriceValue !== right.lowestPriceValue) {
          return numericAsc(left.lowestPriceValue, right.lowestPriceValue);
        }

        return left.title.localeCompare(right.title, "pt-BR");
      });

    return {
      id: category.id,
      label: category.label,
      productCount: groups.length,
      comparableCount: groups.filter((group) => group.isComparable).length,
      lowestPriceValue: groups[0]?.lowestPriceValue ?? null,
      groups,
    };
  }).filter((category) => category.productCount > 0);

  const featured = (catalogView?.groups || [])
    .flatMap((group) =>
      group.offers
        .filter((offer) => offer.isCheapest)
        .map((offer) => ({
          groupId: group.id,
          title: group.title,
          essentialId: group.essentialId,
          categoryId: CATEGORY_BY_PRODUCT_ID[group.essentialId] || "outros",
          image: group.referenceImage,
          packageLabel: group.packageLabel,
          storeCount: group.storeCount,
          isComparable: Boolean(group.isComparable),
          siteDomain: offer.siteDomain,
          storeLabel: offer.storeLabel,
          price: offer.price,
          priceValue: offer.priceValue,
          originalPrice: offer.originalPrice || null,
          discountPercent: offer.discountPercent ?? null,
          priceSpreadValue:
            Number.isFinite(group.lowestPriceValue) && Number.isFinite(group.highestPriceValue)
              ? group.highestPriceValue - group.lowestPriceValue
              : null,
          link: offer.link || null,
        })),
    )
    .sort((left, right) => {
      if (right.isComparable !== left.isComparable) {
        return Number(right.isComparable) - Number(left.isComparable);
      }

      const discountDiff = (right.discountPercent || 0) - (left.discountPercent || 0);

      if (discountDiff !== 0) {
        return discountDiff;
      }

      return numericAsc(left.priceValue, right.priceValue);
    })
    .slice(0, 12);

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      requestedCity: comparison.metadata?.requestedCity || null,
      totalSites: comparison.metadata?.totalSites || 0,
      totalComparableSites: comparison.metadata?.totalComparableSites || 0,
      totalExactGroups: exactView.groups.length,
      totalCatalogGroups: catalogView?.groups?.length || 0,
      totalCategories: categories.length,
      totalProducts: comparison.metadata?.totalProducts || 0,
      totalCategoryWorkers: comparison.metadata?.totalCategoryWorkers || 0,
      refreshIntervalMinutes: intervalMinutes,
      nextRefreshAt: new Date(
        Date.now() + Math.max(intervalMinutes, 1) * 60_000,
      ).toISOString(),
    },
    diagnostics: {
      exact: exactView?.diagnostics || {},
      catalog: catalogView?.diagnostics || {},
    },
    siteStatus: (comparison.siteStatus || []).map(normalizeSiteStatusEntry),
    featured,
    categories,
  };
}

async function writeStorefrontFiles({ snapshotRoot, snapshot, comparison, exactView, catalogView }) {
  const rootDir = resolveFromCwd(snapshotRoot);
  const historyDir = path.join(rootDir, "history");
  const rawDir = path.join(rootDir, "raw");
  const stamp = new Date().toISOString().replaceAll(":", "-");

  await ensureDir(rootDir);
  await ensureDir(historyDir);
  await ensureDir(rawDir);

  const latestSnapshotPath = path.join(rootDir, "latest.json");
  const latestComparisonPath = path.join(rawDir, "latest-comparison.json");
  const latestExactPath = path.join(rawDir, "latest-exact.json");
  const latestCatalogPath = path.join(rawDir, "latest-catalog.json");
  const historySnapshotPath = path.join(historyDir, `${stamp}-storefront.json`);
  const historyComparisonPath = path.join(rawDir, `${stamp}-comparison.json`);
  const historyExactPath = path.join(rawDir, `${stamp}-exact.json`);
  const historyCatalogPath = path.join(rawDir, `${stamp}-catalog.json`);

  await fs.writeFile(latestSnapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  await fs.writeFile(latestComparisonPath, JSON.stringify(comparison, null, 2), "utf8");
  await fs.writeFile(latestExactPath, JSON.stringify(exactView, null, 2), "utf8");
  await fs.writeFile(latestCatalogPath, JSON.stringify(catalogView, null, 2), "utf8");
  await fs.writeFile(historySnapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  await fs.writeFile(historyComparisonPath, JSON.stringify(comparison, null, 2), "utf8");
  await fs.writeFile(historyExactPath, JSON.stringify(exactView, null, 2), "utf8");
  await fs.writeFile(historyCatalogPath, JSON.stringify(catalogView, null, 2), "utf8");

  await pruneOldFiles(historyDir, HISTORY_LIMIT);
  await pruneOldFiles(rawDir, HISTORY_LIMIT * 3);

  return {
    rootDir,
    latestSnapshotPath,
    latestComparisonPath,
    latestExactPath,
    latestCatalogPath,
    historySnapshotPath,
    historyComparisonPath,
    historyExactPath,
    historyCatalogPath,
  };
}

async function readLatestStorefrontSnapshot(snapshotRoot = DEFAULT_SNAPSHOT_ROOT, city = DEFAULT_CITY) {
  const citySnapshotRoot = resolveCitySnapshotRoot(snapshotRoot, city);
  const candidates = [
    resolveFromCwd(path.join(citySnapshotRoot, "latest.json")),
    resolveFromCwd(path.join(snapshotRoot, "latest.json")),
  ];

  for (const latestPath of candidates) {
    try {
      const content = await fs.readFile(latestPath, "utf8");
      return JSON.parse(content);
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }

  return null;
}

function createStorefrontScheduler(options = {}) {
  const config = {
    city: normalizeRequestedCity(options.city) || DEFAULT_CITY,
    inputFile: options.inputFile || DEFAULT_INPUT_FILE,
    snapshotRoot: options.snapshotRoot || DEFAULT_SNAPSHOT_ROOT,
    categoryWorkers: normalizeCategoryWorkerCount(options.categoryWorkers || CATEGORY_WORKERS),
    refreshOnStart:
      typeof options.refreshOnStart === "boolean" ? options.refreshOnStart : REFRESH_ON_START,
    intervalMinutes:
      Number.isFinite(options.intervalMinutes) && options.intervalMinutes > 0
        ? options.intervalMinutes
        : DEFAULT_REFRESH_INTERVAL_MINUTES,
    maxItemsPerQuery:
      Number.isFinite(options.maxItemsPerQuery) && options.maxItemsPerQuery > 0
        ? options.maxItemsPerQuery
        : DEFAULT_MAX_ITEMS_PER_QUERY,
  };
  let timer = null;
  const state = {
    refreshing: false,
    startedAt: null,
    completedAt: null,
    lastError: null,
    latestSnapshot: null,
    latestPaths: null,
  };

  async function refresh(reason = "manual") {
    if (state.refreshing) {
      return null;
    }

    state.refreshing = true;
    state.startedAt = new Date().toISOString();
    state.lastError = null;

    try {
      const generated = await generateStorefrontFiles({
        city: config.city,
        inputFile: config.inputFile,
        snapshotRoot: config.snapshotRoot,
        intervalMinutes: config.intervalMinutes,
        maxItemsPerQuery: config.maxItemsPerQuery,
        categoryWorkers: config.categoryWorkers,
      });

      state.latestSnapshot = generated.snapshot;
      state.latestPaths = generated.paths;
      state.completedAt = new Date().toISOString();
      return generated;
    } catch (error) {
      state.lastError = {
        message: error.message,
        at: new Date().toISOString(),
        reason,
      };
      return null;
    } finally {
      state.refreshing = false;
    }
  }

  async function start() {
    state.latestSnapshot = await readLatestStorefrontSnapshot(config.snapshotRoot, config.city);

    if (state.latestSnapshot?.metadata?.generatedAt) {
      state.completedAt = state.latestSnapshot.metadata.generatedAt;
    }

    timer = setInterval(() => {
      refresh("interval").catch(() => {});
    }, Math.max(config.intervalMinutes, 1) * 60_000);

    if (typeof timer.unref === "function") {
      timer.unref();
    }

    if (!state.latestSnapshot) {
      refresh("bootstrap").catch(() => {});
      return;
    }

    if (config.refreshOnStart && isSnapshotStale(state.latestSnapshot, config.intervalMinutes)) {
      refresh("startup-stale").catch(() => {});
    }
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus() {
    return {
      refreshing: state.refreshing,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      lastError: state.lastError,
      hasSnapshot: Boolean(state.latestSnapshot),
      intervalMinutes: config.intervalMinutes,
      city: config.city,
      categoryWorkers: config.categoryWorkers,
      snapshotGeneratedAt: state.latestSnapshot?.metadata?.generatedAt || null,
      nextRefreshAt: state.latestSnapshot?.metadata?.nextRefreshAt || null,
    };
  }

  async function getSnapshot() {
    if (state.latestSnapshot) {
      return state.latestSnapshot;
    }

    state.latestSnapshot = await readLatestStorefrontSnapshot(config.snapshotRoot, config.city);
    return state.latestSnapshot;
  }

  return {
    start,
    stop,
    refresh,
    getSnapshot,
    getStatus,
  };
}

function buildCategoryIndex(categories) {
  const index = {};

  for (const category of categories) {
    for (const productId of category.productIds) {
      index[productId] = category.id;
    }
  }

  return index;
}

async function pruneOldFiles(directory, limit) {
  if (!Number.isFinite(limit) || limit < 1) {
    return;
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const absolutePath = path.join(directory, entry.name);
        const stats = await fs.stat(absolutePath);
        return {
          absolutePath,
          name: entry.name,
          mtimeMs: stats.mtimeMs,
        };
      }),
  );

  const disposable = files
    .filter((entry) => !entry.name.startsWith("latest"))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(limit);

  await Promise.all(disposable.map((entry) => fs.unlink(entry.absolutePath)));
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

function isSnapshotStale(snapshot, intervalMinutes) {
  const generatedAt = snapshot?.metadata?.generatedAt;

  if (!generatedAt) {
    return true;
  }

  const generatedAtMs = Date.parse(generatedAt);

  if (!Number.isFinite(generatedAtMs)) {
    return true;
  }

  return Date.now() - generatedAtMs >= Math.max(intervalMinutes, 1) * 60_000;
}

function normalizeSiteStatusEntry(entry) {
  return {
    siteDomain: entry.siteDomain || entry.site_domain || null,
    adapterId: entry.adapterId || entry.adapter_id || null,
    sourceUrl: entry.sourceUrl || entry.source_url || null,
    searchSupported:
      typeof entry.searchSupported === "boolean"
        ? entry.searchSupported
        : Boolean(entry.search_supported),
    requestedCity: entry.requestedCity || entry.requested_city || null,
    effectiveCity: entry.effectiveCity || entry.effective_city || null,
    cityCoverage: entry.cityCoverage || entry.city_coverage || null,
    cityEligible:
      typeof entry.cityEligible === "boolean" ? entry.cityEligible : Boolean(entry.city_eligible),
    storeLabel: entry.storeLabel || entry.store_label || null,
    cityPageUrl: entry.cityPageUrl || entry.city_page_url || null,
    note: entry.note || null,
  };
}

function mergeSiteStatusRows(rows) {
  const byDomain = new Map();

  for (const rawRow of rows) {
    const row = normalizeSiteStatusEntry(rawRow);
    const key = row.siteDomain || row.sourceUrl || row.adapterId || JSON.stringify(row);
    const existing = byDomain.get(key);

    if (!existing) {
      byDomain.set(key, row);
      continue;
    }

    byDomain.set(key, {
      ...existing,
      ...row,
      note: row.note || existing.note || null,
      storeLabel: row.storeLabel || existing.storeLabel || null,
      cityPageUrl: row.cityPageUrl || existing.cityPageUrl || null,
      cityEligible: existing.cityEligible || row.cityEligible,
      searchSupported: existing.searchSupported || row.searchSupported,
    });
  }

  return Array.from(byDomain.values()).sort((left, right) => {
    const leftDomain = left.siteDomain || "";
    const rightDomain = right.siteDomain || "";
    return leftDomain.localeCompare(rightDomain, "pt-BR");
  });
}

function buildEssentialOrderIndex() {
  const order = new Map();
  let position = 0;

  for (const category of CATEGORY_DEFINITIONS) {
    for (const productId of category.productIds) {
      if (!order.has(productId)) {
        order.set(productId, position += 1);
      }
    }
  }

  return order;
}

function compareByOrder(leftId, rightId, order) {
  const leftIndex = order.get(leftId) ?? Number.MAX_SAFE_INTEGER;
  const rightIndex = order.get(rightId) ?? Number.MAX_SAFE_INTEGER;

  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }

  return String(leftId || "").localeCompare(String(rightId || ""), "pt-BR");
}

function normalizeCategoryWorkerCount(value) {
  if (!Number.isFinite(value) || value < 1) {
    return Math.min(DEFAULT_CATEGORY_WORKERS, CATEGORY_DEFINITIONS.length);
  }

  return Math.min(Math.floor(value), CATEGORY_DEFINITIONS.length);
}

function slugifyCityName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toTitleCase(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function killAllWorkers(activeChildren, exceptChild = null) {
  for (const child of activeChildren) {
    if (child === exceptChild) {
      continue;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      // Ignorar falhas ao encerrar processos já finalizados.
    }
  }
}

function reviveWorkerError(error, category) {
  if (!error) {
    return new Error(`Worker da categoria ${category.id} falhou sem mensagem.`);
  }

  const revived = new Error(error.message || `Worker da categoria ${category.id} falhou.`);

  if (error.stack) {
    revived.stack = error.stack;
  }

  revived.categoryId = category.id;
  return revived;
}

module.exports = {
  DEFAULT_CITY,
  DEFAULT_INPUT_FILE,
  DEFAULT_MAX_ITEMS_PER_QUERY,
  DEFAULT_REFRESH_INTERVAL_MINUTES,
  DEFAULT_SNAPSHOT_ROOT,
  CATEGORY_DEFINITIONS,
  normalizeRequestedCity,
  resolveCitySnapshotRoot,
  slugifyCityName,
  generateStorefrontFiles,
  buildStorefrontSnapshot,
  readLatestStorefrontSnapshot,
  createStorefrontScheduler,
};
