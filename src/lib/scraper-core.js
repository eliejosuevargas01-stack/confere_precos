const fs = require("fs/promises");
const path = require("path");
const { chromium, firefox, webkit } = require("playwright");

const SUPPORTED_BROWSERS = { chromium, firefox, webkit };

async function runScraper(config) {
  validateConfig(config);

  const browserType = SUPPORTED_BROWSERS[config.browser || "chromium"];
  const browser = await browserType.launch({
    headless: config.headless ?? true,
    slowMo: config.slowMoMs ?? 0,
  });

  const context = await browser.newContext({
    viewport: config.viewport || { width: 1440, height: 2200 },
    userAgent: config.userAgent,
    locale: config.locale || "pt-BR",
    timezoneId: config.timezoneId,
  });

  const page = await context.newPage();
  page.setDefaultTimeout(config.defaultTimeoutMs ?? 30_000);
  page.setDefaultNavigationTimeout(config.navigationTimeoutMs ?? 45_000);

  try {
    const navigation = await gotoWithFallback(page, config);

    if (config.extraWaitMs) {
      await page.waitForTimeout(config.extraWaitMs);
    }

    await runActions(page, config.actions || []);
    const extracted = await extractData(page, config.extract || {});
    const artifacts = await saveArtifacts(page, config);

    return {
      metadata: {
        url: page.url(),
        title: await page.title(),
        scrapedAt: new Date().toISOString(),
        navigation,
      },
      data: extracted,
      artifacts,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function gotoWithFallback(page, config) {
  const primaryWaitUntil = config.waitUntil || "domcontentloaded";
  const timeout = config.navigationTimeoutMs ?? 45_000;
  const fallbackWaitUntil = config.gotoFallbackWaitUntil || "domcontentloaded";

  try {
    await page.goto(config.url, {
      waitUntil: primaryWaitUntil,
      timeout,
    });

    return {
      usedWaitUntil: primaryWaitUntil,
      fallbackUsed: false,
    };
  } catch (error) {
    const shouldRetry =
      error?.name === "TimeoutError" &&
      primaryWaitUntil !== fallbackWaitUntil &&
      config.retryOnGotoTimeout !== false;

    if (!shouldRetry) {
      throw error;
    }

    await page.goto(config.url, {
      waitUntil: fallbackWaitUntil,
      timeout,
    });

    return {
      usedWaitUntil: fallbackWaitUntil,
      fallbackUsed: true,
      originalWaitUntil: primaryWaitUntil,
    };
  }
}

function validateConfig(config) {
  if (!config.url) {
    throw new Error("A configuração precisa conter 'url'.");
  }

  if (config.browser && !SUPPORTED_BROWSERS[config.browser]) {
    throw new Error(
      `Browser inválido: ${config.browser}. Use chromium, firefox ou webkit.`,
    );
  }
}

async function runActions(page, actions) {
  for (const action of actions) {
    switch (action.type) {
      case "wait":
        await page.waitForTimeout(action.ms ?? 1000);
        break;
      case "waitForSelector":
        await page.waitForSelector(action.selector, {
          state: action.state || "visible",
          timeout: action.timeoutMs,
        });
        break;
      case "click":
        await page.locator(action.selector).click({
          button: action.button || "left",
          clickCount: action.clickCount || 1,
          delay: action.delayMs,
          timeout: action.timeoutMs,
        });
        if (action.postDelayMs) {
          await page.waitForTimeout(action.postDelayMs);
        }
        break;
      case "fill":
        await page.locator(action.selector).fill(action.value ?? "", {
          timeout: action.timeoutMs,
        });
        if (action.postDelayMs) {
          await page.waitForTimeout(action.postDelayMs);
        }
        break;
      case "type":
        await page.locator(action.selector).pressSequentially(action.value ?? "", {
          delay: action.delayMs ?? 80,
          timeout: action.timeoutMs,
        });
        if (action.postDelayMs) {
          await page.waitForTimeout(action.postDelayMs);
        }
        break;
      case "press":
        await page.locator(action.selector).press(action.key, {
          delay: action.delayMs,
          timeout: action.timeoutMs,
        });
        if (action.postDelayMs) {
          await page.waitForTimeout(action.postDelayMs);
        }
        break;
      case "hover":
        await page.locator(action.selector).hover({ timeout: action.timeoutMs });
        if (action.postDelayMs) {
          await page.waitForTimeout(action.postDelayMs);
        }
        break;
      case "scroll":
        await performScroll(page, action);
        break;
      default:
        throw new Error(`Ação não suportada: ${action.type}`);
    }
  }
}

async function performScroll(page, action) {
  if (action.to === "bottom") {
    await page.evaluate(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    });
    await page.waitForTimeout(action.delayMs ?? 1500);
    return;
  }

  const times = action.times ?? 1;
  const pixels = action.pixels ?? 1000;
  const delayMs = action.delayMs ?? 1000;

  for (let index = 0; index < times; index += 1) {
    await page.mouse.wheel(0, pixels);
    await page.waitForTimeout(delayMs);
  }
}

async function extractData(page, extractConfig) {
  const output = {};

  if (extractConfig.pageText) {
    output.pageText = await page.locator("body").innerText();
  }

  if (extractConfig.pageHtml) {
    output.pageHtml = await page.content();
  }

  if (extractConfig.fields) {
    output.fields = await extractFields(page, page.locator("html"), extractConfig.fields);
  }

  if (extractConfig.collection) {
    output.collection = await extractCollection(page, extractConfig.collection);
  }

  return output;
}

async function extractCollection(page, config) {
  const locator = page.locator(config.selector);
  const total = await locator.count();
  const limit = config.limit ? Math.min(total, config.limit) : total;
  const items = [];

  for (let index = 0; index < limit; index += 1) {
    const itemLocator = locator.nth(index);
    const fields = await extractFields(page, itemLocator, config.fields || {});
    items.push(fields);
  }

  return {
    selector: config.selector,
    total,
    returned: items.length,
    items,
  };
}

async function extractFields(page, rootLocator, fieldsConfig) {
  const entries = await Promise.all(
    Object.entries(fieldsConfig).map(async ([fieldName, fieldConfig]) => [
      fieldName,
      await extractField(page, rootLocator, fieldConfig),
    ]),
  );

  return Object.fromEntries(entries);
}

async function extractField(page, rootLocator, fieldConfig) {
  const target = fieldConfig.selector
    ? rootLocator.locator(fieldConfig.selector)
    : rootLocator;

  switch (fieldConfig.type || "text") {
    case "text":
      return readLocator(target, fieldConfig.multiple, (locator) => locator.innerText());
    case "html":
      return readLocator(target, fieldConfig.multiple, (locator) => locator.innerHTML());
    case "href":
      return readLocator(target, fieldConfig.multiple, (locator) =>
        locator.getAttribute("href"),
      );
    case "src":
      return readLocator(target, fieldConfig.multiple, (locator) =>
        locator.getAttribute("src"),
      );
    case "attribute":
      if (!fieldConfig.attribute) {
        throw new Error("Campo do tipo 'attribute' precisa de 'attribute'.");
      }
      return readLocator(target, fieldConfig.multiple, (locator) =>
        locator.getAttribute(fieldConfig.attribute),
      );
    case "exists":
      return (await target.count()) > 0;
    case "pageTitle":
      return page.title();
    case "pageUrl":
      return page.url();
    default:
      throw new Error(`Tipo de extração não suportado: ${fieldConfig.type}`);
  }
}

async function readLocator(locator, multiple, reader) {
  if (multiple) {
    const count = await locator.count();
    const values = [];

    for (let index = 0; index < count; index += 1) {
      values.push(await reader(locator.nth(index)));
    }

    return values;
  }

  const count = await locator.count();
  if (count === 0) {
    return null;
  }

  return reader(locator.first());
}

async function saveArtifacts(page, config) {
  const artifacts = { screenshotPath: null, htmlPath: null };
  const outputConfig = config.output || {};

  if (outputConfig.screenshotPath) {
    const screenshotPath = resolveFromCwd(outputConfig.screenshotPath);
    await ensureDir(path.dirname(screenshotPath));
    await page.screenshot({
      path: screenshotPath,
      fullPage: outputConfig.fullPageScreenshot ?? true,
    });
    artifacts.screenshotPath = screenshotPath;
  }

  if (outputConfig.htmlPath) {
    const htmlPath = resolveFromCwd(outputConfig.htmlPath);
    await ensureDir(path.dirname(htmlPath));
    await fs.writeFile(htmlPath, await page.content(), "utf8");
    artifacts.htmlPath = htmlPath;
  }

  return artifacts;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function resolveFromCwd(targetPath) {
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(process.cwd(), targetPath);
}

function readBoolean(value) {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`Valor booleano inválido: ${value}`);
}

module.exports = {
  readBoolean,
  resolveFromCwd,
  runScraper,
};
