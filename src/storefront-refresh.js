const {
  DEFAULT_CITY,
  DEFAULT_INPUT_FILE,
  DEFAULT_MAX_ITEMS_PER_QUERY,
  DEFAULT_REFRESH_INTERVAL_MINUTES,
  DEFAULT_SNAPSHOT_ROOT,
  generateStorefrontFiles,
} = require("./lib/storefront-service");

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await generateStorefrontFiles(options);

    if (options.stdoutOnly) {
      console.log(JSON.stringify(result.snapshot, null, 2));
      return;
    }

    console.log(`Snapshot gerado para ${result.snapshot.metadata.requestedCity || options.city}.`);
    console.log(`Produtos no catalogo: ${result.snapshot.metadata.totalCatalogGroups}`);
    console.log(`Produtos comparados de forma exata: ${result.snapshot.metadata.totalExactGroups}`);
    console.log(`Categorias ativas: ${result.snapshot.metadata.totalCategories}`);
    console.log(`Snapshot: ${result.paths.latestSnapshotPath}`);
    console.log(`Comparacao bruta: ${result.paths.latestComparisonPath}`);
    console.log(`Visao exata: ${result.paths.latestExactPath}`);
    console.log(`Catalogo completo: ${result.paths.latestCatalogPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    city: DEFAULT_CITY,
    inputFile: DEFAULT_INPUT_FILE,
    snapshotRoot: DEFAULT_SNAPSHOT_ROOT,
    intervalMinutes: DEFAULT_REFRESH_INTERVAL_MINUTES,
    maxItemsPerQuery: DEFAULT_MAX_ITEMS_PER_QUERY,
    categoryWorkers: null,
    stdoutOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--city") {
      options.city = argv[++index];
      continue;
    }

    if (arg === "--file") {
      options.inputFile = argv[++index];
      continue;
    }

    if (arg === "--snapshot-root") {
      options.snapshotRoot = argv[++index];
      continue;
    }

    if (arg === "--interval") {
      options.intervalMinutes = Number.parseInt(argv[++index], 10);
      continue;
    }

    if (arg === "--max-items") {
      options.maxItemsPerQuery = Number.parseInt(argv[++index], 10);
      continue;
    }

    if (arg === "--workers") {
      options.categoryWorkers = Number.parseInt(argv[++index], 10);
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
