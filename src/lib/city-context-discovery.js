const { normalizeUrl } = require("./auto-site-profiler");

async function prepareCatalogSiteContext({
  context,
  sourceUrl,
  city = null,
  adapterId = "generic-full",
  onLog = null,
}) {
  const normalizedUrl = normalizeUrl(sourceUrl);
  const hostname = new URL(normalizedUrl).hostname.replace(/^www\./, "");
  const requestedCity = city ? toTitleCase(city) : null;
  const preferredCatalogRoots = buildPreferredCatalogRoots(normalizedUrl, hostname);

  if (!requestedCity) {
    return {
      strategy: "no-city-requested",
      requestedCity: null,
      effectiveCity: null,
      storeLabel: null,
      cityCoverage: "default",
      cityEligible: true,
      note: null,
      contextUrl: normalizedUrl,
      preferredCatalogRoots,
    };
  }

  log(onLog, "info", "Iniciando preparacao de contexto por cidade.", {
    sourceUrl: normalizedUrl,
    hostname,
    requestedCity,
    adapterId,
  });

  const page = await context.newPage();

  try {
    await page.goto(normalizedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await settle(page);

    const strategies = buildCityStrategies(hostname);
    let bestResult = null;

    for (const strategy of strategies) {
      log(onLog, "info", "Tentando estrategia de cidade.", {
        sourceUrl: normalizedUrl,
        requestedCity,
        strategy: strategy.id,
      });

      const result = await strategy.run(page, {
        sourceUrl: normalizedUrl,
        requestedCity,
        onLog,
      });

      bestResult = chooseBestResult(bestResult, result);

      if (result?.cityEligible) {
        log(onLog, "info", "Cidade aplicada com sucesso para a fonte.", {
          sourceUrl: normalizedUrl,
          requestedCity,
          effectiveCity: result.effectiveCity,
          storeLabel: result.storeLabel,
          strategy: result.strategy,
        });
        return {
          ...result,
          requestedCity,
          contextUrl: result.contextUrl || page.url(),
          preferredCatalogRoots: uniqueRoots([result.contextUrl || page.url(), ...preferredCatalogRoots]),
        };
      }
    }

    const fallback = bestResult || {
      strategy: "city-selection-unavailable",
      effectiveCity: null,
      storeLabel: null,
      note: `Nao foi possivel localizar um seletor de cidade/loja para ${requestedCity}.`,
    };

    log(onLog, "warn", "Nao foi possivel confirmar a cidade solicitada na fonte.", {
      sourceUrl: normalizedUrl,
      requestedCity,
      effectiveCity: fallback.effectiveCity,
      storeLabel: fallback.storeLabel,
      strategy: fallback.strategy,
      note: fallback.note,
    });

    return {
      ...fallback,
      requestedCity,
      cityCoverage: determineCityCoverage({
        requestedCity,
        effectiveCity: fallback.effectiveCity,
      }),
      cityEligible: isCityEligible({
        requestedCity,
        effectiveCity: fallback.effectiveCity,
      }),
      contextUrl: fallback.contextUrl || page.url(),
      preferredCatalogRoots: uniqueRoots([fallback.contextUrl || page.url(), ...preferredCatalogRoots]),
    };
  } finally {
    await page.close();
  }
}

function buildCityStrategies(hostname) {
  const strategies = [];

  if (hostname === "superkoch.com.br") {
    strategies.push({
      id: "superkoch-store-selector",
      run: applySuperKochCitySelection,
    });
  }

  if (hostname === "redetoponline.com.br") {
    strategies.push({
      id: "redetop-store-selector",
      run: applyRedeTopCitySelection,
    });
  }

  strategies.push(
    {
      id: "generic-city-directory",
      run: applyGenericCityDirectorySelection,
    },
    {
      id: "generic-city-trigger",
      run: applyGenericCityTriggerSelection,
    },
  );

  return strategies;
}

async function applySuperKochCitySelection(page, { sourceUrl, requestedCity, onLog }) {
  const initialStoreLabel = await readSuperKochStoreLabel(page);

  if (isCityEligible({ requestedCity, effectiveCity: extractSuperKochCity(initialStoreLabel) })) {
    return finalizeCityResult({
      strategy: "superkoch-store-selector",
      requestedCity,
      storeLabel: initialStoreLabel,
      effectiveCity: extractSuperKochCity(initialStoreLabel),
      note: null,
    });
  }

  const cityPattern = new RegExp(`Superkoch\\s+LJ\\d+\\s+-\\s+${escapeRegex(requestedCity)}`, "i");

  if (!(await page.locator("#store-btn").isVisible().catch(() => false))) {
    return finalizeCityResult({
      strategy: "superkoch-store-selector",
      requestedCity,
      storeLabel: initialStoreLabel,
      effectiveCity: extractSuperKochCity(initialStoreLabel),
      note: `Seletor #store-btn nao encontrado no SuperKoch para ${requestedCity}.`,
    });
  }

  await page.locator("#store-btn").click({ timeout: 8_000 });
  await page.waitForTimeout(1_500);

  const option = page.getByText(cityPattern, { exact: false }).first();

  if (!(await option.isVisible().catch(() => false))) {
    return finalizeCityResult({
      strategy: "superkoch-store-selector",
      requestedCity,
      storeLabel: initialStoreLabel,
      effectiveCity: extractSuperKochCity(initialStoreLabel),
      note: `Cidade ${requestedCity} nao encontrada no seletor do SuperKoch.`,
    });
  }

  const optionText = await option.innerText().catch(() => null);
  await option.click({ timeout: 8_000 });
  await page.waitForTimeout(1_000);

  const confirmButton = page.getByRole("button", { name: /confirmar/i }).last();

  if (await confirmButton.isVisible().catch(() => false)) {
    await confirmButton.click({ timeout: 8_000 });
  }

  await settle(page);
  const storeLabel = await readSuperKochStoreLabel(page);
  const effectiveCity = extractSuperKochCity(storeLabel || optionText);

  log(onLog, "info", "Selecao especifica de cidade do SuperKoch executada.", {
    sourceUrl,
    requestedCity,
    optionText,
    storeLabel,
    effectiveCity,
  });

  return finalizeCityResult({
    strategy: "superkoch-store-selector",
    requestedCity,
    storeLabel: storeLabel || optionText,
    effectiveCity,
    contextUrl: page.url(),
    note: null,
  });
}

async function applyRedeTopCitySelection(page, { sourceUrl, requestedCity, onLog }) {
  const toggleButton = page
    .locator("button.vip-button")
    .filter({ hasText: /Retirar na loja:/i })
    .first();

  if (!(await toggleButton.isVisible().catch(() => false))) {
    return finalizeCityResult({
      strategy: "redetop-store-selector",
      requestedCity,
      storeLabel: null,
      effectiveCity: null,
      note: `Seletor de loja do Rede Top nao encontrado para ${requestedCity}.`,
    });
  }

  await toggleButton.click({ timeout: 8_000 });
  await page.waitForTimeout(1_500);

  const preferredTile = page
    .locator(".vip-selectable-tile")
    .filter({ hasText: new RegExp(`Rede Top\\s+-\\s*${escapeRegex(requestedCity)}\\b`, "i") })
    .first();
  const fallbackTile = page
    .locator(".vip-selectable-tile")
    .filter({ hasText: new RegExp(escapeRegex(requestedCity), "i") })
    .first();
  const tile = (await preferredTile.isVisible().catch(() => false)) ? preferredTile : fallbackTile;

  if (!(await tile.isVisible().catch(() => false))) {
    return finalizeCityResult({
      strategy: "redetop-store-selector",
      requestedCity,
      storeLabel: null,
      effectiveCity: null,
      note: `Cidade ${requestedCity} nao encontrada no seletor do Rede Top.`,
    });
  }

  const tileText = await tile.innerText().catch(() => null);
  await tile.click({ timeout: 8_000 });
  await page.waitForTimeout(1_500);

  const confirmButton = page.getByRole("button", { name: /continuar e fechar/i }).first();

  if (await confirmButton.isVisible().catch(() => false)) {
    await confirmButton.click({ timeout: 8_000 }).catch(() => {});
  }

  await settle(page);
  const storeLabel = extractFirstNonEmptyLine(tileText) || `Rede Top - ${requestedCity}`;

  log(onLog, "info", "Selecao especifica de cidade do Rede Top executada.", {
    sourceUrl,
    requestedCity,
    tileText,
    storeLabel,
  });

  return finalizeCityResult({
    strategy: "redetop-store-selector",
    requestedCity,
    storeLabel,
    effectiveCity: requestedCity,
    contextUrl: page.url(),
    note: null,
  });
}

async function applyGenericCityDirectorySelection(page, { sourceUrl, requestedCity, onLog }) {
  const citySlug = slugifyText(requestedCity);
  const candidate = await page.evaluate(
    ({ requestedCity, citySlug }) => {
      const currentOrigin = window.location.origin;
      const norm = normalizeText(requestedCity);
      const anchors = Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => ({
          text: cleanText(anchor.textContent),
          href: anchor.href,
        }))
        .filter((entry) => entry.href && entry.href.startsWith(currentOrigin))
        .map((entry) => ({
          ...entry,
          score: scoreAnchor(entry, norm, citySlug),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score);

      return anchors[0] || null;

      function scoreAnchor(entry, normalizedCity, slug) {
        const text = normalizeText(entry.text);
        const href = normalizeText(entry.href);
        let score = 0;

        if (!text && !href) {
          return 0;
        }

        if (text === normalizedCity) {
          score += 180;
        }

        if (text.includes(normalizedCity)) {
          score += 80;
        }

        if (href.includes(`/${slug}`) || href.includes(`=${slug}`)) {
          score += 140;
        }

        if (/cidade|loja|ofertas|encarte|regional|unidade/.test(href)) {
          score += 35;
        }

        if (/cidade|loja|unidade|retirar/.test(text)) {
          score += 25;
        }

        if (text.length > 0 && text.length <= 60) {
          score += 10;
        }

        return score;
      }

      function cleanText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      function normalizeText(value) {
        return cleanText(value)
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase();
      }
    },
    { requestedCity, citySlug },
  );

  if (!candidate?.href) {
    return finalizeCityResult({
      strategy: "generic-city-directory",
      requestedCity,
      storeLabel: null,
      effectiveCity: null,
      note: `Nenhum link direto de cidade foi encontrado para ${requestedCity}.`,
    });
  }

  await page.goto(candidate.href, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await settle(page);

  const inferredLabel = await inferCommonLocationLabel(page);
  const storeLabel = candidate.text || inferredLabel;
  const effectiveCity = inferCityFromLabel(inferredLabel || candidate.text) || requestedCity;

  log(onLog, "info", "Link direto de cidade identificado pela heuristica generica.", {
    sourceUrl,
    requestedCity,
    selectedUrl: candidate.href,
    selectedText: candidate.text,
    inferredLabel,
    effectiveCity,
  });

  return finalizeCityResult({
    strategy: "generic-city-directory",
    requestedCity,
    storeLabel,
    effectiveCity,
    contextUrl: page.url(),
    note: null,
  });
}

async function applyGenericCityTriggerSelection(page, { sourceUrl, requestedCity, onLog }) {
  const triggerCandidates = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll(
        'button, a[href], [role="button"], summary, label, div[tabindex], span[tabindex], select',
      ),
    );

    return nodes
      .map((node) => ({
        text: cleanText(node.textContent),
        tag: node.tagName.toLowerCase(),
        score: scoreTrigger(node),
      }))
      .filter((entry) => entry.text && entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 12);

    function scoreTrigger(node) {
      const text = cleanText(node.textContent).toLowerCase();
      let score = 0;

      if (/cidade|loja|retirar|unidade|alterar loja|trocar loja|selecione sua cidade|onde voce esta|entrega/.test(text)) {
        score += 80;
      }

      if (/retirar na loja|loja de|selecionar cidade|alterar cidade/.test(text)) {
        score += 80;
      }

      if (node.tagName.toLowerCase() === "select") {
        score += 50;
      }

      if (text.length > 0 && text.length <= 120) {
        score += 15;
      }

      if (/institucional|blog|contato|login|cadastre|fornecedor|trabalhe/.test(text)) {
        score -= 120;
      }

      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();

      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
        score = 0;
      }

      return score;
    }

    function cleanText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
  });

  log(onLog, triggerCandidates.length > 0 ? "info" : "warn", "Candidatos de seletor de cidade identificados pela heuristica generica.", {
    sourceUrl,
    requestedCity,
    triggers: triggerCandidates.map((entry) => entry.text),
  });

  if (triggerCandidates.length === 0) {
    return finalizeCityResult({
      strategy: "generic-city-trigger",
      requestedCity,
      storeLabel: null,
      effectiveCity: null,
      note: `Nenhum gatilho de cidade/loja foi encontrado para ${requestedCity}.`,
    });
  }

  for (const trigger of triggerCandidates) {
    const opened = await clickVisibleText(page, trigger.text);

    if (!opened) {
      continue;
    }

    await page.waitForTimeout(1_000);

    const selectedOption =
      (await tryGenericSelectElement(page, requestedCity)) ||
      (await tryGenericClickOption(page, requestedCity));

    if (!selectedOption) {
      await page.keyboard.press("Escape").catch(() => {});
      continue;
    }

    await page.waitForTimeout(800);
    await clickGenericConfirm(page);
    await settle(page);

    const inferredLabel =
      (await inferCommonLocationLabel(page)) ||
      selectedOption.label ||
      trigger.text;
    const effectiveCity = inferCityFromLabel(inferredLabel) || requestedCity;

    log(onLog, "info", "Cidade escolhida com heuristica generica.", {
      sourceUrl,
      requestedCity,
      trigger: trigger.text,
      option: selectedOption,
      inferredLabel,
      effectiveCity,
    });

    return finalizeCityResult({
      strategy: "generic-city-trigger",
      requestedCity,
      storeLabel: inferredLabel,
      effectiveCity,
      contextUrl: page.url(),
      note: null,
    });
  }

  return finalizeCityResult({
    strategy: "generic-city-trigger",
    requestedCity,
    storeLabel: null,
    effectiveCity: null,
    note: `A heuristica generica nao encontrou uma opcao clicavel para ${requestedCity}.`,
  });
}

