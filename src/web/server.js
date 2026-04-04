const path = require("path");
const express = require("express");
const { runScraper, resolveFromCwd } = require("../lib/scraper-core");
const { ESSENTIAL_PRODUCTS } = require("../lib/essential-products");
const { runPriceComparator } = require("../lib/price-comparator");
const { buildExactComparisonView } = require("../lib/exact-product-comparator");
const {
  createStorefrontScheduler,
  DEFAULT_CITY,
  DEFAULT_INPUT_FILE,
  DEFAULT_MAX_ITEMS_PER_QUERY,
  DEFAULT_REFRESH_INTERVAL_MINUTES,
  normalizeRequestedCity,
  slugifyCityName,
} = require("../lib/storefront-service");
const { ensureDir, slugify, writeScrapeOutputs } = require("../lib/output-utils");

const next = require("next");
const dev = process.env.NODE_ENV !== "production";
const nextApp = next({ dev });
const handle = nextApp.getRequestHandler();

const app = express();
const outputRoot = resolveFromCwd("output/web-runs");
const staticRoot = path.join(__dirname, "static");
const GENERIC_TEMPLATE_SELECTORS = {
  wait: ".product-card",
  card: ".product-card",
  product: ".product-name",
  category: ".product-category",
  price: ".product-price",
  brand: ".product-brand",
  presentation: ".product-size",
  link: "a",
  image: "img",
};
const SUPERKOCH_PRESET = {
  waitUntil: "domcontentloaded",
  extraWaitMs: 3000,
  scrollTimes: 2,
  scrollPixels: 1200,
  scrollDelayMs: 1200,
  selectors: {
    wait: "a.isolate.flex.overflow-clip.bg-white.relative",
    card: "a.isolate.flex.overflow-clip.bg-white.relative",
    product: "p.line-clamp-3",
    category: "",
    price: "p.font-bold",
    brand: "",
    presentation: "",
    link: "",
    image: "img.object-contain",
  },
};

let isRunning = false;
const storefrontSchedulers = new Map();
const locationCache = new Map();

app.use(express.json({ limit: "1mb" }));
app.use("/artifacts", express.static(resolveFromCwd("output")));

app.get("/api/health", (_req, res) => {
  const activeCities = Array.from(storefrontSchedulers.values()).map((entry) => ({
    city: entry.city,
    ...entry.scheduler.getStatus(),
  }));

  res.json({
    ok: true,
    running: isRunning,
    storefront: {
      defaultCity: process.env.STOREFRONT_CITY || DEFAULT_CITY,
      activeCities,
    },
  });
});

