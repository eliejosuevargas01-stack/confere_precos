const GENERIC_TOKENS = new Set([
  "a",
  "ao",
  "as",
  "c",
  "caixa",
  "capsulas",
  "com",
  "cx",
  "da",
  "de",
  "do",
  "dupla",
  "e",
  "embalagem",
  "em",
  "folha",
  "fragrancia",
  "fragrancias",
  "g",
  "gr",
  "grama",
  "gramas",
  "kg",
  "l",
  "lata",
  "leve",
  "linha",
  "litro",
  "litros",
  "m",
  "marca",
  "ml",
  "pack",
  "pacote",
  "pacotes",
  "pct",
  "pet",
  "plastica",
  "pote",
  "pague",
  "rolos",
  "sache",
  "saches",
  "sabor",
  "sabores",
  "sem",
  "tipo",
  "tripla",
  "un",
  "und",
]);

const AMBIGUOUS_PATTERN =
  /\b(ou|sabores?|fragr[aâ]ncias?|tamanhos?|cores?|sortid[ao]s?|variad[ao]s?|mix)\b|\/|leve\s+\d+\s+pague\s+\d+/i;
const SIZE_PATTERN = /(\d+(?:[.,]\d+)?)\s*(kg|g|mg|ml|l|m)\b/gi;
const COUNT_PATTERN = /(?:c\/?\s*)?(\d+)\s*(un|und|rolos|folhas|capsulas|saches?|pct)\b/gi;
const LEVE_PAGUE_PATTERN = /leve\s*(\d+)\s*pague\s*(\d+)/gi;

function buildExactComparisonView(result) {
  const groupsByKey = new Map();
  const diagnostics = {
    consideredOffers: 0,
    skippedAmbiguous: 0,
    skippedMissingPackage: 0,
    skippedWeakIdentity: 0,
  };

  for (const essential of result.essentials || []) {
    for (const siteResult of essential.results || []) {
      if (result.metadata?.requestedCity && !siteResult.cityEligible) {
        continue;
      }

      const pool =
        Array.isArray(siteResult.relevantMatches) && siteResult.relevantMatches.length > 0
          ? siteResult.relevantMatches
          : siteResult.topMatches || [];

      for (const match of pool) {
        diagnostics.consideredOffers += 1;

        const identity = buildExactIdentity(match.name, essential);

        if (identity.reason === "ambiguous") {
          diagnostics.skippedAmbiguous += 1;
          continue;
        }

        if (identity.reason === "missing-package") {
          diagnostics.skippedMissingPackage += 1;
          continue;
        }

        if (identity.reason === "weak-identity") {
          diagnostics.skippedWeakIdentity += 1;
          continue;
        }

        const groupKey = [
          essential.id,
          identity.packageKey,
          identity.productKey,
        ].join("|");
        const existingGroup =
          groupsByKey.get(groupKey) ||
          createGroupSeed({
            groupKey,
            essential,
            identity,
          });

        const offer = {
          siteDomain: siteResult.siteDomain,
          storeLabel: siteResult.storeLabel,
          effectiveCity: siteResult.effectiveCity,
          sourceUrl: siteResult.sourceUrl,
          price: match.price,
          priceValue: match.priceValue,
          originalPrice: match.originalPrice || null,
          originalPriceValue: match.originalPriceValue ?? null,
          isPromotion: Boolean(match.isPromotion),
          promotionLabel: match.promotionLabel || null,
          discountPercent: match.discountPercent ?? null,
          image: match.image || null,
          link: match.link || null,
          unit: match.unit || null,
          name: match.name,
          matchScore: match.matchScore ?? 0,
        };

        upsertGroupOffer(existingGroup, offer);
        groupsByKey.set(groupKey, existingGroup);
      }
    }
  }

  const groups = Array.from(groupsByKey.values())
    .map(finalizeGroup)
    .filter((group) => group.storeCount >= 2)
    .sort((left, right) => {
      if (right.storeCount !== left.storeCount) {
        return right.storeCount - left.storeCount;
      }

      if (left.lowestPriceValue !== right.lowestPriceValue) {
        return numericAsc(left.lowestPriceValue, right.lowestPriceValue);
      }

      return left.title.localeCompare(right.title, "pt-BR");
    });

  return {
    metadata: {
      comparedAt: result.metadata?.comparedAt || new Date().toISOString(),
      requestedCity: result.metadata?.requestedCity || null,
      totalSites: result.metadata?.totalSites || 0,
      totalGroups: groups.length,
      totalComparableSites: result.metadata?.totalComparableSites || 0,
    },
    siteStatus: result.siteStatus || [],
    diagnostics,
    groups,
  };
}

