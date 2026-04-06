const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");
const { ensureDir, slugify, writeScrapeOutputs } = require("./output-utils");
const { resolveFromCwd } = require("./scraper-core");

const DEFAULT_QUERY = "arroz";
const DEFAULT_VIEWPORT = { width: 1440, height: 2200 };
const DEFAULT_OUTPUT_ROOT = "output/auto-runs";
const DEFAULT_PROFILE_ROOT = "profiles";
const DEFAULT_LINKS_FILE = "links.txt";
const DEFAULT_STOP_THRESHOLD = 20;
const MAX_EXTRA_CANDIDATES = 7;
const MAX_DISCOVERED_LINKS = 24;
const NETWORK_BODY_LIMIT = 1_200_000;
const NAVIGATION_TIMEOUT_MS = 45_000;
const DEFAULT_TIMEOUT_MS = 20_000;

const PRICE_REGEX = /R\$\s*\d[\d.,]*/i;
const PRICE_GLOBAL_REGEX = /R\$\s*\d[\d.,]*/gi;

const IGNORED_NETWORK_URL_PATTERN =
  /(google-analytics|analytics\.google|doubleclick|googletagmanager|newrelic|recaptcha|onesignal|facebook|hotjar|clarity|bing|cloudflare|font|maps\.google|zendesk|zopim|vlibras|nr-data)/i;

const NAME_KEY_PATTERN =
  /(^|\.)(name|nome|title|titulo|description|descricao|productName|nomeProduto|descricao_produto|produto)$/i;
const PRICE_KEY_PATTERN =
  /(^|\.)(price|pricing\.price|pricing\.promotionalPrice|priceFormatted|preco|valor|salePrice|currentPrice|promotionPrice|precoPor|valorVenda|unitPrice)$/i;
const ORIGINAL_PRICE_KEY_PATTERN =
  /(^|\.)(pricing\.price|pricing\.originalPrice|pricing\.priceFrom|originalPrice|listPrice|compareAtPrice|preco_original|oldPrice|regularPrice|basePrice|oferta\.preco_antigo)$/i;
const IMAGE_KEY_PATTERN =
  /(^|\.)(image|imagem|img|thumb|thumbnail|photo|foto|src|urlImagem|imagemPrincipal)$/i;
const LINK_KEY_PATTERN =
  /(^|\.)(url|link|href|permalink|productUrl|slug)$/i;
const ID_KEY_PATTERN =
  /(^|\.)(id|sku|ean|gtin|codigo|productId|product_id|_id)$/i;
const UNIT_KEY_PATTERN =
  /(^|\.)(unit|unitLabel|unitType|unidade|unidade_sigla|uom|sellUnit)$/i;
const DISCOUNT_KEY_PATTERN = /(^|\.)(discount|percentage|percentual|desconto)$/i;
const PROMOTION_LABEL_KEY_PATTERN =
  /(^|\.)(promotion\.name|promotion\.title|promotion\.tag|promotion\.label|promotionName|promotionTitle|promotionLabel|oferta\.nome|oferta\.tag)$/i;
const BADGE_KEY_PATTERN =
  /(^|\.)(badge|badges|tag|tags|flag|flags|selo|selos|label|labels|chip|chips|highlight|highlights|stamp|stamps|ribbon|marketing|benefit|benefits)$/i;
const LIMIT_KEY_PATTERN =
  /(^|\.)(cpf|limit|limitText|maxPerCpf|max_per_cpf|maxQuantity|max_quantity|purchaseLimit|limite|limite_por_cpf)$/i;

async function runAutoScraper({
  urls,
  inputFile = DEFAULT_LINKS_FILE,
  headless = true,
  query = DEFAULT_QUERY,
  maxItems = 200,
  refreshProfile = false,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  profileRoot = DEFAULT_PROFILE_ROOT,
  stdoutOnly = false,
}) {
  const normalizedUrls = await resolveInputUrls(urls, inputFile);
  const browser = await chromium.launch({ headless });
  const results = [];

  try {
    for (const inputUrl of normalizedUrls) {
      results.push(
        await investigateAndScrapeSite(browser, {
          inputUrl,
          query,
          maxItems,
          refreshProfile,
          outputRoot,
          profileRoot,
          stdoutOnly,
        }),
      );
    }
  } finally {
    await browser.close();
  }

  return {
    metadata: {
      processedAt: new Date().toISOString(),
      totalUrls: results.length,
    },
    runs: results.map((result) => result.summary),
  };
}

async function investigateAndScrapeSite(
  browser,
  { inputUrl, query, maxItems, refreshProfile, outputRoot, profileRoot, stdoutOnly },
) {
  const normalizedUrl = normalizeUrl(inputUrl);
  const urlObject = new URL(normalizedUrl);
  const domain = urlObject.hostname.replace(/^www\./, "");
  const profileDir = resolveFromCwd(profileRoot);
  const profilePath = path.join(profileDir, `${slugify(domain)}.json`);
  const existingProfile = refreshProfile ? null : await loadProfile(profilePath);

  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    locale: "pt-BR",
  });

  try {
    const investigation = await investigateSite(context, {
      inputUrl: normalizedUrl,
      existingProfile,
      query,
      maxItems,
    });

    const bestCandidate = investigation.bestCandidate;
    const runDir = buildRunDir(outputRoot, domain);
    const finalPass = await rerunBestCandidate(context, bestCandidate, {
      maxItems,
      runDir,
    });

    const products =
      finalPass.selected.items.length > 0
        ? finalPass.selected.items
        : bestCandidate.selected.items;

    const result = {
      metadata: {
        sourceUrl: normalizedUrl,
        domain,
        title: finalPass.title || bestCandidate.title || null,
        url: finalPass.finalUrl || bestCandidate.finalUrl || normalizedUrl,
        investigatedAt: new Date().toISOString(),
        query,
        strategy: finalPass.selected.strategy || bestCandidate.selected.strategy,
        profilePath,
        candidateUrl: bestCandidate.inputUrl,
      },
      data: {
        fields: {
          title: finalPass.title || bestCandidate.title || null,
          finalUrl: finalPass.finalUrl || bestCandidate.finalUrl || normalizedUrl,
          strategy: finalPass.selected.strategy || bestCandidate.selected.strategy,
          selectorHint:
            finalPass.dom.selectorHint || bestCandidate.dom.selectorHint || null,
        },
        collection: {
          total: products.length,
          returned: products.length,
          items: products,
        },
      },
      diagnostics: {
        candidates: investigation.candidates.map(toCandidateSummary),
        selectedCandidate: toCandidateSummary(bestCandidate),
        rerun: {
          strategy: finalPass.selected.strategy,
          count: finalPass.selected.items.length,
          fallbackUsed: finalPass.usedFallback,
        },
      },
      artifacts: finalPass.artifacts,
    };

    const profile = buildProfile({
      existingProfile,
      domain,
      sourceUrl: normalizedUrl,
      query,
      investigation,
    });

    await ensureDir(profileDir);
    await writeJson(profilePath, profile);

    let saved = null;

    if (!stdoutOnly) {
      saved = await writeScrapeOutputs({
        result,
        outputConfig: {
          jsonPath: path.join(runDir, "result.json"),
          csvPath: path.join(runDir, "products.csv"),
        },
        defaultJsonPath: path.join(runDir, "result.json"),
        cwd: process.cwd(),
      });
    }

    return {
      result,
      summary: {
        sourceUrl: normalizedUrl,
        domain,
        strategy: result.metadata.strategy,
        productsFound: products.length,
        candidateUrl: result.metadata.candidateUrl,
        finalUrl: result.metadata.url,
        profilePath,
        outputDir: runDir,
        jsonPath: saved?.jsonPath || null,
        csvPath: saved?.csvPath || null,
        screenshotPath: result.artifacts.screenshotPath,
        htmlPath: result.artifacts.htmlPath,
      },
    };
  } finally {
    await context.close();
  }
}

