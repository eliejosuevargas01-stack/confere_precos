const { readBoolean } = require("./lib/scraper-core");
const {
  DEFAULT_LINKS_FILE,
  DEFAULT_PROFILE_ROOT,
  DEFAULT_QUERY,
  runAutoScraper,
} = require("./lib/auto-site-profiler");

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runAutoScraper(options);

    if (options.stdoutOnly) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    for (const run of result.runs) {
      console.log(`${run.domain}: ${run.productsFound} produtos via ${run.strategy}`);
      console.log(`Perfil: ${run.profilePath}`);
      console.log(`Saída: ${run.outputDir}`);

      if (run.csvPath) {
        console.log(`CSV: ${run.csvPath}`);
      }

      if (run.screenshotPath) {
        console.log(`Screenshot: ${run.screenshotPath}`);
      }

      if (run.htmlPath) {
        console.log(`HTML: ${run.htmlPath}`);
      }
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
    query: DEFAULT_QUERY,
    maxItems: 200,
    refreshProfile: false,
    outputRoot: "output/auto-runs",
    profileRoot: DEFAULT_PROFILE_ROOT,
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

    if (arg === "--query") {
      options.query = argv[++index];
      continue;
    }

    if (arg === "--max-items") {
      options.maxItems = Number.parseInt(argv[++index], 10);
      continue;
    }

    if (arg === "--refresh-profile") {
      options.refreshProfile = true;
      continue;
    }

    if (arg === "--output-root") {
      options.outputRoot = argv[++index];
      continue;
    }

    if (arg === "--profile-root") {
      options.profileRoot = argv[++index];
      continue;
    }

    if (arg === "--stdout") {
      options.stdoutOnly = true;
      continue;
    }

    throw new Error(`Argumento não suportado: ${arg}`);
  }

  return options;
}

main();