app.get("/api/location/resolve", async (req, res) => {
  try {
    const lat = parseCoordinate(req.query.lat, "latitude");
    const lon = parseCoordinate(req.query.lon, "longitude");
    const resolved = await reverseGeocodeCity(lat, lon);

    res.set("Cache-Control", "no-store");
    res.json(resolved);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/storefront", async (req, res) => {
  const city = normalizeRequestedCity(req.query.city) || process.env.STOREFRONT_CITY || DEFAULT_CITY;
  const scheduler = await ensureStorefrontScheduler(city);
  const snapshot = await scheduler.getSnapshot();
  const status = scheduler.getStatus();

  res.set("Cache-Control", "no-store");

  if (snapshot) {
    res.json({
      snapshot,
      status,
      city,
    });
    return;
  }

  res.status(status.refreshing ? 202 : 503).json({
    snapshot: null,
    status,
    city,
    error: status.lastError?.message || "Ainda não existe um snapshot salvo para a vitrine.",
  });
});

app.post("/api/storefront/refresh", async (req, res) => {
  try {
    assertRefreshAuthorized(req);

    const city =
      normalizeRequestedCity(req.body?.city || req.query.city) ||
      process.env.STOREFRONT_CITY ||
      DEFAULT_CITY;
    const waitForCompletion = readBooleanFlag(req.body?.wait, req.query.wait);
    const scheduler = await ensureStorefrontScheduler(city);
    const statusBefore = scheduler.getStatus();

    if (statusBefore.refreshing) {
      res.status(202).json({
        ok: true,
        queued: false,
        alreadyRunning: true,
        city,
        status: statusBefore,
      });
      return;
    }

    const refreshPromise = scheduler.refresh("api");

    if (!waitForCompletion) {
      refreshPromise.catch(() => {});
      res.status(202).json({
        ok: true,
        queued: true,
        alreadyRunning: false,
        city,
        status: scheduler.getStatus(),
      });
      return;
    }

    const result = await refreshPromise;
    const snapshot = result?.snapshot || (await scheduler.getSnapshot());

    res.json({
      ok: true,
      queued: false,
      alreadyRunning: false,
      city,
      status: scheduler.getStatus(),
      snapshot,
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get("/api/essentials", (_req, res) => {
  res.json({
    items: ESSENTIAL_PRODUCTS.map((item) => ({
      id: item.id,
      label: item.label,
      searchTerm: item.searchTerm,
    })),
  });
});

app.post("/api/compare-exact", async (req, res) => {
  if (isRunning) {
    res.status(409).json({
      error: "Já existe um processo em andamento. Aguarde ele terminar antes de iniciar outro.",
    });
    return;
  }

  try {
    const payload = normalizeComparePayload(req.body || {});

    isRunning = true;

    const comparison = await runPriceComparator({
      urls: payload.urls,
      inputFile: payload.inputFile,
      headless: true,
      city: payload.city,
      maxItemsPerQuery: payload.maxItemsPerQuery,
      products: payload.products,
      stdoutOnly: true,
    });
    const exactView = buildExactComparisonView(comparison);

    res.json(exactView);
  } catch (error) {
    res.status(400).json({ error: error.message });
  } finally {
    isRunning = false;
  }
});

app.post("/api/scrape", async (req, res) => {
  if (isRunning) {
    res.status(409).json({
      error: "Já existe uma extração em andamento. Aguarde ela terminar antes de iniciar outra.",
    });
    return;
  }

  try {
    const payload = normalizePayload(req.body || {});
    const runId = buildRunId(payload.url);
    const runDir = path.join(outputRoot, runId);
    const runConfig = buildConfig(payload, runDir);

    isRunning = true;

    const result = await runScraper(runConfig);
    const saved = await writeScrapeOutputs({
      result,
      outputConfig: runConfig.output,
      defaultJsonPath: path.join(runDir, "result.json"),
      cwd: process.cwd(),
    });

    const rows = result.data?.collection?.items || [];
    const columns = collectColumns(rows);

    res.json({
      runId,
      metadata: result.metadata,
      fields: result.data?.fields || {},
      columns,
      rows,
      artifactUrls: {
        json: toArtifactUrl(saved.jsonPath),
        csv: saved.csvPath ? toArtifactUrl(saved.csvPath) : null,
        html: result.artifacts.htmlPath ? toArtifactUrl(result.artifacts.htmlPath) : null,
        screenshot: result.artifacts.screenshotPath
          ? toArtifactUrl(result.artifacts.screenshotPath)
          : null,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  } finally {
    isRunning = false;
  }
});

app.all(/.*/, (req, res) => {
  return handle(req, res);
});

async function start() {
  await nextApp.prepare();
  await ensureDir(outputRoot);
  await ensureStorefrontScheduler(process.env.STOREFRONT_CITY || DEFAULT_CITY);

  const port = Number.parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.log(`Interface disponível em http://localhost:${port}`);
  });
}

async function ensureStorefrontScheduler(requestedCity) {
  const city = normalizeRequestedCity(requestedCity) || DEFAULT_CITY;
  const key = slugifyCityName(city);
  const existing = storefrontSchedulers.get(key);

  if (existing) {
    await existing.ready;
    return existing.scheduler;
  }

  const scheduler = createStorefrontScheduler({
    city,
    inputFile: process.env.STOREFRONT_INPUT_FILE || DEFAULT_INPUT_FILE,
    maxItemsPerQuery: toNumber(process.env.STOREFRONT_MAX_ITEMS, DEFAULT_MAX_ITEMS_PER_QUERY),
    intervalMinutes: toNumber(
      process.env.STOREFRONT_REFRESH_MINUTES,
      DEFAULT_REFRESH_INTERVAL_MINUTES,
    ),
  });
  const entry = {
    city,
    scheduler,
    ready: scheduler.start(),
  };

  storefrontSchedulers.set(key, entry);

  try {
    await entry.ready;
    return scheduler;
  } catch (error) {
    storefrontSchedulers.delete(key);
    throw error;
  }
}

async function reverseGeocodeCity(latitude, longitude) {
  const cacheKey = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const cached = locationCache.get(cacheKey);

  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) {
    return cached.value;
  }

  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("zoom", "10");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "pt-BR");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "scrapping_supermercados/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Nao foi possivel resolver a cidade da localizacao (${response.status}).`);
  }

  const data = await response.json();
  const address = data.address || {};
  const city =
    normalizeRequestedCity(
      address.city ||
        address.town ||
        address.municipality ||
        address.village ||
        address.city_district,
    ) || null;

  if (!city) {
    throw new Error("Nao foi possivel identificar a cidade da localizacao informada.");
  }

  const value = {
    city,
    state: normalizeRequestedCity(address.state) || null,
    country: String(address.country_code || "").toUpperCase() || null,
    latitude,
    longitude,
  };

  locationCache.set(cacheKey, {
    at: Date.now(),
    value,
  });

  return value;
}

function parseCoordinate(value, label) {
  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Informe a ${label} corretamente.`);
  }

  return parsed;
}

function normalizePayload(input) {
  const payload = {
    url: String(input.url || "").trim(),
    headless: input.headless !== false,
    waitUntil: String(input.waitUntil || "domcontentloaded"),
    navigationTimeoutMs: toNumber(input.navigationTimeoutMs, 45_000),
    extraWaitMs: toNumber(input.extraWaitMs, 2500),
    scrollTimes: toNumber(input.scrollTimes, 4),
    scrollPixels: toNumber(input.scrollPixels, 1200),
    scrollDelayMs: toNumber(input.scrollDelayMs, 1200),
    viewportWidth: toNumber(input.viewportWidth, 1440),
    viewportHeight: toNumber(input.viewportHeight, 2200),
    selectors: {
      wait: String(input.selectors?.wait || "").trim(),
      card: String(input.selectors?.card || "").trim(),
      product: String(input.selectors?.product || "").trim(),
      category: String(input.selectors?.category || "").trim(),
      price: String(input.selectors?.price || "").trim(),
      brand: String(input.selectors?.brand || "").trim(),
      presentation: String(input.selectors?.presentation || "").trim(),
      link: String(input.selectors?.link || "").trim(),
      image: String(input.selectors?.image || "").trim(),
    },
  };

  if (!payload.url) {
    throw new Error("Informe a URL do supermercado.");
  }

  applyAutomaticPreset(payload);

  if (!payload.selectors.card) {
    throw new Error("Informe o seletor CSS do card do produto.");
  }

  if (!payload.selectors.product) {
    throw new Error("Informe o seletor CSS do nome do produto.");
  }

  if (!payload.selectors.price) {
    throw new Error("Informe o seletor CSS do preço.");
  }

  return payload;
}

function applyAutomaticPreset(payload) {
  if (!isSuperKochUrl(payload.url) || !hasGenericOrEmptySelectors(payload.selectors)) {
    return;
  }

  payload.waitUntil = SUPERKOCH_PRESET.waitUntil;
  payload.extraWaitMs = SUPERKOCH_PRESET.extraWaitMs;
  payload.scrollTimes = SUPERKOCH_PRESET.scrollTimes;
  payload.scrollPixels = SUPERKOCH_PRESET.scrollPixels;
  payload.scrollDelayMs = SUPERKOCH_PRESET.scrollDelayMs;
  payload.selectors = {
    ...payload.selectors,
    ...SUPERKOCH_PRESET.selectors,
  };
}

function normalizeComparePayload(input) {
  const rawProducts = Array.isArray(input.products)
    ? input.products
    : String(input.products || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const rawUrls = Array.isArray(input.urls)
    ? input.urls
    : String(input.urls || "")
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter(Boolean);

  return {
    city: String(input.city || "").trim() || null,
    products: rawProducts.length > 0 ? rawProducts : null,
    urls: rawUrls.length > 0 ? rawUrls : null,
    inputFile: String(input.inputFile || "links.txt").trim() || "links.txt",
    maxItemsPerQuery: toNumber(input.maxItemsPerQuery, 80),
  };
}

function buildConfig(payload, runDir) {
  const actions = [];

  if (payload.selectors.wait) {
    actions.push({
      type: "waitForSelector",
      selector: payload.selectors.wait,
      timeoutMs: 20_000,
    });
  }

  if (payload.scrollTimes > 0) {
    actions.push({
      type: "scroll",
      pixels: payload.scrollPixels,
      times: payload.scrollTimes,
      delayMs: payload.scrollDelayMs,
    });
  }

  return {
    browser: "chromium",
    headless: payload.headless,
    url: payload.url,
    waitUntil: payload.waitUntil,
    gotoFallbackWaitUntil: "domcontentloaded",
    navigationTimeoutMs: payload.navigationTimeoutMs,
    extraWaitMs: payload.extraWaitMs,
    viewport: {
      width: payload.viewportWidth,
      height: payload.viewportHeight,
    },
    actions,
    extract: {
      fields: {
        title: { type: "pageTitle" },
        finalUrl: { type: "pageUrl" },
      },
      collection: {
        selector: payload.selectors.card,
        fields: buildCollectionFields(payload.selectors),
      },
    },
    output: {
      jsonPath: path.join(runDir, "result.json"),
      csvPath: path.join(runDir, "products.csv"),
      htmlPath: path.join(runDir, "rendered.html"),
      screenshotPath: path.join(runDir, "page.png"),
      fullPageScreenshot: true,
    },
  };
}

function buildCollectionFields(selectors) {
  const fields = {
    producto: { selector: selectors.product, type: "text" },
    precio: { selector: selectors.price, type: "text" },
  };

  if (selectors.category) {
    fields.categoria = { selector: selectors.category, type: "text" };
  }

  if (selectors.brand) {
    fields.marca = { selector: selectors.brand, type: "text" };
  }

  if (selectors.presentation) {
    fields.presentacion = { selector: selectors.presentation, type: "text" };
  }

  if (selectors.link) {
    fields.link =
      selectors.link === "@self"
        ? { type: "href" }
        : { selector: selectors.link, type: "href" };
  }

  if (selectors.image) {
    fields.imagen = { selector: selectors.image, type: "src" };
  }

  return fields;
}

function buildRunId(url) {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return `${stamp}-${slugify(url) || "run"}`;
}

function collectColumns(rows) {
  const columns = new Set();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columns.add(key);
    }
  }

  return Array.from(columns);
}

function toArtifactUrl(absolutePath) {
  const outputPath = resolveFromCwd("output");
  const relativePath = path.relative(outputPath, absolutePath).replaceAll(path.sep, "/");
  return `/artifacts/${relativePath}`;
}

function assertRefreshAuthorized(req) {
  const expectedToken = String(process.env.STOREFRONT_REFRESH_TOKEN || "").trim();

  if (!expectedToken) {
    return;
  }

  const header = String(req.get("authorization") || "");
  const prefix = "Bearer ";
  const providedToken = header.startsWith(prefix) ? header.slice(prefix.length).trim() : "";

  if (!providedToken || providedToken !== expectedToken) {
    const error = new Error("Token de atualizacao invalido ou ausente.");
    error.statusCode = 401;
    throw error;
  }
}

function readBooleanFlag(...values) {
  for (const value of values) {
    if (value === true || value === "true" || value === 1 || value === "1") {
      return true;
    }

    if (value === false || value === "false" || value === 0 || value === "0") {
      return false;
    }
  }

  return false;
}

function toNumber(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isSuperKochUrl(url) {
  try {
    return new URL(url).hostname.includes("superkoch.com.br");
  } catch {
    return false;
  }
}

function hasGenericOrEmptySelectors(selectors) {
  const keys = ["wait", "card", "product", "price", "image"];

  return keys.some((key) => {
    const value = selectors[key];
    return !value || value === GENERIC_TEMPLATE_SELECTORS[key];
  });
}

start().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

process.on("SIGINT", () => {
  stopAllSchedulers();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopAllSchedulers();
  process.exit(0);
});

function stopAllSchedulers() {
  for (const entry of storefrontSchedulers.values()) {
    entry.scheduler.stop();
  }
}
