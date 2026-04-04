const fs = require("fs/promises");
const path = require("path");
const { readBoolean, resolveFromCwd, runScraper } = require("./lib/scraper-core");

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const slug = slugify(options.url);
    const outputDir = resolveFromCwd(path.join("output", "probes", slug));

    const actions = [];

    if (options.selector) {
      actions.push({
        type: "waitForSelector",
        selector: options.selector,
        timeoutMs: options.selectorTimeoutMs,
      });
    }

    if (options.scrollToBottom) {
      actions.push({
        type: "scroll",
        to: "bottom",
        delayMs: options.scrollDelayMs,
      });
    }

    if (options.extraWaitMs) {
      actions.push({
        type: "wait",
        ms: options.extraWaitMs,
      });
    }

    const result = await runScraper({
      browser: "chromium",
      headless: options.headless,
      url: options.url,
      waitUntil: options.waitUntil,
      viewport: {
        width: options.width,
        height: options.height,
      },
      actions,
      extract: {
        pageText: true,
        fields: {
          title: { type: "pageTitle" },
          finalUrl: { type: "pageUrl" },
        },
      },
      output: {
        jsonPath: path.join(outputDir, "probe.json"),
        htmlPath: path.join(outputDir, "rendered.html"),
        screenshotPath: path.join(outputDir, "page.png"),
        fullPageScreenshot: true,
      },
    });

    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      path.join(outputDir, "probe.json"),
      JSON.stringify(result, null, 2),
      "utf8",
    );

    console.log(`Probe salvo em ${outputDir}`);
    console.log(`Título: ${result.metadata.title}`);
    console.log(`URL final: ${result.metadata.url}`);
    console.log(`Screenshot: ${result.artifacts.screenshotPath}`);
    console.log(`HTML renderizado: ${result.artifacts.htmlPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    url: null,
    selector: null,
    selectorTimeoutMs: 20_000,
    waitUntil: "domcontentloaded",
    headless: true,
    extraWaitMs: 2_000,
    scrollToBottom: false,
    scrollDelayMs: 1_500,
    width: 1440,
    height: 2200,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--url") {
      options.url = argv[++index];
      continue;
    }

    if (arg === "--selector") {
      options.selector = argv[++index];
      continue;
    }

    if (arg === "--selector-timeout") {
      options.selectorTimeoutMs = Number.parseInt(argv[++index], 10);
      continue;
    }

    if (arg === "--waitUntil") {
      options.waitUntil = argv[++index];
      continue;
    }

    if (arg === "--headless") {
      options.headless = readBoolean(argv[++index]);
      continue;
    }

    if (arg === "--waitMs") {
      options.extraWaitMs = Number.parseInt(argv[++index], 10);
      continue;
    }

    if (arg === "--scroll") {
      options.scrollToBottom = true;
      continue;
    }

    if (arg === "--scrollDelayMs") {
      options.scrollDelayMs = Number.parseInt(argv[++index], 10);
      continue;
    }

    if (arg === "--width") {
      options.width = Number.parseInt(argv[++index], 10);
      continue;
    }

    if (arg === "--height") {
      options.height = Number.parseInt(argv[++index], 10);
      continue;
    }

    throw new Error(`Argumento não suportado: ${arg}`);
  }

  if (!options.url) {
    throw new Error(
      "Uso: npm run probe -- --url URL [--selector CSS] [--waitMs 2000] [--scroll] [--headless true|false]",
    );
  }

  return options;
}

function slugify(url) {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80);
}

main();