async function investigateSite(context, { inputUrl, existingProfile, query, maxItems }) {
  const candidates = [];
  const inspectedUrls = new Set();

  const firstCandidate = await inspectCandidate(context, inputUrl, { maxItems });
  candidates.push(firstCandidate);
  inspectedUrls.add(firstCandidate.inputUrl);

  if (shouldStopAfterFirst(firstCandidate, inputUrl)) {
    return {
      candidates,
      bestCandidate: firstCandidate,
    };
  }

  const additionalCandidates = uniqueUrls(
    [
      existingProfile?.bestCandidate?.candidateUrl,
      ...buildCommonCandidateUrls(inputUrl, query),
      ...firstCandidate.discoveredLinks,
    ].filter(Boolean),
  );

  for (const candidateUrl of additionalCandidates) {
    const normalized = normalizeUrl(candidateUrl);

    if (inspectedUrls.has(normalized)) {
      continue;
    }

    if (inspectedUrls.size > MAX_EXTRA_CANDIDATES) {
      break;
    }

    const candidate = await inspectCandidate(context, normalized, { maxItems });
    candidates.push(candidate);
    inspectedUrls.add(candidate.inputUrl);
  }

  return {
    candidates,
    bestCandidate: selectBestCandidate(candidates),
  };
}

function shouldStopAfterFirst(candidate, inputUrl) {
  const count = candidate.selected.items.length;

  if (count >= DEFAULT_STOP_THRESHOLD) {
    return true;
  }

  return !isRootLikePath(inputUrl) && count >= 5;
}

async function inspectCandidate(context, candidateUrl, { maxItems }) {
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

  const networkCaptures = [];
  const detachCollector = attachResponseCollector(page, networkCaptures);

  try {
    const navigation = await page
      .goto(candidateUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      })
      .catch((error) => ({ error }));

    if (navigation?.error) {
      return {
        inputUrl: candidateUrl,
        finalUrl: candidateUrl,
        title: null,
        dom: emptyDomResult(),
        network: emptyNetworkResult(),
        selected: emptySelectedResult(),
        discoveredLinks: [],
        error: navigation.error.message,
      };
    }

    await settlePage(page);

    const [dom, discoveredLinks] = await Promise.all([
      inspectDom(page, maxItems),
      discoverCandidateLinks(page),
    ]);

    const network = buildNetworkResult(networkCaptures, maxItems);
    const selected = chooseBestStrategy(dom, network, maxItems);

    return {
      inputUrl: candidateUrl,
      finalUrl: page.url(),
      title: await page.title(),
      dom,
      network,
      selected,
      discoveredLinks,
      error: null,
    };
  } finally {
    detachCollector();
    await page.close();
  }
}

async function rerunBestCandidate(context, bestCandidate, { maxItems, runDir }) {
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

  const networkCaptures = [];
  const detachCollector = attachResponseCollector(page, networkCaptures);

  try {
    await page.goto(bestCandidate.inputUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    await settlePage(page);

    const dom =
      bestCandidate.selected.strategy === "dom" && bestCandidate.dom.selectorHint
        ? await extractDomWithHint(page, bestCandidate.dom.selectorHint, maxItems)
        : await inspectDom(page, maxItems);

    const network = buildNetworkResult(networkCaptures, maxItems);
    const selected = chooseBestStrategy(dom, network, maxItems);
    const fallbackSelected =
      selected.items.length > 0 ? selected : bestCandidate.selected;
    const artifacts = await saveArtifacts(page, runDir);

    return {
      title: await page.title(),
      finalUrl: page.url(),
      dom,
      network,
      selected: fallbackSelected,
      artifacts,
      usedFallback: selected.items.length === 0 && bestCandidate.selected.items.length > 0,
    };
  } finally {
    detachCollector();
    await page.close();
  }
}

function attachResponseCollector(page, captures) {
  const handler = async (response) => {
    const url = response.url();
    const contentType = String(response.headers()["content-type"] || "").toLowerCase();

    if (!shouldInspectResponse(url, contentType)) {
      return;
    }

    let text;

    try {
      text = await response.text();
    } catch {
      return;
    }

    if (!text || text.length > NETWORK_BODY_LIMIT) {
      return;
    }

    let json;

    try {
      json = JSON.parse(text);
    } catch {
      return;
    }

    const analysis = analyzeProductPayload(json, url);

    if (analysis.matches.length === 0) {
      return;
    }

    captures.push({
      url,
      status: response.status(),
      contentType,
      request: {
        method: response.request().method(),
        postData: response.request().postData() || null,
      },
      analysis,
    });
  };

  page.on("response", handler);

  return () => {
    page.off("response", handler);
  };
}

function shouldInspectResponse(url, contentType) {
  if (IGNORED_NETWORK_URL_PATTERN.test(url)) {
    return false;
  }

  if (/json|graphql-response\+json/i.test(contentType)) {
    return true;
  }

  return /(graphql|api|search|product|products|items|vitrine|catalog|ofertas|mercado|loja)/i.test(
    url,
  );
}

async function settlePage(page) {
  await page.waitForTimeout(1_500);
  await dismissCommonBanners(page);

  for (let index = 0; index < 3; index += 1) {
    await page.mouse.wheel(0, 1_300);
    await page.waitForTimeout(900);
  }

  await clickLoadMoreButtons(page);
  await clickCarouselControls(page);
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(1_200);
}

async function dismissCommonBanners(page) {
  const labels = [
    /aceitar/i,
    /concord/i,
    /entendi/i,
    /^ok$/i,
    /^fechar$/i,
    /continuar/i,
    /aceito/i,
    /permitir/i,
  ];

  for (const label of labels) {
    const locator = page.locator("button, a").filter({ hasText: label }).first();

    try {
      if (await locator.isVisible({ timeout: 350 })) {
        await locator.click({ timeout: 1_500 });
        await page.waitForTimeout(500);
      }
    } catch {
      // Ignora banners que não puderem ser fechados.
    }
  }
}

async function clickLoadMoreButtons(page) {
  const labels = [/carregar mais/i, /ver mais/i, /mostrar mais/i, /mais produtos/i];

  for (const label of labels) {
    const locator = page.locator("button, a").filter({ hasText: label }).first();

    try {
      if (await locator.isVisible({ timeout: 250 })) {
        await locator.click({ timeout: 2_000 });
        await page.waitForTimeout(1_000);
      }
    } catch {
      // Botões genéricos são opcionais; seguimos sem falhar.
    }
  }
}

async function clickCarouselControls(page) {
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
      // Carrosseis sao opcionais; seguimos sem falhar.
    }
  }
}

