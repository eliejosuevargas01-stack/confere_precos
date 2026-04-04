const fs = require("fs/promises");
const { readBoolean, resolveFromCwd, runScraper } = require("./lib/scraper-core");
const { writeScrapeOutputs } = require("./lib/output-utils");

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const config = await loadConfig(options.configPath);
    const runConfig = mergeConfig(config, options.overrides);
    const result = await runScraper(runConfig);
    const csvPath = runConfig.output?.csvPath
      ? resolveFromCwd(runConfig.output.csvPath)
      : null;

    if (options.stdoutOnly) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const saved = await writeScrapeOutputs({
      result,
      outputConfig: runConfig.output,
      defaultJsonPath: "output/result.json",
      cwd: process.cwd(),
    });

    console.log(`Resultado salvo em ${saved.jsonPath}`);

    if (csvPath && saved.csvPath) {
      console.log(`Planilha CSV salva em ${saved.csvPath}`);
    } else if (csvPath) {
      console.log("CSV não gerado: a extração não retornou itens em data.collection.items.");
    }

    if (result.artifacts.screenshotPath) {
      console.log(`Screenshot salvo em ${result.artifacts.screenshotPath}`);
    }

    if (result.artifacts.htmlPath) {
      console.log(`HTML renderizado salvo em ${result.artifacts.htmlPath}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const args = { configPath: null, overrides: {}, stdoutOnly: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--") && !args.configPath) {
      args.configPath = arg;
      continue;
    }

    if (arg === "--config") {
      args.configPath = argv[++index];
      continue;
    }

    if (arg === "--url") {
      args.overrides.url = argv[++index];
      continue;
    }

    if (arg === "--headless") {
      args.overrides.headless = readBoolean(argv[++index]);
      continue;
    }

    if (arg === "--stdout") {
      args.stdoutOnly = true;
      continue;
    }

    throw new Error(`Argumento não suportado: ${arg}`);
  }

  if (!args.configPath) {
    throw new Error(
      "Uso: npm run scrape -- <config.json> [--url URL] [--headless true|false] [--stdout]",
    );
  }

  return args;
}

async function loadConfig(configPath) {
  const absolutePath = resolveFromCwd(configPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  const config = JSON.parse(raw);
  config.__configPath = absolutePath;
  return config;
}

function mergeConfig(config, overrides) {
  return {
    ...config,
    ...overrides,
    output: {
      ...(config.output || {}),
    },
  };
}

main();