async function tryGenericSelectElement(page, requestedCity) {
  return page.evaluate((city) => {
    const normalizedCity = normalizeText(city);
    const selects = Array.from(document.querySelectorAll("select"));

    for (const select of selects) {
      const style = window.getComputedStyle(select);

      if (style.display === "none" || style.visibility === "hidden") {
        continue;
      }

      const option = Array.from(select.options).find((entry) =>
        normalizeText(entry.textContent || entry.label || "").includes(normalizedCity),
      );

      if (!option) {
        continue;
      }

      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));

      return {
        type: "select",
        label: cleanText(option.textContent || option.label || city),
        value: option.value,
      };
    }

    return null;

    function cleanText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function normalizeText(value) {
      return cleanText(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    }
  }, requestedCity);
}

async function tryGenericClickOption(page, requestedCity) {
  return page.evaluate((city) => {
    const normalizedCity = normalizeText(city);
    const nodes = Array.from(
      document.querySelectorAll(
        'a[href], button, [role="button"], [role="option"], li, label, div, span',
      ),
    );

    const candidates = nodes
      .map((node) => ({
        node,
        text: cleanText(node.textContent),
        score: scoreNode(node),
      }))
      .filter((entry) => entry.text && entry.score > 0)
      .sort((left, right) => right.score - left.score);

    const best = candidates[0];

    if (!best) {
      return null;
    }

    best.node.click();

    return {
      type: "click",
      label: best.text,
    };

    function scoreNode(node) {
      const text = cleanText(node.textContent);
      const normalizedText = normalizeText(text);
      let score = 0;

      if (!normalizedText.includes(normalizedCity)) {
        return 0;
      }

      if (normalizedText === normalizedCity) {
        score += 200;
      }

      if (/cidade|loja|unidade|filial|retirar/.test(normalizedText)) {
        score += 50;
      }

      if (text.length > 0 && text.length <= 120) {
        score += 20;
      }

      const style = window.getComputedStyle(node);

      if (style.display === "none" || style.visibility === "hidden") {
        score = 0;
      }

      return score;
    }

    function cleanText(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function normalizeText(value) {
      return cleanText(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    }
  }, requestedCity);
}

async function clickGenericConfirm(page) {
  return page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('button, a[href], [role="button"], input[type="button"], input[type="submit"]'),
    );

    const best = nodes
      .map((node) => ({
        node,
        text: String(node.textContent || node.value || "")
          .replace(/\s+/g, " ")
          .trim(),
      }))
      .filter((entry) => /(confirmar|continuar|aplicar|salvar|fechar|ok|escolher|selecionar|alterar|prosseguir)/i.test(entry.text))
      .sort((left, right) => left.text.length - right.text.length)[0];

    if (!best) {
      return false;
    }

    best.node.click();
    return true;
  });
}