async function inspectDom(page, maxItems) {
  const result = await page.evaluate((limit) => {
    const priceRegex = /R\$\s*\d[\d.,]*/i;
    const priceGlobalRegex = /R\$\s*\d[\d.,]*/gi;
    const ignoreLineRegex =
      /^(comprar|adicionar|editar|criar|detalhes|ver mais|carregar mais|mais produtos|carrinho)$/i;
    const badContainerRegex =
      /(header|footer|cookie|banner|modal|popup|newsletter|search|buscar|account|login|menu|nav)/i;

    function normalizeText(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function textLines(value) {
      return Array.from(new Set(
        String(value || "")
          .split(/\n+/)
          .map(normalizeText)
          .filter(Boolean),
      ));
    }

    function parsePriceNumber(value) {
      if (value === null || value === undefined || value === "") {
        return null;
      }

      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }

      let normalized = String(value).trim();

      if (!normalized) {
        return null;
      }

      normalized = normalized.replace(/\s+/g, "");

      if (normalized.includes(",") && normalized.includes(".")) {
        if (normalized.lastIndexOf(",") > normalized.lastIndexOf(".")) {
          normalized = normalized.replace(/\./g, "").replace(",", ".");
        } else {
          normalized = normalized.replace(/,/g, "");
        }
      } else if (normalized.includes(",")) {
        normalized = normalized.replace(/\./g, "").replace(",", ".");
      } else {
        normalized = normalized.replace(/,/g, "");
      }

      normalized = normalized.replace(/[^\d.-]+/g, "");

      const numeric = Number.parseFloat(normalized);
      return Number.isFinite(numeric) ? numeric : null;
    }

    function formatCurrency(value) {
      return Number.isFinite(value) ? `R$ ${value.toFixed(2).replace(".", ",")}` : null;
    }

    function extractPriceState(text) {
      const priceMatches = text.match(priceGlobalRegex) || [];
      const priceValues = priceMatches
        .map((price) => parsePriceNumber(price))
        .filter((value) => Number.isFinite(value));

      if (priceMatches.length === 0 || priceValues.length === 0 || priceMatches.length > 3) {
        return null;
      }

      const minPrice = Math.min(...priceValues);
      const maxPrice = Math.max(...priceValues);
      const hasPromotionWords = /(oferta|promoc|clube|off|\-\d+%)/i.test(text);
      const isPromotion = priceValues.length > 1 && maxPrice > minPrice;

      return {
        price: formatCurrency(minPrice),
        priceValue: minPrice,
        originalPrice: isPromotion ? formatCurrency(maxPrice) : null,
        originalPriceValue: isPromotion ? maxPrice : null,
        isPromotion: isPromotion || hasPromotionWords,
      };
    }

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    }

    function selectorFor(element) {
      if (!element || !element.tagName) {
        return null;
      }

      if (element.id && /^[A-Za-z][\w:-]{2,}$/.test(element.id)) {
        return `#${CSS.escape(element.id)}`;
      }

      const classes = Array.from(element.classList || [])
        .filter(
          (className) =>
            /^[A-Za-z][\w-]{1,}$/.test(className) &&
            !/^(active|selected|slick-|swiper-|owl-|show|hide|visible|hidden)/i.test(className),
        )
        .slice(0, 5);

      if (classes.length === 0) {
        return null;
      }

      return `${element.tagName.toLowerCase()}${classes
        .map((className) => `.${CSS.escape(className)}`)
        .join("")}`;
    }

    function pickImage(node) {
      const image = node.querySelector("img");

      if (!image) {
        return null;
      }

      const rawValue =
        image.currentSrc ||
        image.getAttribute("src") ||
        image.getAttribute("data-src") ||
        image.getAttribute("data-lazy") ||
        null;

      if (!rawValue) {
        return null;
      }

      try {
        return new URL(rawValue, window.location.href).href;
      } catch {
        return rawValue;
      }
    }

    function pickLink(node) {
      const link = node.matches("a[href]") ? node : node.querySelector("a[href]");

      if (!link) {
        return null;
      }

      try {
        return new URL(link.getAttribute("href"), window.location.href).href;
      } catch {
        return link.href || null;
      }
    }

    function pickId(node, link) {
      const directId =
        node.getAttribute("data-idproduct") ||
        node.getAttribute("data-product-id") ||
        node.getAttribute("data-id") ||
        null;

      if (directId) {
        return directId;
      }

      const href = link || pickLink(node);
      const match = href && href.match(/\/(\d+)(?:\/|$)/);
      return match ? match[1] : null;
    }

    function pickName(node, priceText) {
      const preferredSelectors = [
        "h1",
        "h2",
        "h3",
        "h4",
        "strong",
        "[class*=name]",
        "[class*=title]",
        "[class*=nome]",
        "[class*=titulo]",
        "[id*=titulo]",
      ];

      for (const selector of preferredSelectors) {
        const element = node.querySelector(selector);

        if (!element) {
          continue;
        }

        const text = normalizeText(element.innerText || element.textContent);

        if (
          text &&
          text.length >= 3 &&
          text.length <= 180 &&
          !priceRegex.test(text) &&
          !ignoreLineRegex.test(text)
        ) {
          return text;
        }
      }

      const imageAlt = normalizeText(node.querySelector("img")?.getAttribute("alt"));

      if (imageAlt && !priceRegex.test(imageAlt) && !ignoreLineRegex.test(imageAlt)) {
        return imageAlt;
      }

      const lines = textLines(node.innerText)
        .map((line) => line.replace(priceGlobalRegex, "").trim())
        .filter(
          (line) =>
            line &&
            line.length >= 3 &&
            line.length <= 180 &&
            !ignoreLineRegex.test(line) &&
            !/^(r\$\s*\d|criar|editar)$/i.test(line),
        );

      const ranked = lines.sort((left, right) => right.length - left.length);
      return ranked[0] || null;
    }

    function collectBadges(node, productName) {
      const badgePattern =
        /(oferta|promo|clube|super barato|festival|real|sexta|carne|exclusiv|site|cpf|cliente|limite|máx|max|360|peso|unidade|leve|pague|desconto|especial)/i;
      const selectorPattern =
        /(badge|tag|flag|selo|chip|label|stamp|promo|offer|club|discount|pill|ribbon)/i;
      const lines = [];
      const seen = new Set();
      const rawNodes = Array.from(
        node.querySelectorAll("span, small, strong, div, p, button, a"),
      ).slice(0, 80);

      for (const element of rawNodes) {
        const className = `${element.className || ""} ${element.id || ""}`;
        const text = normalizeText(element.innerText || element.textContent);

        if (!text || text.length > 80 || priceRegex.test(text)) {
          continue;
        }

        if (productName && text.toLowerCase() === productName.toLowerCase()) {
          continue;
        }

        const shouldInclude =
          selectorPattern.test(className) ||
          badgePattern.test(text) ||
          /^-\d+%$/.test(text);

        if (!shouldInclude) {
          continue;
        }

        const key = text.toLowerCase();

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        lines.push(text);
      }

      const textCandidates = textLines(node.innerText)
        .filter((line) => !priceRegex.test(line))
        .filter((line) => line.length >= 2 && line.length <= 80)
        .filter((line) => badgePattern.test(line) || /^-\d+%$/.test(line));

      for (const line of textCandidates) {
        const key = line.toLowerCase();

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        lines.push(line);
      }

      return lines.slice(0, 8);
    }

    function pickPromotionLabelFromBadges(badges) {
      const prioritized = badges.find((badge) =>
        /(festival|sexta|carne|super barato|exclusiv|site|clube|real|páscoa|pascoa)/i.test(
          badge,
        ),
      );

      if (prioritized) {
        return prioritized;
      }

      return badges.find((badge) => /(oferta|promo|desconto)/i.test(badge)) || null;
    }

    function extractItem(node) {
      const text = normalizeText(node.innerText || node.textContent);
      const priceState = extractPriceState(text);

      if (!priceState) {
        return null;
      }
      const link = pickLink(node);
      const image = pickImage(node);
      const name = pickName(node, priceState.price);
      const badges = collectBadges(node, name);
      const promotionLabel = pickPromotionLabelFromBadges(badges);
      const limitText = badges.find((badge) => /cpf|cliente|limite|máx|max/i.test(badge)) || null;

      if (!name || !priceState.price) {
        return null;
      }

      return {
        id: pickId(node, link),
        name,
        price: priceState.price,
        priceValue: priceState.priceValue,
        originalPrice: priceState.originalPrice,
        originalPriceValue: priceState.originalPriceValue,
        isPromotion: priceState.isPromotion,
        promotionLabel,
        badges,
        campaignLabel: promotionLabel,
        limitText,
        isClubOffer: badges.some((badge) => /\bclub\b|\bclube\b/i.test(badge)),
        isSiteExclusive: badges.some((badge) => /exclusiv|site/i.test(badge)),
        image,
        link,
      };
    }

    const selectorMap = new Map();
    const priceNodes = Array.from(document.querySelectorAll("body *")).filter((element) => {
      if (!isVisible(element)) {
        return false;
      }

      const text = normalizeText(element.innerText || element.textContent);
      return (
        text &&
        priceRegex.test(text) &&
        text.length <= 120 &&
        (text.match(priceGlobalRegex) || []).length <= 2
      );
    });

    for (const priceNode of priceNodes.slice(0, 500)) {
      let current = priceNode;

      for (let depth = 0; depth < 5; depth += 1) {
        current = current.parentElement;

        if (!current || current === document.body) {
          break;
        }

        const selector = selectorFor(current);

        if (!selector || badContainerRegex.test(selector)) {
          continue;
        }

        if (!selectorMap.has(selector)) {
          selectorMap.set(selector, []);
        }

        selectorMap.get(selector).push(current);
      }
    }

    const candidates = [];

    for (const [selector, nodes] of selectorMap.entries()) {
      const allNodes = Array.from(document.querySelectorAll(selector)).filter(isVisible);

      if (allNodes.length < 2 || allNodes.length > 200) {
        continue;
      }

      const items = allNodes.map(extractItem).filter(Boolean);

      if (items.length < 2) {
        continue;
      }

      const priceRatio = items.length / allNodes.length;
      const linkRatio = items.filter((item) => item.link).length / items.length;
      const imageRatio = items.filter((item) => item.image).length / items.length;
      const avgNameLength =
        items.reduce((total, item) => total + item.name.length, 0) / items.length;
      const score =
        items.length * 8 +
        priceRatio * 25 +
        linkRatio * 12 +
        imageRatio * 10 +
        Math.min(avgNameLength, 80) / 10;

      candidates.push({
        selector,
        score,
        items,
        totalMatched: allNodes.length,
      });
    }

    candidates.sort((left, right) => right.score - left.score);
    const best = candidates[0];

    return best
      ? {
          selectorHint: best.selector,
          totalMatched: best.totalMatched,
          items: best.items.slice(0, limit),
        }
      : {
          selectorHint: null,
          totalMatched: 0,
          items: [],
        };
  }, maxItems);

  return {
    selectorHint: result.selectorHint,
    totalMatched: result.totalMatched,
    items: dedupeProducts(result.items).slice(0, maxItems),
  };
}

