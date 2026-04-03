const { runPriceComparator } = require("./price-comparator");

async function runCategoryComparisonTask(payload) {
  if (!payload || !Array.isArray(payload.productIds) || payload.productIds.length === 0) {
    throw new Error("Categoria invalida para o worker de storefront.");
  }

  const comparison = await runWithRetry(async () =>
    runPriceComparator({
      inputFile: payload.inputFile || "links.txt",
      headless: true,
      city: payload.city || null,
      maxItemsPerQuery: payload.maxItemsPerQuery || 80,
      products: payload.productIds,
      stdoutOnly: true,
    }),
    payload.startDelayMs || 0,
  );

  return {
    categoryId: payload.categoryId || null,
    categoryLabel: payload.categoryLabel || null,
    comparison,
  };
}

async function runWithRetry(task, delayBeforeStartMs = 0, attempts = 2) {
  let lastError = null;

  if (Number.isFinite(delayBeforeStartMs) && delayBeforeStartMs > 0) {
    await delay(delayBeforeStartMs);
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;

      if (attempt < attempts) {
        await delay(1_500 * attempt);
      }
    }
  }

  throw lastError;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (typeof process.send !== "function") {
    const payload = parseCliPayload(process.argv.slice(2));
    const result = await runCategoryComparisonTask(payload);
    process.stdout.write(JSON.stringify(result, null, 2));
    return;
  }

  await new Promise((resolve) => {
    process.once("message", async (payload) => {
      try {
        const result = await runCategoryComparisonTask(payload);
        await sendMessage({
          ok: true,
          result,
        });
      } catch (error) {
        await sendMessage({
          ok: false,
          error: {
            message: error.message,
            stack: error.stack || null,
          },
        });
        process.exitCode = 1;
      } finally {
        resolve();
        setTimeout(() => {
          process.exit(process.exitCode || 0);
        }, 0);
      }
    });
  });
}

function sendMessage(payload) {
  return new Promise((resolve) => {
    process.send(payload, () => resolve());
  });
}

function parseCliPayload(argv) {
  const payload = {
    categoryId: null,
    categoryLabel: null,
    productIds: [],
    city: null,
    inputFile: "links.txt",
    maxItemsPerQuery: 80,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--category-id") {
      payload.categoryId = argv[++index];
      continue;
    }

    if (arg === "--category-label") {
      payload.categoryLabel = argv[++index];
      continue;
    }

    if (arg === "--city") {
      payload.city = argv[++index];
      continue;
    }

    if (arg === "--file") {
      payload.inputFile = argv[++index];
      continue;
    }

    if (arg === "--max-items") {
      payload.maxItemsPerQuery = Number.parseInt(argv[++index], 10);
      continue;
    }

    if (arg === "--products") {
      payload.productIds = argv[++index]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }

    throw new Error(`Argumento nao suportado: ${arg}`);
  }

  return payload;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  runCategoryComparisonTask,
};