function buildCatalogComparisonView(result) {
  const groupsByKey = new Map();
  const diagnostics = {
    consideredOffers: 0,
    exactIdentityOffers: 0,
    fallbackOffers: 0,
    skippedInvalid: 0,
  };

  for (const essential of result.essentials || []) {
    for (const siteResult of essential.results || []) {
      if (result.metadata?.requestedCity && !siteResult.cityEligible) {
        continue;
      }

      const pool =
        Array.isArray(siteResult.relevantMatches) && siteResult.relevantMatches.length > 0
          ? siteResult.relevantMatches
          : siteResult.topMatches || [];

      for (const match of pool) {
        const offer = createOffer(siteResult, match);

        if (!offer.name || !Number.isFinite(offer.priceValue) || offer.priceValue <= 0) {
          diagnostics.skippedInvalid += 1;
          continue;
        }

        diagnostics.consideredOffers += 1;

        const identity = buildExactIdentity(match.name, essential);
        let groupKey = null;
        let group = null;

        if (!identity.reason) {
          diagnostics.exactIdentityOffers += 1;
          groupKey = [essential.id, identity.packageKey, identity.productKey].join("|");
          group =
            groupsByKey.get(groupKey) ||
            createCatalogGroupSeed({
              groupKey,
              essential,
              identity,
              comparisonMode: "exact",
            });
        } else {
          diagnostics.fallbackOffers += 1;
          const fallbackIdentity = buildFallbackIdentity({
            essential,
            siteResult,
            offer,
          });

          groupKey = fallbackIdentity.groupKey;
          group =
            groupsByKey.get(groupKey) ||
            createCatalogGroupSeed({
              groupKey,
              essential,
              identity: fallbackIdentity,
              comparisonMode: "single-store",
            });
        }

        upsertGroupOffer(group, offer);
        groupsByKey.set(groupKey, group);
      }
    }
  }

  const groups = Array.from(groupsByKey.values())
    .map(finalizeCatalogGroup)
    .sort((left, right) => {
      if (right.isComparable !== left.isComparable) {
        return Number(right.isComparable) - Number(left.isComparable);
      }

      if (right.storeCount !== left.storeCount) {
        return right.storeCount - left.storeCount;
      }

      if (left.lowestPriceValue !== right.lowestPriceValue) {
        return numericAsc(left.lowestPriceValue, right.lowestPriceValue);
      }

      return left.title.localeCompare(right.title, "pt-BR");
    });

  return {
    metadata: {
      comparedAt: result.metadata?.comparedAt || new Date().toISOString(),
      requestedCity: result.metadata?.requestedCity || null,
      totalSites: result.metadata?.totalSites || 0,
      totalGroups: groups.length,
      totalComparableSites: result.metadata?.totalComparableSites || 0,
      totalComparableGroups: groups.filter((group) => group.isComparable).length,
    },
    siteStatus: result.siteStatus || [],
    diagnostics,
    groups,
  };
}

function createGroupSeed({ groupKey, essential, identity }) {
  return {
    id: groupKey,
    exactKey: groupKey,
    essentialId: essential.id,
    essentialLabel: essential.label,
    packageKey: identity.packageKey,
    packageLabel: identity.packageLabel,
    productKey: identity.productKey,
    title: identity.title,
    referenceImage: null,
    offersBySite: new Map(),
  };
}

function createCatalogGroupSeed({ groupKey, essential, identity, comparisonMode }) {
  return {
    id: groupKey,
    exactKey: comparisonMode === "exact" ? groupKey : null,
    essentialId: essential.id,
    essentialLabel: essential.label,
    packageKey: identity.packageKey || null,
    packageLabel: identity.packageLabel || null,
    productKey: identity.productKey || null,
    title: identity.title,
    referenceImage: null,
    comparisonMode,
    offersBySite: new Map(),
  };
}

function upsertGroupOffer(group, offer) {
  const current = group.offersBySite.get(offer.siteDomain);

  if (!current || isBetterOffer(offer, current)) {
    group.offersBySite.set(offer.siteDomain, offer);
  }

  if (!group.referenceImage && offer.image) {
    group.referenceImage = offer.image;
  }
}

function finalizeGroup(group) {
  const offers = Array.from(group.offersBySite.values()).sort((left, right) => {
    if (left.priceValue !== right.priceValue) {
      return numericAsc(left.priceValue, right.priceValue);
    }

    return right.matchScore - left.matchScore;
  });
  const lowestPriceValue = offers[0]?.priceValue ?? null;

  return {
    id: group.id,
    exactKey: group.exactKey,
    essentialId: group.essentialId,
    essentialLabel: group.essentialLabel,
    title: group.title,
    packageLabel: group.packageLabel,
    referenceImage: group.referenceImage,
    storeCount: offers.length,
    lowestPriceValue,
    highestPriceValue: offers.at(-1)?.priceValue ?? null,
    offers: offers.map((offer) => ({
      ...offer,
      isCheapest: lowestPriceValue !== null && offer.priceValue === lowestPriceValue,
    })),
  };
}