async function extractDomWithHint(page, selectorHint, maxItems) {
  const result = await page.evaluate(
    ({ selector, limit }) => {
      const nodes = Array.from(document.querySelectorAll(selector));

      function normalizeText(value) {
        return String(value || "")
          .replace(/\s+/g, " ")
          .trim();
      }

      function parsePriceNumber(value) {
        if (value === null || value === undefined || value === "") {
          return null;
        }

        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }

        let normalized = String(value).trim();

        if (!normalized) {
          return null;
        }

        normalized = normalized.replace(/\s+/g, "");

        if (normalized.includes(",") && normalized.includes(".")) {
          if (normalized.lastIndexOf(",") > normalized.lastIndexOf(".")) {
            normalized = normalized.replace(/\./g, "").replace(",", ".");
          } else {
            normalized = normalized.replace(/,/g, "");
          }
        } else if (normalized.includes(",")) {
          normalized = normalized.replace(/\./g, "").replace(",", ".");
        } else {
          normalized = normalized.replace(/,/g, "");
        }

        normalized = normalized.replace(/[^\d.-]+/g, "");

        const numeric = Number.parseFloat(normalized);
        return Number.isFinite(numeric) ? numeric : null;
      }

      function formatCurrency(value) {
        return Number.isFinite(value) ? `R$ ${value.toFixed(2).replace(".", ",")}` : null;
      }

      function extractPriceState(text) {
        const priceMatches = text.match(/R\$\s*\d[\d.,]*/gi) || [];
        const values = priceMatches
          .map((price) => parsePriceNumber(price))
          .filter((value) => Number.isFinite(value));

        if (priceMatches.length === 0 || values.length === 0) {
          return null;
        }

        const minPrice = Math.min(...values);
        const maxPrice = Math.max(...values);
        const isPromotion = values.length > 1 && maxPrice > minPrice;

        return {
          price: formatCurrency(minPrice),
          priceValue: minPrice,
          originalPrice: isPromotion ? formatCurrency(maxPrice) : null,
          originalPriceValue: isPromotion ? maxPrice : null,
          isPromotion,
        };
      }

      function pickImage(node) {
        const image = node.querySelector("img");
        if (!image) {
          return null;
        }
        const rawValue =
          image.currentSrc ||
          image.getAttribute("src") ||
          image.getAttribute("data-src") ||
          image.getAttribute("data-lazy") ||
          null;
        if (!rawValue) {
          return null;
        }
        try {
          return new URL(rawValue, window.location.href).href;
        } catch {
          return rawValue;
        }
      }

      function pickLink(node) {
        const link = node.matches("a[href]") ? node : node.querySelector("a[href]");
        if (!link) {
          return null;
        }
        try {
          return new URL(link.getAttribute("href"), window.location.href).href;
        } catch {
          return link.href || null;
        }
      }

      function pickName(node) {
        const imageAlt = normalizeText(node.querySelector("img")?.getAttribute("alt"));

        if (imageAlt) {
          return imageAlt;
        }

        const lines = String(node.innerText || "")
          .split(/\n+/)
          .map(normalizeText)
          .filter(Boolean)
          .filter((line) => !/^R\$\s*\d/.test(line) && !/^(comprar|adicionar)$/i.test(line))
          .sort((left, right) => right.length - left.length);

        return lines[0] || null;
      }

      function collectBadges(node, productName) {
        const badgePattern =
          /(oferta|promo|clube|super barato|festival|real|sexta|carne|exclusiv|site|cpf|cliente|limite|máx|max|360|peso|unidade|leve|pague|desconto|especial)/i;
        const selectorPattern =
          /(badge|tag|flag|selo|chip|label|stamp|promo|offer|club|discount|pill|ribbon)/i;
        const lines = [];
        const seen = new Set();
        const rawNodes = Array.from(
          node.querySelectorAll("span, small, strong, div, p, button, a"),
        ).slice(0, 80);

        for (const element of rawNodes) {
          const className = `${element.className || ""} ${element.id || ""}`;
          const text = normalizeText(element.innerText || element.textContent);

          if (!text || text.length > 80 || /^R\$\s*\d/.test(text)) {
            continue;
          }

          if (productName && text.toLowerCase() === productName.toLowerCase()) {
            continue;
          }

          const shouldInclude =
            selectorPattern.test(className) ||
            badgePattern.test(text) ||
            /^-\d+%$/.test(text);

          if (!shouldInclude) {
            continue;
          }

          const key = text.toLowerCase();

          if (seen.has(key)) {
            continue;
          }

          seen.add(key);
          lines.push(text);
        }

        return lines.slice(0, 8);
      }

      function pickPromotionLabelFromBadges(badges) {
        const prioritized = badges.find((badge) =>
          /(festival|sexta|carne|super barato|exclusiv|site|clube|real|páscoa|pascoa)/i.test(
            badge,
          ),
        );

        if (prioritized) {
          return prioritized;
        }

        return badges.find((badge) => /(oferta|promo|desconto)/i.test(badge)) || null;
      }

      const items = nodes
        .map((node) => {
          const text = normalizeText(node.innerText || node.textContent);
          const priceState = extractPriceState(text);
          const name = pickName(node);
          const badges = collectBadges(node, name);
          const promotionLabel = pickPromotionLabelFromBadges(badges);
          const limitText = badges.find((badge) => /cpf|cliente|limite|máx|max/i.test(badge)) || null;

          if (!name || !priceState?.price) {
            return null;
          }

          return {
            id:
              node.getAttribute("data-idproduct") ||
              node.getAttribute("data-product-id") ||
              null,
            name,
            price: priceState.price,
            priceValue: priceState.priceValue,
            originalPrice: priceState.originalPrice,
            originalPriceValue: priceState.originalPriceValue,
            isPromotion: priceState.isPromotion,
            promotionLabel,
            badges,
            campaignLabel: promotionLabel,
            limitText,
            isClubOffer: badges.some((badge) => /\bclub\b|\bclube\b/i.test(badge)),
            isSiteExclusive: badges.some((badge) => /exclusiv|site/i.test(badge)),
            image: pickImage(node),
            link: pickLink(node),
          };
        })
        .filter(Boolean)
        .slice(0, limit);

      return {
        selectorHint: selector,
        totalMatched: nodes.length,
        items,
      };
    },
    { selector: selectorHint, limit: maxItems },
  );

  return {
    selectorHint: result.selectorHint,
    totalMatched: result.totalMatched,
    items: dedupeProducts(result.items).slice(0, maxItems),
  };
}

