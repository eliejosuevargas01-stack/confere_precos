const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");
const { ensureDir, slugify, toCsv } = require("./output-utils");
const { resolveFromCwd } = require("./scraper-core");

const DEFAULT_BASE_URL = "https://www.redetoponline.com.br";
const DEFAULT_OUTPUT_ROOT = "output/redetop-catalog";
const DEFAULT_VIEWPORT = { width: 1440, height: 2200 };

async function exportRedeTopCatalog({
  city = null,
  headless = true,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  maxDepartments = null,
  maxPagesPerDepartment = null,
  baseUrl = DEFAULT_BASE_URL,
  onLog = null,
} = {}) {
  log(onLog, "info", "Iniciando leitura dedicada do catalogo completo do Rede Top.", {
    baseUrl,
    city,
    maxDepartments,
    maxPagesPerDepartment,
  });
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    locale: "pt-BR",
    viewport: DEFAULT_VIEWPORT,
  });

  try {
    const home = await context.newPage();
    await home.goto(baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await home.waitForTimeout(4_000);
    log(onLog, "info", "Home do Rede Top carregada para descoberta de departamentos.", {
      finalUrl: home.url(),
    });

    let storeInfo = {
      storeLabel: null,
      effectiveCity: null,
      note: null,
    };

    if (city) {
      storeInfo = await selectRedeTopStore(home, city);
      await home.waitForTimeout(1_500);
      log(onLog, storeInfo.note ? "warn" : "info", "Tentativa de selecionar a loja/cidade no Rede Top concluida.", {
        requestedCity: city,
        effectiveCity: storeInfo.effectiveCity,
        storeLabel: storeInfo.storeLabel,
        note: storeInfo.note,
      });
    } else {
      const storeLabel = await readCurrentStoreLabel(home);
      storeInfo = {
        storeLabel,
        effectiveCity: extractCityFromStoreLabel(storeLabel),
        note: null,
      };
      log(onLog, "info", "Loja atual do Rede Top identificada sem troca de cidade.", {
        storeLabel,
        effectiveCity: storeInfo.effectiveCity,
      });
    }

    const departments = await extractDepartmentLinks(home, {
      maxDepartments,
      baseUrl,
    });
    await home.close();
    log(onLog, departments.length > 0 ? "info" : "warn", "Descoberta de departamentos concluida no Rede Top.", {
      totalDepartments: departments.length,
      departments: departments.slice(0, 10).map((department) => department.label),
    });

    const departmentResults = [];
    const products = [];

    for (const department of departments) {
      const result = await scrapeDepartmentCatalog(context, department, {
        maxPagesPerDepartment,
        storeInfo,
        onLog,
      });

      departmentResults.push(result);
      products.push(...result.products);
    }

    const dedupedProducts = dedupeProducts(products);
    const saved = await writeCatalogOutputs({
      outputRoot,
      city,
      baseUrl,
      storeInfo,
      departments: departmentResults,
      products: dedupedProducts,
    });

    return {
      metadata: {
        generatedAt: new Date().toISOString(),
        source: baseUrl,
        requestedCity: city || null,
        effectiveCity: storeInfo.effectiveCity || null,
        storeLabel: storeInfo.storeLabel || null,
        cityCoverage: determineCityCoverage({
          requestedCity: city,
          effectiveCity: storeInfo.effectiveCity,
        }),
        cityEligible: isCityEligible({
          requestedCity: city,
          effectiveCity: storeInfo.effectiveCity,
        }),
        totalDepartments: departmentResults.length,
        totalProducts: dedupedProducts.length,
      },
      departments: departmentResults,
      products: dedupedProducts,
      paths: saved,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function scrapeDepartmentCatalog(
  context,
  department,
  { maxPagesPerDepartment, storeInfo, onLog },
) {
  const page = await context.newPage();

  try {
    const firstUrl = `${department.url}?page=1`;
    log(onLog, "info", "Iniciando raspagem de departamento no Rede Top.", {
      department: department.label,
      url: firstUrl,
    });
    await page.goto(firstUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4_000);

    const totalProducts = await readDepartmentTotalProducts(page);
    const totalPages = await readDepartmentTotalPages(page);
    log(onLog, "info", "Departamento carregado no Rede Top.", {
      department: department.label,
      totalProducts,
      totalPages,
    });
    const pageLimit =
      Number.isFinite(maxPagesPerDepartment) && maxPagesPerDepartment > 0
        ? Math.min(totalPages || maxPagesPerDepartment, maxPagesPerDepartment)
        : totalPages || 1;

    const products = [];

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      if (pageNumber > 1) {
        await page.goto(`${department.url}?page=${pageNumber}`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForTimeout(3_000);
      }

      const pageItems = await extractDepartmentPageProducts(page, {
        department,
        pageNumber,
        storeInfo,
      });
      log(onLog, pageItems.length > 0 ? "info" : "warn", "Pagina do departamento processada.", {
        department: department.label,
        pageNumber,
        productsFound: pageItems.length,
      });

      if (pageItems.length === 0) {
        break;
      }

      products.push(...pageItems);
    }

    return {
      departmentId: department.id,
      departmentLabel: department.label,
      departmentUrl: department.url,
      totalProducts,
      totalPages,
      scrapedProducts: products.length,
      products,
    };
  } finally {
    await page.close();
  }
}

async function extractDepartmentLinks(page, { maxDepartments, baseUrl }) {
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="/departamentos/"]'))
      .map((node) => ({
        label: (node.textContent || "").replace(/\s+/g, " ").trim(),
        url: node.href,
      }))
      .filter((entry) => entry.label && entry.url),
  );

  const unique = [];
  const seen = new Set();

  for (const entry of links) {
    const url = normalizeUrl(entry.url, baseUrl);

    if (seen.has(url)) {
      continue;
    }

    seen.add(url);
    unique.push({
      id: slugify(entry.label),
      label: entry.label,
      url,
    });
  }

  if (Number.isFinite(maxDepartments) && maxDepartments > 0) {
    return unique.slice(0, maxDepartments);
  }

  return unique;
}

async function extractDepartmentPageProducts(page, { department, pageNumber, storeInfo }) {
  return page.evaluate(
    ({ department, pageNumber, storeInfo }) => {
      const priceRegex = /R\$\s*\d[\d.]*,\d{2}/g;
      const unitRegex = /\/\s*([a-zA-Z]{1,6})\b/i;

      function parsePriceValue(value) {
        const normalized = String(value || "")
          .replace(/[^\d,.-]/g, "")
          .replace(/\.(?=\d{3}(?:\D|$))/g, "")
          .replace(",", ".");
        const parsed = Number.parseFloat(normalized);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      }

      function formatCurrency(value) {
        return Number.isFinite(value) ? `R$ ${value.toFixed(2).replace(".", ",")}` : null;
      }

      function computeDiscountPercent(currentValue, originalValue) {
        if (
          !Number.isFinite(currentValue) ||
          !Number.isFinite(originalValue) ||
          originalValue <= currentValue
        ) {
          return null;
        }

        return Math.round(((originalValue - currentValue) / originalValue) * 100);
      }

      const cards = Array.from(
        document.querySelectorAll("vip-card-produto, .vip-card-produto"),
      );

      return cards
        .map((node, index) => {
          const root =
            node.tagName.toLowerCase() === "vip-card-produto"
              ? node
              : node.closest("vip-card-produto") || node;
          const titleElement =
            root.querySelector(".vip-card-produto-descricao") ||
            root.querySelector('a[href*="/produto/"] span') ||
            root.querySelector("img[alt]");
          const linkElement = root.querySelector('a[href*="/produto/"]');
          const imageElement = root.querySelector("img[alt]");
          const text = (root.textContent || "").replace(/\s+/g, " ").trim();
          const priceMatches = Array.from(text.match(priceRegex) || []);
          const values = priceMatches.map(parsePriceValue).filter((value) => Number.isFinite(value));
          const currentPriceValue = values.length > 0 ? Math.min(...values) : null;
          const originalPriceValue =
            values.length > 1 ? Math.max(...values) : null;
          const productIdMatch = linkElement?.href?.match(/\/produto\/(\d+)\//i);
          const unitMatch = text.match(unitRegex);
          const name =
            (titleElement?.textContent || imageElement?.alt || "").replace(/\s+/g, " ").trim();

          if (!name || !Number.isFinite(currentPriceValue) || currentPriceValue <= 0) {
            return null;
          }

          return {
            row_id: `${department.id}-${pageNumber}-${productIdMatch?.[1] || index + 1}`,
            product_id: productIdMatch?.[1] || null,
            name,
            price: formatCurrency(currentPriceValue),
            price_value: currentPriceValue,
            original_price:
              Number.isFinite(originalPriceValue) && originalPriceValue > currentPriceValue
                ? formatCurrency(originalPriceValue)
                : null,
            original_price_value:
              Number.isFinite(originalPriceValue) && originalPriceValue > currentPriceValue
                ? originalPriceValue
                : null,
            discount_percent: computeDiscountPercent(currentPriceValue, originalPriceValue),
            unit: unitMatch?.[1] ? `/${unitMatch[1].toLowerCase()}` : null,
            image_url: imageElement?.src || null,
            product_url: linkElement?.href || null,
            department_id: department.id,
            department_label: department.label,
            department_url: department.url,
            page: pageNumber,
            store_label: storeInfo.storeLabel || null,
            effective_city: storeInfo.effectiveCity || null,
          };
        })
        .filter(Boolean);
    },
    {
      department,
      pageNumber,
      storeInfo,
    },
  );
}

async function readDepartmentTotalProducts(page) {
  const body = await page.locator("body").innerText().catch(() => "");
  const match = body.match(/(\d+)\s+Produtos/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function readDepartmentTotalPages(page) {
  const pages = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a,button"))
      .map((node) => (node.textContent || "").trim())
      .filter((value) => /^\d+$/.test(value))
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value) && value > 0 && value < 500),
  );

  return pages.length > 0 ? Math.max(...pages) : 1;
}

async function writeCatalogOutputs({
  outputRoot,
  city,
  baseUrl,
  storeInfo,
  departments,
  products,
}) {
  const rootDir = resolveFromCwd(outputRoot);
  const cityKey = city ? slugify(city) : "default";
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const runDir = path.join(rootDir, `${stamp}-${cityKey}`);
  const jsonPath = path.join(runDir, "redetop-catalog.json");
  const csvPath = path.join(runDir, "redetop-catalog.csv");
  const summaryPath = path.join(runDir, "summary.json");

  await ensureDir(runDir);

  const summary = {
    generatedAt: new Date().toISOString(),
    source: baseUrl,
    requestedCity: city || null,
    effectiveCity: storeInfo.effectiveCity || null,
    storeLabel: storeInfo.storeLabel || null,
    cityCoverage: determineCityCoverage({
      requestedCity: city,
      effectiveCity: storeInfo.effectiveCity,
    }),
    cityEligible: isCityEligible({
      requestedCity: city,
      effectiveCity: storeInfo.effectiveCity,
    }),
    totalDepartments: departments.length,
    totalProducts: products.length,
    departments: departments.map((entry) => ({
      departmentId: entry.departmentId,
      departmentLabel: entry.departmentLabel,
      departmentUrl: entry.departmentUrl,
      totalProducts: entry.totalProducts,
      totalPages: entry.totalPages,
      scrapedProducts: entry.scrapedProducts,
    })),
  };

  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        metadata: summary,
        departments,
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
    jsonPath,
    csvPath,
    summaryPath,
  };
}