async function clickVisibleText(page, text) {
  if (!text) {
    return false;
  }

  return page.evaluate((targetText) => {
    const normalizedTarget = normalizeText(targetText);
    const nodes = Array.from(
      document.querySelectorAll('button, a[href], [role="button"], summary, label, div[tabindex], span[tabindex], select'),
    );

    const best = nodes.find((node) => isVisible(node) && normalizeText(node.textContent) === normalizedTarget)
      || nodes.find((node) => isVisible(node) && normalizeText(node.textContent).includes(normalizedTarget));

    if (!best) {
      return false;
    }

    best.click();
    return true;

    function normalizeText(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    }

    function isVisible(node) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }
  }, text);
}

async function inferCommonLocationLabel(page) {
  const directReaders = [
    async () =>
      page
        .locator("#store-btn")
        .innerText()
        .then((value) => cleanText(value))
        .catch(() => null),
    async () =>
      page
        .locator("button.vip-button")
        .filter({ hasText: /Retirar na loja:/i })
        .first()
        .innerText()
        .then((value) => cleanText(value))
        .catch(() => null),
  ];

  for (const reader of directReaders) {
    const value = await reader();

    if (value) {
      return value;
    }
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const lines = String(bodyText || "")
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const directIndex = lines.findIndex((line) =>
    /(loja de|retirar na loja|cidade|entrega em|selecione sua cidade)/i.test(line),
  );

  if (directIndex >= 0) {
    return [lines[directIndex], lines[directIndex + 1]].filter(Boolean).join(" ");
  }

  return null;
}

function buildPreferredCatalogRoots(sourceUrl, hostname) {
  const origin = new URL(sourceUrl).origin;

  if (hostname === "superkoch.com.br") {
    return [`${origin}/categorias`, `${origin}/busca`];
  }

  if (hostname === "redetoponline.com.br") {
    return [`${origin}/departamentos`, `${origin}/busca`];
  }

  return [];
}

function chooseBestResult(current, candidate) {
  if (!candidate) {
    return current;
  }

  if (!current) {
    return candidate;
  }

  if (candidate.cityEligible && !current.cityEligible) {
    return candidate;
  }

  if (!candidate.cityEligible && current.cityEligible) {
    return current;
  }

  if (candidate.effectiveCity && !current.effectiveCity) {
    return candidate;
  }

  return current;
}

function finalizeCityResult({ strategy, requestedCity, storeLabel, effectiveCity, contextUrl, note }) {
  return {
    strategy,
    requestedCity,
    storeLabel: storeLabel || null,
    effectiveCity: effectiveCity ? toTitleCase(effectiveCity) : null,
    contextUrl: contextUrl || null,
    note: note || null,
    cityCoverage: determineCityCoverage({
      requestedCity,
      effectiveCity,
    }),
    cityEligible: isCityEligible({
      requestedCity,
      effectiveCity,
    }),
  };
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

async function readSuperKochStoreLabel(page) {
  const directLabel = await page
    .locator("#store-btn")
    .innerText()
    .then((value) => cleanText(value))
    .catch(() => null);

  if (directLabel) {
    return directLabel;
  }

  const body = await page.locator("body").innerText().catch(() => "");
  const match = body.match(/Loja de\s*([^\n]+)\s*Retirada/i);
  return match ? cleanText(match[1]) : null;
}

function extractSuperKochCity(storeLabel) {
  if (!storeLabel) {
    return null;
  }

  const match = cleanText(storeLabel).match(/-\s*([^(]+?)(?:\s*\(|$)/);
  return match ? toTitleCase(match[1].trim()) : null;
}

function inferCityFromLabel(label) {
  const cleaned = cleanText(label);

  if (!cleaned) {
    return null;
  }

  const knownPatterns = [
    /-\s*([^(,]+?)(?:\s*\(|,|$)/,
    /retirar na loja:\s*([^,]+?)(?:,|$)/i,
    /loja de\s*([^\n]+?)\s*(?:retirada|$)/i,
    /cidade[:\s]+([^\n]+?)$/i,
  ];

  for (const pattern of knownPatterns) {
    const match = cleaned.match(pattern);

    if (match?.[1]) {
      return toTitleCase(match[1].trim());
    }
  }

  return null;
}

async function settle(page) {
  await page.waitForTimeout(1_500);
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(800);
}

function extractFirstNonEmptyLine(value) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => cleanText(line))
    .find(Boolean) || null;
}

function slugifyText(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueRoots(values) {
  return Array.from(
    new Set(
      values
        .filter(Boolean)
        .map((value) => normalizeUrl(value)),
    ),
  );
}

function toTitleCase(value) {
  return cleanText(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeText(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function log(onLog, level, message, context = null) {
  if (typeof onLog !== "function") {
    return;
  }

  onLog({
    scope: "city-context",
    level,
    message,
    context,
    at: new Date().toISOString(),
  });
}

module.exports = {
  prepareCatalogSiteContext,
};