async function discoverCandidateLinks(page) {
  const currentOrigin = new URL(page.url()).origin;

  const links = await page.evaluate(
    ({ origin, maxLinks }) => {
      const includePattern =
        /(produto|produtos|oferta|ofertas|encarte|categoria|catalog|departamento|buscar|busca|search|listar|shop|loja|todos os produtos|ver mais|mostrar mais|mais produtos|ver tudo|subcategoria|colec)/i;
      const excludePattern =
        /(carrinho|cart|login|conta|privacidade|cookie|instagram|facebook|linkedin|blog|carreiras|fornecedor|contato|fale|portal|formas-de-pagamento|pagamento|institucional|quem-somos)/i;

      const candidates = Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => {
          const text = String(anchor.innerText || anchor.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          const href = anchor.href;

          return { href, text };
        })
        .filter(({ href }) => href && href.startsWith(origin))
        .filter(({ href, text }) => includePattern.test(`${href} ${text}`))
        .filter(({ href, text }) => !excludePattern.test(`${href} ${text}`))
        .map((candidate) => ({
          ...candidate,
          score: scoreLink(candidate),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, maxLinks);

      return candidates.map((candidate) => candidate.href);

      function scoreLink(candidate) {
        const haystack = `${candidate.href} ${candidate.text}`;
        let score = 0;

        if (/listar todos os produtos/i.test(haystack)) {
          score += 40;
        }

        if (/todos os produtos|ver tudo|mostrar tudo/i.test(haystack)) {
          score += 34;
        }

        if (/ver mais|mostrar mais|mais produtos/i.test(haystack)) {
          score += 28;
        }

        if (/produtos/i.test(haystack)) {
          score += 20;
        }

        if (/categoria|departamento|subcategoria/i.test(haystack)) {
          score += 18;
        }

        if (/\/categorias?\//i.test(candidate.href)) {
          score += 16;
        }

        if (/\/departamentos?\//i.test(candidate.href)) {
          score += 12;
        }

        if (/ofertas|encarte/i.test(haystack)) {
          score += 6;
        }

        return score;
      }
    },
    { origin: currentOrigin, maxLinks: MAX_DISCOVERED_LINKS },
  );

  return uniqueUrls(links);
}

function buildNetworkResult(captures, maxItems) {
  const matches = captures
    .flatMap((capture) =>
      capture.analysis.matches.map((match) => ({
        ...match,
        responseUrl: capture.url,
        method: capture.request.method,
      })),
    )
    .sort((left, right) => right.score - left.score);

  const items = dedupeProducts(matches.flatMap((match) => match.items)).slice(0, maxItems);

  return {
    count: items.length,
    items,
    matches: matches.slice(0, 8).map((match) => ({
      path: match.path,
      responseUrl: match.responseUrl,
      score: match.score,
      normalizedCount: match.items.length,
    })),
  };
}

function analyzeProductPayload(payload, sourceUrl) {
  const matches = [];
  walkValue(payload, "$", 0);

  return {
    matches,
  };

  function walkValue(value, pathKey, depth) {
    if (depth > 6 || value === null || value === undefined) {
      return;
    }

    if (Array.isArray(value)) {
      const match = scoreProductArray(value, pathKey, sourceUrl);

      if (match) {
        matches.push(match);
      }

      for (const item of value.slice(0, 20)) {
        if (item && typeof item === "object") {
          walkValue(item, `${pathKey}[]`, depth + 1);
        }
      }

      return;
    }

    if (typeof value !== "object") {
      return;
    }

    for (const [key, childValue] of Object.entries(value).slice(0, 80)) {
      walkValue(childValue, `${pathKey}.${key}`, depth + 1);
    }
  }
}

function scoreProductArray(arrayValue, pathKey, sourceUrl) {
  if (!Array.isArray(arrayValue) || arrayValue.length === 0) {
    return null;
  }

  const objectItems = arrayValue.filter(
    (item) => item && typeof item === "object" && !Array.isArray(item),
  );

  if (objectItems.length === 0) {
    return null;
  }

  const normalizedItems = objectItems
    .map((item) => normalizeProductObject(item, sourceUrl))
    .filter((item) => item.name && item.price);

  if (normalizedItems.length === 0) {
    return null;
  }

  const score =
    normalizedItems.length * 10 +
    (/product|produto|products|produtos|hits|items|vitrine|search/i.test(pathKey)
      ? 20
      : 0) +
    (/product|produto|products|produtos|search|vitrine/i.test(sourceUrl) ? 15 : 0);

  return {
    path: pathKey,
    score,
    items: dedupeProducts(normalizedItems),
  };
}

function normalizeProductObject(item, sourceUrl) {
  const flattened = flattenObject(item);
  const name = pickFlattenedValue(
    flattened,
    NAME_KEY_PATTERN,
    (value) => typeof value === "string" && value.length >= 3 && !PRICE_REGEX.test(value),
    true,
  );
  const priceValue = pickFlattenedValue(
    flattened,
    PRICE_KEY_PATTERN,
    (value) => typeof value === "number" || typeof value === "string",
    false,
  );
  const imageValue = pickFlattenedValue(
    flattened,
    IMAGE_KEY_PATTERN,
    (value) =>
      typeof value === "string" &&
      (value.startsWith("/") ||
        /^https?:\/\//i.test(value) ||
        /^base\//i.test(value) ||
        /^imgs\//i.test(value)),
    false,
  );
  const linkValue = pickFlattenedValue(flattened, LINK_KEY_PATTERN, (value) => {
    if (typeof value !== "string") {
      return false;
    }

    return /^https?:\/\//i.test(value) || value.startsWith("/") || /^[a-z0-9-]+$/i.test(value);
  }, false);
  const idValue = pickFlattenedValue(
    flattened,
    ID_KEY_PATTERN,
    (value) => typeof value === "string" || typeof value === "number",
    false,
  );
  const unitValue = pickFlattenedValue(
    flattened,
    UNIT_KEY_PATTERN,
    (value) => typeof value === "string" && value.length <= 20,
    false,
  );
  const promotionLabelValue = pickFlattenedValue(
    flattened,
    PROMOTION_LABEL_KEY_PATTERN,
    (value) => typeof value === "string" && value.length >= 2 && value.length <= 80,
    false,
  );
  const discountValue = pickFlattenedValue(
    flattened,
    DISCOUNT_KEY_PATTERN,
    (value) => typeof value === "number" || typeof value === "string",
    false,
  );
  const badgeValues = pickFlattenedValues(
    flattened,
    BADGE_KEY_PATTERN,
    (value) => typeof value === "string" && value.length >= 2 && value.length <= 80,
    12,
  );
  const limitValue = pickFlattenedValue(
    flattened,
    LIMIT_KEY_PATTERN,
    (value) => typeof value === "string" && value.length >= 3 && value.length <= 80,
    false,
  );

  const normalizedName = sanitizeProductText(name);
  const priceState = extractNormalizedPriceState(item, flattened, priceValue);
  const normalizedPrice = formatPrice(priceState.currentPriceValue ?? priceValue);
  const normalizedImage = absolutizeUrl(imageValue, sourceUrl);
  const normalizedLink = normalizeLink(linkValue, sourceUrl);
  const normalizedOriginalPrice = formatPrice(priceState.originalPriceValue);
  const normalizedUnit = sanitizeSimpleText(unitValue);
  const normalizedPromotionLabel = sanitizeSimpleText(
    priceState.promotionLabel || promotionLabelValue,
  );
  const discountPercent = normalizeDiscountPercent(
    priceState.discountPercent ?? discountValue,
    priceState.currentPriceValue,
    priceState.originalPriceValue,
  );
  const badges = normalizeBadgeList([
    ...badgeValues,
    priceState.promotionLabel,
    item?.clube ? "Clube" : null,
    item?.exclusive || item?.siteExclusive ? "Exclusivo do site" : null,
  ]);
  const limitText = normalizeLimitText(limitValue || badges.find((badge) => /cpf|cliente|limite/i.test(badge)));
  const campaignLabel = deriveCampaignLabel({
    promotionLabel: normalizedPromotionLabel,
    badges,
  });
  const isClubOffer =
    Boolean(item?.clube) ||
    badges.some((badge) => /\bclub\b|\bclube\b/i.test(badge));
  const isSiteExclusive =
    Boolean(item?.exclusive || item?.siteExclusive) ||
    badges.some((badge) => /exclusiv|site/i.test(badge));
  const isPromotion =
    Boolean(priceState.isPromotion) ||
    (priceState.originalPriceValue !== null &&
      priceState.currentPriceValue !== null &&
      priceState.originalPriceValue > priceState.currentPriceValue);

  if (!normalizedName || !normalizedPrice) {
    return {
      id: null,
      name: null,
      price: null,
      priceValue: null,
      originalPrice: null,
      originalPriceValue: null,
      isPromotion: false,
      promotionLabel: null,
      discountPercent: null,
      badges: [],
      campaignLabel: null,
      limitText: null,
      isClubOffer: false,
      isSiteExclusive: false,
      unit: null,
      image: null,
      link: null,
    };
  }

  if (!normalizedImage && !normalizedLink && !idValue) {
    return {
      id: null,
      name: null,
      price: null,
      priceValue: null,
      originalPrice: null,
      originalPriceValue: null,
      isPromotion: false,
      promotionLabel: null,
      discountPercent: null,
      badges: [],
      campaignLabel: null,
      limitText: null,
      isClubOffer: false,
      isSiteExclusive: false,
      unit: null,
      image: null,
      link: null,
    };
  }

  if (/^store\d+:/i.test(normalizedName)) {
    return {
      id: null,
      name: null,
      price: null,
      priceValue: null,
      originalPrice: null,
      originalPriceValue: null,
      isPromotion: false,
      promotionLabel: null,
      discountPercent: null,
      badges: [],
      campaignLabel: null,
      limitText: null,
      isClubOffer: false,
      isSiteExclusive: false,
      unit: null,
      image: null,
      link: null,
    };
  }

  return {
    id: idValue ? String(idValue) : null,
    name: normalizedName,
    price: normalizedPrice,
    priceValue: priceState.currentPriceValue,
    originalPrice: normalizedOriginalPrice,
    originalPriceValue: priceState.originalPriceValue,
    isPromotion,
    promotionLabel: normalizedPromotionLabel,
    discountPercent,
    badges,
    campaignLabel,
    limitText,
    isClubOffer,
    isSiteExclusive,
    unit: normalizedUnit,
    image: normalizedImage,
    link: normalizedLink,
  };
}

function extractNormalizedPriceState(item, flattened, fallbackPriceValue) {
  const directPromotionPrice = firstFiniteNumber([
    item?.pricing?.promotionalPrice,
    item?.oferta?.preco_oferta,
    item?.promotionPrice,
    item?.salePrice,
    item?.currentPrice,
  ]);
  const directRegularPrice = firstFiniteNumber([
    item?.oferta?.preco_antigo,
    item?.preco_original,
    item?.pricing?.price,
    item?.originalPrice,
    item?.listPrice,
    item?.compareAtPrice,
    item?.price,
    item?.preco,
    item?.valor,
  ]);
  const flattenedCurrentPrice = parsePriceValue(
    pickFlattenedValue(
      flattened,
      PRICE_KEY_PATTERN,
      (value) => typeof value === "number" || typeof value === "string",
      false,
    ),
  );
  const flattenedOriginalPrice = parsePriceValue(
    pickFlattenedValue(
      flattened,
      ORIGINAL_PRICE_KEY_PATTERN,
      (value) => typeof value === "number" || typeof value === "string",
      false,
    ),
  );

  let currentPriceValue = directPromotionPrice;
  let originalPriceValue = null;

  if (currentPriceValue !== null) {
    const regularCandidate = firstFiniteNumber([directRegularPrice, flattenedOriginalPrice]);
    originalPriceValue =
      regularCandidate !== null && regularCandidate > currentPriceValue
        ? regularCandidate
        : null;
  } else {
    currentPriceValue = firstFiniteNumber([
      directRegularPrice,
      flattenedCurrentPrice,
      fallbackPriceValue,
    ]);

    const originalCandidate = firstFiniteNumber([flattenedOriginalPrice]);
    originalPriceValue =
      originalCandidate !== null &&
      currentPriceValue !== null &&
      originalCandidate > currentPriceValue
        ? originalCandidate
        : null;
  }

  const rawPromotionLabel =
    item?.pricing?.promotion?.name ||
    item?.pricing?.promotion?.title ||
    item?.pricing?.promotion?.tag ||
    item?.oferta?.nome ||
    item?.oferta?.tag ||
    null;
  const rawDiscount =
    item?.discount ??
    item?.pricing?.discount ??
    item?.oferta?.percentual_desconto ??
    item?.oferta?.desconto ??
    null;
  const hasPromotionFlag = Boolean(item?.pricing?.promotion || item?.em_oferta || item?.oferta);

  return {
    currentPriceValue,
    originalPriceValue,
    isPromotion:
      hasPromotionFlag ||
      (currentPriceValue !== null &&
        originalPriceValue !== null &&
        originalPriceValue > currentPriceValue),
    promotionLabel: rawPromotionLabel,
    discountPercent: rawDiscount,
  };
}

function flattenObject(value, prefix = "", depth = 0, target = []) {
  if (depth > 4 || value === null || value === undefined) {
    return target;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 5)) {
      if (item && typeof item === "object") {
        flattenObject(item, prefix, depth + 1, target);
      } else if (item !== null && item !== undefined && prefix) {
        target.push([prefix, item]);
      }
    }

    return target;
  }

  if (typeof value !== "object") {
    if (prefix) {
      target.push([prefix, value]);
    }
    return target;
  }

  for (const [key, childValue] of Object.entries(value).slice(0, 40)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    flattenObject(childValue, nextPrefix, depth + 1, target);
  }

  return target;
}

function pickFlattenedValue(flattened, keyPattern, validator, allowFallback = false) {
  const ranked = flattened
    .filter(([key, value]) => keyPattern.test(key))
    .filter(([, value]) => validator(value))
    .sort(([leftKey], [rightKey]) => leftKey.length - rightKey.length);

  if (ranked.length > 0) {
    return ranked[0][1];
  }

  if (!allowFallback) {
    return null;
  }

  const fallback = flattened.find(([, value]) => validator(value));
  return fallback ? fallback[1] : null;
}

function pickFlattenedValues(flattened, keyPattern, validator, limit = 8) {
  return flattened
    .filter(([key, value]) => keyPattern.test(key) && validator(value))
    .map(([, value]) => value)
    .slice(0, limit);
}

function formatPrice(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = parsePriceValue(value);

  if (numeric !== null) {
    return `R$ ${numeric.toFixed(2).replace(".", ",")}`;
  }

  const normalized = String(value).replace(/\s+/g, " ").trim();

  if (PRICE_REGEX.test(normalized)) {
    return normalized.match(PRICE_REGEX)[0];
  }
  return normalized || null;
}

function parsePriceValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  let normalized = String(value).trim();

  if (!normalized) {
    return null;
  }

  normalized = normalized.replace(/\s+/g, "");

  if (normalized.includes(",") && normalized.includes(".")) {
    if (normalized.lastIndexOf(",") > normalized.lastIndexOf(".")) {
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  } else if (normalized.includes(",")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = normalized.replace(/,/g, "");
  }

  normalized = normalized.replace(/[^\d.-]+/g, "");

  const numeric = Number.parseFloat(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function sanitizeProductText(value) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .replace(PRICE_GLOBAL_REGEX, "")
    .trim();

  return normalized || null;
}

function sanitizeSimpleText(value) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || null;
}

function normalizeBadgeList(values) {
  const seen = new Set();
  const badges = [];

  for (const value of values) {
    const normalized = sanitizeSimpleText(value);

    if (!normalized) {
      continue;
    }

    if (PRICE_REGEX.test(normalized)) {
      continue;
    }

    if (normalized.length < 2 || normalized.length > 80) {
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
  const normalized = sanitizeSimpleText(value);

  if (!normalized) {
    return null;
  }

  return /cpf|cliente|limite|máx|max/i.test(normalized) ? normalized : null;
}

function deriveCampaignLabel({ promotionLabel, badges }) {
  const candidates = [
    promotionLabel,
    ...(Array.isArray(badges) ? badges : []),
  ]
    .map((value) => sanitizeSimpleText(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (/festival|sexta|carne|super barato|exclusiv|clube|real|páscoa|pascoa|site/i.test(candidate)) {
      return candidate;
    }
  }

  for (const candidate of candidates) {
    if (!/^oferta$|^promo(c|ç)ão$|^promo(c|ç)oes$|^clube$/i.test(candidate)) {
      return candidate;
    }
  }

  return sanitizeSimpleText(promotionLabel);
}

function normalizeDiscountPercent(value, currentPriceValue, originalPriceValue) {
  const numeric = parsePriceValue(value);

  if (numeric !== null) {
    return Math.round(numeric);
  }

  if (
    currentPriceValue !== null &&
    originalPriceValue !== null &&
    originalPriceValue > currentPriceValue
  ) {
    return Math.round(((originalPriceValue - currentPriceValue) / originalPriceValue) * 100);
  }

  return null;
}

function firstFiniteNumber(values) {
  for (const value of values) {
    const numeric = parsePriceValue(value);

    if (numeric !== null) {
      return numeric;
    }
  }

  return null;
}

function normalizeLink(value, sourceUrl) {
  if (!value) {
    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

  if (/^https?:\/\//i.test(value) || value.startsWith("/")) {
    return absolutizeUrl(value, sourceUrl);
  }

  if (/^[a-z0-9-]+$/i.test(value)) {
    return absolutizeUrl(`/produto/${value}`, sourceUrl);
  }

  return null;
}

function absolutizeUrl(value, sourceUrl) {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    return new URL(value, sourceUrl).href;
  } catch {
    return null;
  }
}

function chooseBestStrategy(dom, network, maxItems) {
  if (network.count === 0 && dom.items.length === 0) {
    return emptySelectedResult();
  }

  if (network.count > dom.items.length) {
    return {
      strategy: "network",
      items: network.items.slice(0, maxItems),
    };
  }

  return {
    strategy: "dom",
    items: dom.items.slice(0, maxItems),
  };
}

function selectBestCandidate(candidates) {
  return [...candidates].sort((left, right) => {
    const countDiff = right.selected.items.length - left.selected.items.length;

    if (countDiff !== 0) {
      return countDiff;
    }

    if (right.selected.strategy === "network" && left.selected.strategy !== "network") {
      return 1;
    }

    if (left.selected.strategy === "network" && right.selected.strategy !== "network") {
      return -1;
    }

    return 0;
  })[0];
}

function buildProfile({ existingProfile, domain, sourceUrl, query, investigation }) {
  const bestCandidate = investigation.bestCandidate;

  return {
    version: 1,
    domain,
    sourceUrl,
    query,
    savedAt: new Date().toISOString(),
    previousSavedAt: existingProfile?.savedAt || null,
    bestCandidate: {
      candidateUrl: bestCandidate.inputUrl,
      finalUrl: bestCandidate.finalUrl,
      title: bestCandidate.title,
      strategy: bestCandidate.selected.strategy,
      selectorHint: bestCandidate.dom.selectorHint || null,
      productsFound: bestCandidate.selected.items.length,
    },
    candidates: investigation.candidates.map(toCandidateSummary),
  };
}

function toCandidateSummary(candidate) {
  return {
    inputUrl: candidate.inputUrl,
    finalUrl: candidate.finalUrl,
    title: candidate.title,
    strategy: candidate.selected.strategy,
    productsFound: candidate.selected.items.length,
    selectorHint: candidate.dom.selectorHint || null,
    error: candidate.error || null,
  };
}

function buildCommonCandidateUrls(inputUrl, query) {
  const base = new URL(normalizeUrl(inputUrl));
  const encodedQuery = encodeURIComponent(query);
  const origin = base.origin;

  return uniqueUrls([
    `${origin}/listar.php`,
    `${origin}/produtos`,
    `${origin}/ofertas`,
    `${origin}/ofertas-por-cidade`,
    `${origin}/catalogsearch/result/?q=${encodedQuery}`,
    `${origin}/busca/${encodedQuery}`,
    `${origin}/busca?busca=${encodedQuery}`,
    `${origin}/search?q=${encodedQuery}`,
    `${origin}/pesquisa?busca=${encodedQuery}`,
  ]);
}

function isRootLikePath(url) {
  const pathname = new URL(normalizeUrl(url)).pathname;
  return pathname === "/" || pathname === "/index.php" || pathname === "";
}

function buildRunDir(outputRoot, domain) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolveFromCwd(path.join(outputRoot, `${timestamp}-${slugify(domain)}`));
}

async function saveArtifacts(page, runDir) {
  const htmlPath = path.join(runDir, "rendered.html");
  const screenshotPath = path.join(runDir, "page.png");
  await ensureDir(runDir);
  await fs.writeFile(htmlPath, await page.content(), "utf8");
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });

  return {
    htmlPath,
    screenshotPath,
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

async function loadProfile(profilePath) {
  try {
    const raw = await fs.readFile(profilePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeJson(targetPath, data) {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, JSON.stringify(data, null, 2), "utf8");
}

function normalizeUrl(value) {
  if (!value) {
    throw new Error("URL inválida.");
  }

  const raw = String(value).trim();
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function uniqueUrls(urls) {
  return Array.from(new Set(urls.map((url) => normalizeUrl(url))));
}

function dedupeProducts(items) {
  const deduped = new Map();

  for (const item of items) {
    const priceValue = parsePriceValue(item.priceValue ?? item.price);
    const originalPriceValue = parsePriceValue(
      item.originalPriceValue ?? item.originalPrice,
    );
    const normalized = {
      id: item.id || null,
      name: sanitizeProductText(item.name),
      price: formatPrice(priceValue ?? item.price),
      priceValue,
      originalPrice:
        originalPriceValue !== null && originalPriceValue > (priceValue ?? 0)
          ? formatPrice(originalPriceValue)
          : null,
      originalPriceValue:
        originalPriceValue !== null && priceValue !== null && originalPriceValue > priceValue
          ? originalPriceValue
          : null,
      isPromotion:
        Boolean(item.isPromotion) ||
        (originalPriceValue !== null && priceValue !== null && originalPriceValue > priceValue),
      promotionLabel: sanitizeSimpleText(item.promotionLabel),
      discountPercent: normalizeDiscountPercent(
        item.discountPercent,
        priceValue,
        originalPriceValue,
      ),
      badges: normalizeBadgeList(item.badges || []),
      campaignLabel: sanitizeSimpleText(item.campaignLabel),
      limitText: normalizeLimitText(item.limitText),
      isClubOffer: Boolean(item.isClubOffer),
      isSiteExclusive: Boolean(item.isSiteExclusive),
      unit: sanitizeSimpleText(item.unit),
      image: item.image || null,
      link: item.link || null,
    };
    const key = [
      normalized.id,
      normalized.link,
      normalized.name?.toLowerCase(),
      normalized.price,
    ]
      .filter(Boolean)
      .join("|");

    if (!normalized.name || !normalized.price || !key) {
      continue;
    }

    const existing = deduped.get(key);

    if (!existing || scoreNormalizedProduct(normalized) > scoreNormalizedProduct(existing)) {
      deduped.set(key, normalized);
    }
  }

  return Array.from(deduped.values());
}

function scoreNormalizedProduct(item) {
  let score = 0;

  if (item.image) score += 3;
  if (item.link) score += 3;
  if (item.unit) score += 1;
  if (item.originalPrice) score += 2;
  if (item.discountPercent !== null && item.discountPercent !== undefined) score += 2;
  if (item.promotionLabel) score += 2;
  if (item.campaignLabel) score += 2;
  if (item.limitText) score += 2;
  if (item.isClubOffer) score += 1;
  if (item.isSiteExclusive) score += 1;
  if (Array.isArray(item.badges)) score += item.badges.length;

  return score;
}

function emptyDomResult() {
  return {
    selectorHint: null,
    totalMatched: 0,
    items: [],
  };
}

function emptyNetworkResult() {
  return {
    count: 0,
    items: [],
    matches: [],
  };
}

function emptySelectedResult() {
  return {
    strategy: "none",
    items: [],
  };
}

module.exports = {
  DEFAULT_LINKS_FILE,
  DEFAULT_PROFILE_ROOT,
  DEFAULT_QUERY,
  inspectCandidate,
  normalizeUrl,
  parsePriceValue,
  sanitizeProductText,
  runAutoScraper,
};
