const { readBoolean } = require("./lib/scraper-core");
const { DEFAULT_LINKS_FILE } = require("./lib/auto-site-profiler");
const {
  DEFAULT_OUTPUT_ROOT,
  runPriceComparator,
} = require("./lib/price-comparator");

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runPriceComparator(options);

    if (options.stdoutOnly) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(
      `Comparativo gerado para ${result.metadata.totalSites} site(s) e ${result.metadata.totalProducts} produto(s).`,
    );

    if (result.metadata.requestedCity) {
      console.log(`Cidade solicitada: ${result.metadata.requestedCity}`);
    }

    for (const site of result.sites) {
      console.log(
        `${new URL(site.sourceUrl).hostname.replace(/^www\./, "")}: ${site.searchSupported ? "comparavel" : "sem comparacao estruturada"} (${site.cityCoverage})`,
      );

      if (site.storeLabel) {
        console.log(`Loja: ${site.storeLabel}`);
      }

      if (site.note) {
        console.log(`Obs: ${site.note}`);
      }
    }

    if (result.artifacts) {
      console.log(`Saida: ${result.artifacts.outputDir}`);
      console.log(`JSON: ${result.artifacts.jsonPath}`);
      console.log(`Comparacoes CSV: ${result.artifacts.rowsCsvPath}`);
      console.log(`Melhores ofertas CSV: ${result.artifacts.bestOffersCsvPath}`);
      console.log(`Status dos sites CSV: ${result.artifacts.siteStatusCsvPath}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    urls: [],
    inputFile: DEFAULT_LINKS_FILE,
    headless: true,
    city: null,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    maxItemsPerQuery: 80,
    products: null,
    stdoutOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      options.urls.push(arg);
      continue;
    }

    if (arg === "--file") {
      options.inputFile = argv[++index];
      continue;
    }

    if (arg === "--headless") {
      options.headless = readBoolean(argv[++index]);
      continue;
    }

    if (arg === "--city") {
      options.city = argv[++index];
      continue;
    }

    if (arg === "--output-root") {
      options.outputRoot = argv[++index];
      continue;
    }

    if (arg === "--max-items") {
      options.maxItemsPerQuery = Number.parseInt(argv[++index], 10);
      continue;
    }

    if (arg === "--products") {
      options.products = argv[++index]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }

    if (arg === "--stdout") {
      options.stdoutOnly = true;
      continue;
    }

    throw new Error(`Argumento nao suportado: ${arg}`);
  }

  return options;
}

main();