function finalizeCatalogGroup(group) {
  const finalized = finalizeGroup(group);
  const isComparable = finalized.storeCount >= 2;

  return {
    ...finalized,
    comparisonMode: isComparable ? "exact" : "single-store",
    isComparable,
  };
}

function buildExactIdentity(name, essential) {
  const normalizedName = normalizeText(name);

  if (!normalizedName) {
    return { reason: "weak-identity" };
  }

  if (AMBIGUOUS_PATTERN.test(normalizedName)) {
    return { reason: "ambiguous" };
  }

  const packageMatches = extractPackageMatches(normalizedName);

  if (packageMatches.length === 0) {
    return { reason: "missing-package" };
  }

  const packageKey = packageMatches.join("|");
  const essentialTokens = new Set(tokenize(essential.searchTerm));
  const identityTokens = tokenize(normalizedName).filter((token) => {
    if (essentialTokens.has(token)) {
      return false;
    }

    if (GENERIC_TOKENS.has(token)) {
      return false;
    }

    if (/^\d+$/.test(token)) {
      return false;
    }

    return true;
  });
  const uniqueIdentityTokens = Array.from(new Set(identityTokens));

  if (uniqueIdentityTokens.length < 1) {
    return { reason: "weak-identity" };
  }

  return {
    reason: null,
    packageKey,
    packageLabel: packageMatches.join(" · "),
    productKey: uniqueIdentityTokens.sort().join("-"),
    title: prettifyName(name),
  };
}

function buildFallbackIdentity({ essential, siteResult, offer }) {
  const normalizedName = normalizeText(offer.name);
  const packageMatches = extractPackageMatches(normalizedName);
  const packageLabel = packageMatches.join(" · ") || prettifyPackageLabel(offer.unit);
  const packageKey = packageMatches.join("|") || normalizeText(offer.unit) || "unit-unknown";
  const productKey = [siteResult.siteDomain, normalizedName].join("|");

  return {
    reason: "fallback",
    packageKey,
    packageLabel,
    productKey,
    title: prettifyName(offer.name) || essential.label,
    groupKey: [essential.id, siteResult.siteDomain, normalizedName].join("|"),
  };
}

function extractPackageMatches(text) {
  const matches = [];

  for (const match of text.matchAll(SIZE_PATTERN)) {
    matches.push(`${normalizeNumber(match[1])}${normalizeUnit(match[2])}`);
  }

  for (const match of text.matchAll(COUNT_PATTERN)) {
    matches.push(`${normalizeNumber(match[1])}${normalizeUnit(match[2])}`);
  }

  for (const match of text.matchAll(LEVE_PAGUE_PATTERN)) {
    matches.push(`leve${normalizeNumber(match[1])}pague${normalizeNumber(match[2])}`);
  }

  return Array.from(new Set(matches)).sort((left, right) => left.localeCompare(right, "pt-BR"));
}

function normalizeNumber(value) {
  return String(value || "")
    .replace(",", ".")
    .replace(/\.0+$/, "")
    .replace(/[^\d.]+/g, "");
}

function normalizeUnit(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/und/g, "un")
    .replace(/saches?/g, "sache");
}

function prettifyName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function prettifyPackageLabel(value) {
  return prettifyName(String(value || "").replace(/[_-]+/g, " "));
}

function tokenize(value) {
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isBetterOffer(left, right) {
  if (left.priceValue !== right.priceValue) {
    return numericAsc(left.priceValue, right.priceValue) < 0;
  }

  return (left.matchScore || 0) > (right.matchScore || 0);
}

function createOffer(siteResult, match) {
  return {
    siteDomain: siteResult.siteDomain,
    storeLabel: siteResult.storeLabel,
    effectiveCity: siteResult.effectiveCity,
    sourceUrl: siteResult.sourceUrl,
    price: match.price,
    priceValue: match.priceValue,
    originalPrice: match.originalPrice || null,
    originalPriceValue: match.originalPriceValue ?? null,
    isPromotion: Boolean(match.isPromotion),
    promotionLabel: match.promotionLabel || null,
    discountPercent: match.discountPercent ?? null,
    image: match.image || null,
    link: match.link || null,
    unit: match.unit || null,
    name: match.name,
    matchScore: match.matchScore ?? 0,
  };
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
  buildCatalogComparisonView,
  buildExactComparisonView,
};
