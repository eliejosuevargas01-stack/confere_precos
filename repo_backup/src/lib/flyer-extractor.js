const DEFAULT_FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

const ISSUU_EMBED_HOST_PATTERN = /(^|\.)issuu\.com$/i;
const FOOTER_ROW_PATTERN =
  /(pre[cç]os?\s+v[aá]lidos?|durarem\s+os\s+estoques|lojas?\s+do\s+kompr[aã]o)/i;
const NAME_NOISE_PATTERN =
  /^(r\$$|limite\s+por\s+cliente|cart[aã]o|somente|oferta\s+v[aá]lida|imagem\s+meramente\s+ilustrativa)/i;
const ANCHOR_TOKEN_NOISE_PATTERN =
  /^(a|as|atacadista|cliente|da|de|do|durarem|e|enquanto|estoques|koch|kompr[aã]o|limite|lojas?|os|ou|para|por|pre[cç]os?|un|v[aá]lidos?)$/i;

const ROW_Y_EPSILON = 3.5;
const COLUMN_X_CLUSTER_EPSILON = 90;
const BLOCK_Y_GAP_THRESHOLD = 150;

async function loadIssuuOffersFromPage(page, { sourceUrl, cityPageUrl = null } = {}) {
  const embedSources = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe"))
      .map(
        (node) =>
          node.getAttribute("src") ||
          node.getAttribute("data-src") ||
          node.src ||
          null,
      )
      .filter(Boolean),
  );

  const publications = uniqueBy(
    embedSources.map(parseIssuuEmbedUrl).filter(Boolean),
    (publication) => `${publication.username}:${publication.docname}`,
  );
  const loadedPublications = [];
  const failedPublications = [];
  const allItems = [];

  for (const publication of publications) {
    try {
      const loaded = await loadIssuuPublication(publication, {
        sourceUrl,
        cityPageUrl,
      });

      loadedPublications.push(loaded.summary);
      allItems.push(...loaded.items);
    } catch (error) {
      failedPublications.push({
        ...publication,
        error: error.message,
      });
    }
  }

  return {
    publications: loadedPublications,
    items: dedupeOffers(allItems),
    diagnostics: {
      totalEmbeds: embedSources.length,
      totalPublications: publications.length,
      failedPublications,
    },
  };
}

async function loadIssuuPublication(publication, { sourceUrl, cityPageUrl = null } = {}) {
  const [readerResult, metadataResult] = await Promise.allSettled([
    fetchJson(publication.readerUrl),
    fetchJson(publication.metadataUrl),
  ]);

  if (readerResult.status !== "fulfilled") {
    throw readerResult.reason;
  }

  const document = readerResult.value.document;
  const metadata =
    metadataResult.status === "fulfilled"
      ? metadataResult.value?.result?.data?.json?.metadata || {}
      : {};
  const publicationTitle = metadata.title || publication.docname;
  const items = [];

  for (const [pageIndex, page] of (document.pages || []).entries()) {
    if (!page.svgUrl) {
      continue;
    }

    const svgText = await fetchText(page.svgUrl);
    const pageItems = extractOffersFromSvgPage(svgText, {
      sourceUrl,
      cityPageUrl,
      publicationId: document.publicationId || null,
      publicationTitle,
      publicationUrl: publication.publicationUrl,
      pageNumber: pageIndex + 1,
    });

    items.push(...pageItems);
  }

  return {
    items,
    summary: {
      username: publication.username,
      docname: publication.docname,
      publicationId: document.publicationId || null,
      publicationTitle,
      publicationUrl: publication.publicationUrl,
      totalPages: Array.isArray(document.pages) ? document.pages.length : 0,
      itemsFound: items.length,
    },
  };
}