async function readCurrentStoreLabel(page) {
  return page
    .locator("button.vip-button")
    .filter({ hasText: /Retirar na loja:/i })
    .first()
    .innerText()
    .then((value) => value.replace(/\s+/g, " ").trim())
    .catch(() => null);
}

async function selectRedeTopStore(page, city) {
  const cityName = toTitleCase(city);
  const toggleButton = page
    .locator("button.vip-button")
    .filter({ hasText: /Retirar na loja:/i })
    .first();

  if (!(await toggleButton.isVisible().catch(() => false))) {
    return {
      storeLabel: null,
      effectiveCity: null,
      note: `Nao foi possivel localizar o seletor de loja do Rede Top para ${cityName}.`,
    };
  }

  await toggleButton.click({ timeout: 8_000 });
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
      storeLabel: null,
      effectiveCity: null,
      note: `Cidade ${cityName} nao encontrada no seletor de lojas do Rede Top.`,
    };
  }

  const tileText = await tile.innerText().catch(() => "");
  await tile.click({ timeout: 8_000 });
  await page.waitForTimeout(1_500);

  const confirmButton = page
    .getByRole("button", { name: /continuar e fechar/i })
    .first();

  if (await confirmButton.isVisible().catch(() => false)) {
    await confirmButton.click({ timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(2_500);
  }

  return {
    storeLabel: extractRedeTopStoreLabelFromTile(tileText) || `Rede Top - ${cityName}`,
    effectiveCity: cityName,
    note: null,
  };
}

function extractRedeTopStoreLabelFromTile(tileText) {
  const lines = String(tileText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines[0] || null;
}

function extractCityFromStoreLabel(storeLabel) {
  if (!storeLabel) {
    return null;
  }

  const match = storeLabel.match(/-\s*([^,]+?)(?:\s|$)/);
  return match ? toTitleCase(match[1].replace(/\s+-\s+.*$/, "").trim()) : null;
}

function determineCityCoverage({ requestedCity, effectiveCity }) {
  if (!requestedCity) {
    return "default";
  }

  if (!effectiveCity) {
    return "unknown";
  }

  return normalizeText(requestedCity) === normalizeText(effectiveCity) ? "match" : "mismatch";
}

function isCityEligible({ requestedCity, effectiveCity }) {
  if (!requestedCity) {
    return true;
  }

  if (!effectiveCity) {
    return false;
  }

  return normalizeText(requestedCity) === normalizeText(effectiveCity);
}

function dedupeProducts(products) {
  const map = new Map();

  for (const product of products) {
    const key = product.product_id || `${product.department_id}:${slugify(product.name)}`;
    const existing = map.get(key);

    if (!existing || compareProducts(product, existing) < 0) {
      map.set(key, product);
    }
  }

  return Array.from(map.values()).sort((left, right) => {
    if (left.department_label !== right.department_label) {
      return left.department_label.localeCompare(right.department_label, "pt-BR");
    }

    return left.name.localeCompare(right.name, "pt-BR");
  });
}

function compareProducts(left, right) {
  if ((left.page || 0) !== (right.page || 0)) {
    return (left.page || 0) - (right.page || 0);
  }

  return (left.price_value || Infinity) - (right.price_value || Infinity);
}

function normalizeUrl(url, baseUrl) {
  return new URL(url, baseUrl).toString();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toTitleCase(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function log(onLog, level, message, context = null) {
  if (typeof onLog !== "function") {
    return;
  }

  onLog({
    scope: "redetop",
    level,
    message,
    context,
    at: new Date().toISOString(),
  });
}

module.exports = {
  DEFAULT_OUTPUT_ROOT,
  exportRedeTopCatalog,
};
