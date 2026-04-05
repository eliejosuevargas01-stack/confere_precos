const { DEFAULT_OUTPUT_ROOT, exportRedeTopCatalog } = require("./lib/redetop-catalog");

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await exportRedeTopCatalog(options);

    console.log(`Catalogo do Rede Top exportado com sucesso.`);
    console.log(`Cidade solicitada: ${result.metadata.requestedCity || "padrao da loja"}`);
    console.log(`Cidade efetiva: ${result.metadata.effectiveCity || "nao identificada"}`);
    console.log(`Loja ativa: ${result.metadata.storeLabel || "nao identificada"}`);
    console.log(`Departamentos lidos: ${result.metadata.totalDepartments}`);
    console.log(`Produtos exportados: ${result.metadata.totalProducts}`);
    console.log(`JSON: ${result.paths.jsonPath}`);
    console.log(`CSV: ${result.paths.csvPath}`);
    console.log(`Resumo: ${result.paths.summaryPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    city: null,
    headless: true,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    maxDepartments: null,
    maxPagesPerDepartment: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--city") {
      options.city = argv[++index] || null;
      continue;
    }

    if (arg === "--output-root") {
      options.outputRoot = argv[++index] || DEFAULT_OUTPUT_ROOT;
      continue;
    }

    if (arg === "--max-departments") {
      options.maxDepartments = Number.parseInt(argv[++index], 10);
      continue;
    }

    if (arg === "--max-pages") {
      options.maxPagesPerDepartment = Number.parseInt(argv[++index], 10);
      continue;
    }

    if (arg === "--headful") {
      options.headless = false;
      continue;
    }

    throw new Error(`Argumento nao suportado: ${arg}`);
  }

  return options;
}

main();