function extractOffersFromSvgPage(
  svgText,
  { sourceUrl, cityPageUrl, publicationId, publicationTitle, publicationUrl, pageNumber },
) {
  const tokens = extractSvgTokens(svgText);
  const columnAnchors = inferColumnAnchors(tokens);

  if (tokens.length === 0 || columnAnchors.length === 0) {
    return [];
  }

  const columnMap = new Map();

  for (const token of tokens) {
    const columnAnchor = assignColumnAnchor(token.x, columnAnchors);
    const list = columnMap.get(columnAnchor) || [];
    list.push(token);
    columnMap.set(columnAnchor, list);
  }

  const offers = [];

  for (const [columnAnchor, columnTokens] of columnMap.entries()) {
    const rows = buildColumnRows(columnTokens).filter((row) => !isIgnoredRow(row.text));
    const blocks = buildOfferBlocks(rows);

    for (const [blockIndex, block] of blocks.entries()) {
      const priceValues = uniqueNumbers(extractPricesFromRows(block.rows));
      const offerName = buildOfferName(block.rows);

      if (!offerName || priceValues.length === 0) {
        continue;
      }

      const lowestPrice = Math.min(...priceValues);
      const highestPrice = Math.max(...priceValues);
      const hasPromotion = highestPrice > lowestPrice;

      offers.push({
        id: [
          "issuu",
          publicationId || "unknown",
          pageNumber,
          columnAnchor,
          blockIndex,
        ].join(":"),
        name: offerName,
        price: formatCurrency(lowestPrice),
        priceValue: lowestPrice,
        originalPrice: hasPromotion ? formatCurrency(highestPrice) : null,
        originalPriceValue: hasPromotion ? highestPrice : null,
        isPromotion: hasPromotion,
        promotionLabel: publicationTitle || "Encarte Issuu",
        unit: extractUnit(offerName),
        image: null,
        link: cityPageUrl || publicationUrl || sourceUrl || null,
        source: "issuu",
        sourcePage: pageNumber,
        publicationId: publicationId || null,
        publicationTitle: publicationTitle || null,
      });
    }
  }

  return offers;
}

function extractSvgTokens(svgText) {
  const pathMap = new Map();

  for (const match of svgText.matchAll(/<path\b([^>]+?)\/>/g)) {
    const attributes = match[1] || "";
    const id = getAttribute(attributes, "id");
    const d = getAttribute(attributes, "d");
    const stroke = getAttribute(attributes, "stroke");

    if (!id || !d || stroke !== "none") {
      continue;
    }

    pathMap.set(id, parsePathAnchor(d));
  }

  const tokens = [];

  for (const match of svgText.matchAll(/<text\b[^>]*>\s*<textPath\b([^>]+)>([\s\S]*?)<\/textPath>\s*<\/text>/g)) {
    const attributes = match[1] || "";
    const href = (getAttribute(attributes, "href") || "").replace(/^#/, "");
    const text = decodeEntities(stripTags(match[2] || "")).trim();
    const position = pathMap.get(href);

    if (!href || !text || !position) {
      continue;
    }

    tokens.push({
      x: position.x,
      y: position.y,
      text: normalizeWhitespace(text),
    });
  }

  return tokens
    .filter((token) => Number.isFinite(token.x) && Number.isFinite(token.y) && token.text)
    .sort((left, right) => (left.y - right.y) || (left.x - right.x));
}

function inferColumnAnchors(tokens) {
  const letterXs = tokens
    .filter((token) => /[A-Za-zÀ-ÿ]/.test(token.text) && !/^R\$$/i.test(token.text))
    .filter((token) => {
      const normalizedToken = normalizeText(token.text).replace(/[^a-z0-9]+/g, "");
      return !ANCHOR_TOKEN_NOISE_PATTERN.test(normalizedToken);
    })
    .map((token) => token.x)
    .sort((left, right) => left - right);

  if (letterXs.length === 0) {
    return [];
  }

  const groups = [];

  for (const value of letterXs) {
    const current = groups.at(-1);

    if (!current || value - current.max > COLUMN_X_CLUSTER_EPSILON) {
      groups.push({
        values: [value],
        min: value,
        max: value,
      });
      continue;
    }

    current.values.push(value);
    current.max = value;
  }

  return groups
    .map((group) => Math.round(group.min))
    .sort((left, right) => left - right);
}

function assignColumnAnchor(x, anchors) {
  let selected = anchors[0];

  for (const anchor of anchors) {
    if (x >= anchor) {
      selected = anchor;
      continue;
    }

    break;
  }

  return selected;
}

function buildColumnRows(tokens) {
  const rows = [];

  for (const token of tokens.sort((left, right) => (left.y - right.y) || (left.x - right.x))) {
    const current = rows.at(-1);

    if (current && Math.abs(current.y - token.y) <= ROW_Y_EPSILON) {
      current.tokens.push(token);
      current.maxY = Math.max(current.maxY, token.y);
      continue;
    }

    rows.push({
      y: token.y,
      maxY: token.y,
      tokens: [token],
    });
  }

  return rows.map((row) => {
    const sortedTokens = row.tokens.sort((left, right) => left.x - right.x);

    return {
      y: row.y,
      maxY: row.maxY,
      x: sortedTokens[0]?.x ?? 0,
      text: normalizeWhitespace(
        sortedTokens
          .map((token) => token.text)
          .join(" ")
          .replace(/\bR\s+\$/g, "R$")
          .replace(/\s+,/g, ",")
          .replace(/R\$\s+/g, "R$ "),
      ),
    };
  });
}

function buildOfferBlocks(rows) {
  const blocks = [];

  for (const row of rows.sort((left, right) => left.y - right.y)) {
    const current = blocks.at(-1);

    if (!current || row.y - current.maxY > BLOCK_Y_GAP_THRESHOLD) {
      blocks.push({
        minY: row.y,
        maxY: row.maxY,
        rows: [row],
      });
      continue;
    }

    current.rows.push(row);
    current.maxY = row.maxY;
  }

  return blocks;
}

function buildOfferName(rows) {
  return normalizeWhitespace(
    rows
      .map((row) => cleanNameRow(row.text))
      .filter((text) => /[A-Za-zÀ-ÿ]/.test(text))
      .filter((text) => !/^R\$$/i.test(text))
      .filter((text) => !NAME_NOISE_PATTERN.test(normalizeText(text)))
      .join(" "),
  );
}

function extractPricesFromRows(rows) {
  const prices = [];
  const centFragments = [];
  const currencyFragments = [];

  for (const row of rows) {
    prices.push(...extractCompletePricesFromText(row.text));

    for (const whole of extractCurrencyFragments(row.text)) {
      currencyFragments.push({
        y: row.y,
        whole,
      });
    }

    const trailingCents = extractTrailingCentCandidate(row.text);

    if (trailingCents !== null && !/R\$/i.test(row.text)) {
      centFragments.push({
        y: row.y,
        cents: trailingCents,
      });
    }
  }

  const usedCents = new Set();

  for (const fragment of currencyFragments) {
    const nearest = centFragments
      .map((entry, index) => ({
        ...entry,
        index,
        distance: Math.abs(entry.y - fragment.y),
      }))
      .filter((entry) => entry.distance <= 40 && !usedCents.has(entry.index))
      .sort((left, right) => left.distance - right.distance)[0];

    if (!nearest) {
      continue;
    }

    usedCents.add(nearest.index);
    prices.push(Number.parseFloat(`${fragment.whole}.${String(nearest.cents).padStart(2, "0")}`));
  }

  return prices.filter((value) => Number.isFinite(value));
}

function extractCompletePricesFromText(text) {
  return Array.from(
    normalizeWhitespace(text).matchAll(/R\$\s*(\d{1,3})\s*,\s*(\d{2})(?!\d)/g),
    (match) => Number.parseFloat(`${match[1]}.${match[2]}`),
  ).filter((value) => Number.isFinite(value));
}

function extractCurrencyFragments(text) {
  return Array.from(
    normalizeWhitespace(text).matchAll(/R\$\s*(\d{1,3})\s*,(?!\s*\d{2})/g),
    (match) => Number.parseInt(match[1], 10),
  ).filter((value) => Number.isFinite(value));
}

function extractTrailingCentCandidate(text) {
  const matches = Array.from(normalizeWhitespace(text).matchAll(/(\d{2})(?!\d)/g));

  if (matches.length === 0) {
    return null;
  }

  return Number.parseInt(matches.at(-1)[1], 10);
}

function cleanNameRow(text) {
  return normalizeWhitespace(
    normalizeWhitespace(text)
      .replace(/R\$\s*\d{1,3}\s*,?\s*\d{0,2}/gi, " ")
      .replace(/\b\d{2}\b$/g, " ")
      .replace(/\b\d{2}\s+\d{2}\b/g, " "),
  );
}

function extractUnit(text) {
  const match = normalizeWhitespace(text).match(
    /(\d+(?:[.,]\d+)?\s*(?:kg|g|mg|ml|l|m|un|rolos|folhas|litros|sach[eê]|pacote|pct))/i,
  );
  return match ? match[1] : null;
}

function dedupeOffers(offers) {
  return uniqueBy(
    offers,
    (offer) =>
      [
        normalizeText(offer.name),
        offer.priceValue ?? "",
        offer.originalPriceValue ?? "",
        offer.publicationId ?? "",
        offer.sourcePage ?? "",
      ].join("|"),
  );
}

function parseIssuuEmbedUrl(inputUrl) {
  try {
    const url = new URL(inputUrl);
    const hostname = url.hostname.replace(/^e\./i, "");

    if (!ISSUU_EMBED_HOST_PATTERN.test(hostname)) {
      return null;
    }

    const docname = url.searchParams.get("d");
    const username = url.searchParams.get("u");

    if (!docname || !username) {
      return null;
    }

    return {
      embedUrl: url.toString(),
      username,
      docname,
      publicationUrl: `https://issuu.com/${username}/docs/${docname}`,
      readerUrl: `https://publication.issuu.com/${username}/${docname}/reader4.json`,
      metadataUrl: buildIssuuMetadataUrl({ username, docname }),
    };
  } catch {
    return null;
  }
}

function buildIssuuMetadataUrl({ username, docname }) {
  const input = encodeURIComponent(
    JSON.stringify({
      json: {
        type: "user",
        username,
        documentName: docname,
      },
    }),
  );

  return `https://issuu.com/api/content-service/public.reader.dynamic?input=${input}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: DEFAULT_FETCH_HEADERS,
  });

  if (!response.ok) {
    throw new Error(`Falha ao buscar JSON (${response.status}) em ${url}`);
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: DEFAULT_FETCH_HEADERS,
  });

  if (!response.ok) {
    throw new Error(`Falha ao buscar texto (${response.status}) em ${url}`);
  }

  return response.text();
}

function parsePathAnchor(d) {
  const match = String(d || "").match(/M([0-9.]+),([0-9.]+)/);

  if (!match) {
    return null;
  }

  return {
    x: Number.parseFloat(match[1]),
    y: Number.parseFloat(match[2]),
  };
}

function getAttribute(attributes, name) {
  const match = String(attributes || "").match(new RegExp(`${name}="([^"]+)"`));
  return match ? match[1] : null;
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\uFB01/g, "fi")
    .replace(/\uFB02/g, "fl");
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isIgnoredRow(text) {
  const normalized = normalizeText(text);

  if (!normalized) {
    return true;
  }

  if (FOOTER_ROW_PATTERN.test(normalized)) {
    return true;
  }

  return false;
}

function formatCurrency(value) {
  return Number.isFinite(value) ? `R$ ${value.toFixed(2).replace(".", ",")}` : null;
}

function uniqueBy(list, keyBuilder) {
  const seen = new Set();
  const output = [];

  for (const item of list) {
    const key = keyBuilder(item);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(item);
  }

  return output;
}

function uniqueNumbers(values) {
  return Array.from(
    new Set(
      values
        .map((value) => Number.parseFloat(String(value)))
        .filter((value) => Number.isFinite(value)),
    ),
  );
}

module.exports = {
  loadIssuuOffersFromPage,
};
