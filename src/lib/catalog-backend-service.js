const fs = require("fs/promises");
const path = require("path");
const {
  DEFAULT_MAX_ITEMS_PER_PAGE,
  DEFAULT_MAX_PAGES_PER_SECTION,
  DEFAULT_MAX_SECTIONS,
  DEFAULT_WORKER_COUNT,
  DEFAULT_OUTPUT_ROOT,
  scrapeIntelligentCatalog,
} = require("./intelligent-catalog-scraper");
const { ensureDir, slugify, toCsv } = require("./output-utils");
const { normalizeUrl } = require("./auto-site-profiler");
const { resolveFromCwd } = require("./scraper-core");

const DEFAULT_DATA_ROOT = "data/catalog-api";
const DEFAULT_SCHEDULE_MINUTES = 360;
const DEFAULT_TICK_MS = 60_000;
const DEFAULT_BATCH_LIMIT = 50;
const DEFAULT_PRODUCTS_WEBHOOK_BATCH_SIZE = 10;

function createCatalogBackendService(options = {}) {
  const dataRoot = resolveFromCwd(options.dataRoot || DEFAULT_DATA_ROOT);
  const sourcesPath = path.join(dataRoot, "sources.json");
  const jobsDir = path.join(dataRoot, "jobs");
  const logsDir = path.join(dataRoot, "logs");
  const jobsIndexPath = path.join(dataRoot, "jobs-index.json");
  const catalogsRoot = path.join(dataRoot, "catalogs");
  const batchesDir = path.join(dataRoot, "batches");
  const batchRunsRoot = path.join(dataRoot, "batch-runs");
  const batchesIndexPath = path.join(dataRoot, "batches-index.json");
  const webhookUrl =
    options.webhookUrl ||
    process.env.CATALOG_API_WEBHOOK_URL ||
    process.env.BACKEND_WEBHOOK_URL ||
    null;
  const webhookToken =
    options.webhookToken ||
    process.env.CATALOG_API_WEBHOOK_TOKEN ||
    process.env.BACKEND_WEBHOOK_TOKEN ||
    null;
  const productsWebhookUrl =
    options.productsWebhookUrl ||
    process.env.CATALOG_API_PRODUCTS_WEBHOOK_URL ||
    process.env.BACKEND_PRODUCTS_WEBHOOK_URL ||
    null;
  const productsWebhookToken =
    options.productsWebhookToken ||
    process.env.CATALOG_API_PRODUCTS_WEBHOOK_TOKEN ||
    process.env.BACKEND_PRODUCTS_WEBHOOK_TOKEN ||
    null;
  const productsWebhookBatchSize = sanitizePositiveInteger(
    options.productsWebhookBatchSize ||
      process.env.CATALOG_API_PRODUCTS_WEBHOOK_BATCH_SIZE ||
      process.env.BACKEND_PRODUCTS_WEBHOOK_BATCH_SIZE,
    DEFAULT_PRODUCTS_WEBHOOK_BATCH_SIZE,
  );
  const tickMs =
    Number.isFinite(options.tickMs) && options.tickMs > 0 ? options.tickMs : DEFAULT_TICK_MS;

  let timer = null;
  const runningBySource = new Map();
  const runningBatches = new Map();

  async function start() {
    await ensureDir(dataRoot);
    await ensureDir(jobsDir);
    await ensureDir(logsDir);
    await ensureDir(catalogsRoot);
    await ensureDir(batchesDir);
    await ensureDir(batchRunsRoot);
    await ensureSourcesFile();
    await ensureJobsIndexFile();
    await ensureBatchesIndexFile();

    timer = setInterval(() => {
      tick().catch(() => {});
    }, tickMs);

    if (typeof timer.unref === "function") {
      timer.unref();
    }

    await tick();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function tick() {
    const sources = await readSources();
    const now = Date.now();

    for (const source of sources) {
      if (!source.enabled || runningBySource.has(source.id)) {
        continue;
      }

      const nextRunAt = computeNextRunAt(source);

      if (nextRunAt && Date.parse(nextRunAt) > now) {
        continue;
      }

      runSource(source.id, { reason: "schedule", wait: false }).catch(() => {});
    }
  }

  async function listSources() {
    const sources = await readSources();

    return sources.map((source) => ({
      ...source,
      running: runningBySource.has(source.id),
      nextRunAt: computeNextRunAt(source),
    }));
  }

  async function getSource(sourceId) {
    const sources = await readSources();
    const source = sources.find((entry) => entry.id === sourceId);

    if (!source) {
      return null;
    }

    return {
      ...source,
      running: runningBySource.has(source.id),
      nextRunAt: computeNextRunAt(source),
    };
  }

  async function createSource(input) {
    const sources = await readSources();
    const source = normalizeSourceInput(input, null);
    source.id = ensureUniqueSourceId(source.id, sources);
    sources.push(source);
    await writeSources(sources);
    return source;
  }

  async function updateSource(sourceId, patch) {
    const sources = await readSources();
    const index = sources.findIndex((entry) => entry.id === sourceId);

    if (index === -1) {
      throw createNotFoundError(`Fonte não encontrada: ${sourceId}`);
    }

    const current = sources[index];
    const updated = normalizeSourceInput(
      {
        ...current,
        ...patch,
        id: current.id,
      },
      current,
    );
    sources[index] = updated;
    await writeSources(sources);
    return updated;
  }

  async function deleteSource(sourceId) {
    const sources = await readSources();
    const remaining = sources.filter((entry) => entry.id !== sourceId);

    if (remaining.length === sources.length) {
      throw createNotFoundError(`Fonte não encontrada: ${sourceId}`);
    }

    await writeSources(remaining);
    return true;
  }

  async function runSource(sourceId, { reason = "manual", wait = false } = {}) {
    const source = await getSource(sourceId);

    if (!source) {
      throw createNotFoundError(`Fonte não encontrada: ${sourceId}`);
    }

    if (runningBySource.has(source.id)) {
      const running = await getJob(runningBySource.get(source.id).jobId);
      return {
        alreadyRunning: true,
        job: running,
      };
    }

    const jobId = buildJobId(source.id);
    const logPath = path.join(logsDir, `${jobId}.ndjson`);
    const job = {
      id: jobId,
      sourceId: source.id,
      sourceLabel: source.label,
      sourceUrl: source.url,
      status: "running",
      reason,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      adapterId: source.adapterHint,
      output: null,
      metrics: null,
      logPath,
    };

    await persistJob(job);
    await appendJobLog(job.id, {
      level: "info",
      scope: "backend",
      message: "Job criado para fonte cadastrada.",
      context: {
        sourceId: source.id,
        sourceLabel: source.label,
        sourceUrl: source.url,
        reason,
      },
    });

    const promise = runSourceInternal(source, job).finally(() => {
      runningBySource.delete(source.id);
    });

    runningBySource.set(source.id, {
      jobId,
      promise,
    });

    if (!wait) {
      promise.catch(() => {});
      return {
        alreadyRunning: false,
        job,
      };
    }

    const completedJob = await promise;
    return {
      alreadyRunning: false,
      job: completedJob,
    };
  }

  async function runAdhoc(input, { wait = true } = {}) {
    const source = createAdhocSource(input);
    const { job, promise } = await startAdhocJob(source, { reason: input?.reason || "adhoc" });

    if (!wait) {
      promise.catch(() => {});
      return job;
    }

    return promise;
  }

  async function runBatch(input, { wait = false } = {}) {
    const normalized = normalizeBatchInput(input);
    const batchId = buildBatchId(normalized.label || `lote-${normalized.items.length}`);
    const batch = {
      id: batchId,
      label: normalized.label,
      status: "running",
      reason: normalized.reason,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      currentItemIndex: null,
      currentJobId: null,
      metrics: null,
      output: null,
      error: null,
      items: normalized.items.map((item, index) => ({
        index,
        label: item.label,
        url: item.url,
        city: item.city,
        adapterHint: item.adapterHint,
        status: "queued",
        startedAt: null,
        finishedAt: null,
        jobId: null,
        metrics: null,
        error: null,
        output: null,
      })),
    };

    await persistBatch(batch);

    const promise = runBatchInternal(batch, normalized)
      .finally(() => {
        runningBatches.delete(batch.id);
      });

    runningBatches.set(batch.id, { promise });

    if (!wait) {
      promise.catch(() => {});
      return batch;
    }

    return promise;
  }

  async function listBatches({ limit = DEFAULT_BATCH_LIMIT } = {}) {
    const batches = await readBatchesIndex();
    return batches.slice(0, Math.max(limit, 1));
  }

  async function getBatch(batchId) {
    const batchPath = path.join(batchesDir, `${batchId}.json`);
    return readJson(batchPath).catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }

      throw error;
    });
  }

  async function getLatestCatalog(sourceId) {
    const source = await getSource(sourceId);

    if (!source?.latestJobId) {
      return null;
    }

    const job = await getJob(source.latestJobId);

    if (!job?.output?.summaryPath) {
      return null;
    }

    const summary = await readJson(job.output.summaryPath).catch(() => null);

    return {
      source,
      job,
      summary,
    };
  }

  async function listJobs({ sourceId = null, limit = 50 } = {}) {
    const jobs = await readJobsIndex();
    const filtered = sourceId ? jobs.filter((entry) => entry.sourceId === sourceId) : jobs;
    return filtered.slice(0, Math.max(limit, 1));
  }

  async function getJob(jobId) {
    const jobPath = path.join(jobsDir, `${jobId}.json`);
    return readJson(jobPath).catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }

      throw error;
    });
  }

  async function getJobLogs(jobId, { limit = 200, after = 0 } = {}) {
    const job = await getJob(jobId);

    if (!job) {
      throw createNotFoundError(`Job não encontrado: ${jobId}`);
    }

    const targetPath = job.logPath || path.join(logsDir, `${jobId}.ndjson`);
    const entries = await readNdjson(targetPath).catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }

      throw error;
    });
    const normalizedAfter = Number.isFinite(Number(after)) ? Math.max(Number(after), 0) : 0;
    const startIndex = normalizedAfter > 0 ? normalizedAfter : 0;
    const sliced = entries.slice(startIndex, startIndex + Math.max(limit, 1));

    return {
      jobId,
      total: entries.length,
      nextAfter: startIndex + sliced.length,
      items: sliced.map((entry, index) => ({
        ...entry,
        line: startIndex + index + 1,
      })),
    };
  }

  function getHealth() {
    return {
      ok: true,
      dataRoot,
      runningSources: Array.from(runningBySource.keys()),
      runningBatches: Array.from(runningBatches.keys()),
      tickMs,
      webhookConfigured: Boolean(webhookUrl),
      productsWebhookConfigured: Boolean(productsWebhookUrl),
    };
  }

  function getArtifactsRoot() {
    return dataRoot;
  }

  async function runSourceInternal(source, job) {
    try {
      await appendJobLog(job.id, {
        level: "info",
        scope: "backend",
        message: "Execucao iniciada.",
        context: {
          sourceId: source.id,
          sourceLabel: source.label,
          sourceUrl: source.url,
          adapterHint: source.adapterHint,
          city: source.city,
        },
      });
      const result = await runScrapeForSource(source, job.id);
      return finalizeJob(job, result, source);
    } catch (error) {
      return failJob(job, error, source);
    }
  }

  async function startAdhocJob(source, { reason = "adhoc" } = {}) {
    const jobId = buildJobId(source.id || slugify(source.label || "adhoc"));
    const logPath = path.join(logsDir, `${jobId}.ndjson`);
    const job = {
      id: jobId,
      sourceId: null,
      sourceLabel: source.label,
      sourceUrl: source.url,
      status: "running",
      reason,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      adapterId: source.adapterHint,
      output: null,
      metrics: null,
      logPath,
    };

    await persistJob(job);
    await appendJobLog(job.id, {
      level: "info",
      scope: "backend",
      message: "Job ad hoc criado.",
      context: {
        sourceLabel: source.label,
        sourceUrl: source.url,
        reason,
      },
    });
    await appendJobLog(job.id, {
      level: "info",
      scope: "backend",
      message: "Execucao ad hoc iniciada.",
      context: {
        adapterHint: source.adapterHint,
        city: source.city,
        workerCount: source.workerCount,
      },
    });

    const promise = runScrapeForSource(source, jobId)
      .then((result) => finalizeJob(job, result, source))
      .catch((error) => failJob(job, error, source));

    return { job, promise };
  }

  async function runScrapeForSource(source, jobId) {
    const sourceOutputRoot = path.join(catalogsRoot, source.id || slugify(source.label));

    return scrapeIntelligentCatalog({
      url: source.url,
      label: source.label,
      city: source.city,
      headless: source.headless,
      adapterHint: source.adapterHint,
      outputRoot: sourceOutputRoot,
      maxSections: source.maxSections,
      maxPagesPerSection: source.maxPagesPerSection,
      maxItemsPerPage: source.maxItemsPerPage,
      workerCount: source.workerCount,
      onLog: (entry) => {
        appendJobLog(jobId, entry).catch(() => {});
      },
    });
  }

  async function runBatchInternal(batch, normalizedBatch) {
    let currentBatch = { ...batch };
    const successfulCatalogs = [];

    try {
      for (let index = 0; index < normalizedBatch.items.length; index += 1) {
        const source = normalizedBatch.items[index];
        const previousItem = currentBatch.items[index];
        const itemStartedAt = new Date().toISOString();

        currentBatch = {
          ...currentBatch,
          currentItemIndex: index,
          currentJobId: null,
          items: replaceArrayItem(currentBatch.items, index, {
            ...previousItem,
            status: "running",
            startedAt: itemStartedAt,
            finishedAt: null,
            error: null,
          }),
        };
        await persistBatch(currentBatch);

        const { job, promise } = await startAdhocJob(source, {
          reason: `batch:${currentBatch.id}`,
        });

        currentBatch = {
          ...currentBatch,
          currentJobId: job.id,
          items: replaceArrayItem(currentBatch.items, index, {
            ...currentBatch.items[index],
            jobId: job.id,
          }),
        };
        await persistBatch(currentBatch);

        const completedJob = await promise;
        const finishedAt = completedJob.finishedAt || new Date().toISOString();
        const itemResult = {
          ...currentBatch.items[index],
          status: completedJob.status,
          finishedAt,
          metrics: completedJob.metrics || null,
          error: completedJob.error || null,
          output: completedJob.output || null,
        };

        currentBatch = {
          ...currentBatch,
          currentJobId: null,
          items: replaceArrayItem(currentBatch.items, index, itemResult),
        };
        await persistBatch(currentBatch);

        if (completedJob.status === "completed" && completedJob.output?.jsonPath) {
          const catalogPayload = await readJson(completedJob.output.jsonPath).catch(() => null);

          successfulCatalogs.push({
            index,
            source: {
              label: source.label,
              url: source.url,
              city: source.city,
              adapterHint: source.adapterHint,
            },
            job: completedJob,
            metadata: catalogPayload?.metadata || null,
            discovery: catalogPayload?.discovery || null,
            sections: catalogPayload?.sections || [],
            products: Array.isArray(catalogPayload?.products) ? catalogPayload.products : [],
          });
        }
      }

      const output = await writeBatchArtifacts({
        batchRunsRoot,
        batchId: currentBatch.id,
        label: currentBatch.label,
        items: currentBatch.items,
        catalogs: successfulCatalogs,
      });

      const metrics = summarizeBatch(currentBatch.items, successfulCatalogs);
      currentBatch = {
        ...currentBatch,
        status: "completed",
        finishedAt: new Date().toISOString(),
        currentItemIndex: null,
        currentJobId: null,
        metrics,
        output,
        error: null,
      };
      await persistBatch(currentBatch);

      return currentBatch;
    } catch (error) {
      currentBatch = {
        ...currentBatch,
        status: "failed",
        finishedAt: new Date().toISOString(),
        currentItemIndex: null,
        currentJobId: null,
        error: {
          message: error.message,
        },
      };
      await persistBatch(currentBatch);
      return currentBatch;
    }
  }

  async function finalizeJob(job, result, source = null) {
    const completedJob = {
      ...job,
      status: "completed",
      finishedAt: new Date().toISOString(),
      error: null,
      adapterId: result.metadata?.adapterId || job.adapterId,
      output: result.paths,
      metrics: {
        totalSections: result.metadata?.totalSections || result.sections?.length || 0,
        totalProducts: result.metadata?.totalProducts || result.products?.length || 0,
        catalogDetected: Boolean(result.metadata?.catalogDetected),
      },
    };

    await persistJob(completedJob);
    await appendJobLog(completedJob.id, {
      level: completedJob.metrics.catalogDetected ? "info" : "warn",
      scope: "backend",
      message: completedJob.metrics.catalogDetected
        ? "Job concluido com catalogo detectado."
        : "Job concluido sem catalogo aproveitavel.",
      context: {
        sourceId: completedJob.sourceId,
        sourceLabel: completedJob.sourceLabel,
        metrics: completedJob.metrics,
        output: completedJob.output,
      },
    });

    if (source) {
      await patchSourceAfterRun(source.id, {
        lastRunAt: completedJob.finishedAt,
        lastSuccessAt: completedJob.finishedAt,
        latestJobId: completedJob.id,
        latestRunDir: completedJob.output?.runDir || null,
        latestSummaryPath: completedJob.output?.summaryPath || null,
        latestCatalogJsonPath: completedJob.output?.jsonPath || null,
        latestCatalogCsvPath: completedJob.output?.csvPath || null,
        lastError: null,
      });
    }

    await notifyWebhook({
      event: "catalog.completed",
      job: completedJob,
      source,
      result,
    });
    await notifyProductsWebhook({
      job: completedJob,
      source,
      result,
    });

    return completedJob;
  }

  async function failJob(job, error, source = null) {
    const failedJob = {
      ...job,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: {
        message: error.message,
      },
    };

    await persistJob(failedJob);
    await appendJobLog(failedJob.id, {
      level: "error",
      scope: "backend",
      message: "Job finalizado com erro.",
      context: {
        sourceId: failedJob.sourceId,
        sourceLabel: failedJob.sourceLabel,
        error: failedJob.error,
      },
    });

    if (source) {
      await patchSourceAfterRun(source.id, {
        lastRunAt: failedJob.finishedAt,
        lastError: failedJob.error,
      });
    }

    await notifyWebhook({
      event: "catalog.failed",
      job: failedJob,
      source,
      error,
    });

    return failedJob;
  }

  async function patchSourceAfterRun(sourceId, patch) {
    const sources = await readSources();
    const index = sources.findIndex((entry) => entry.id === sourceId);

    if (index === -1) {
      return;
    }

    sources[index] = {
      ...sources[index],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await writeSources(sources);
  }

  async function ensureSourcesFile() {
    await ensureFile(sourcesPath, []);
  }

  async function ensureJobsIndexFile() {
    await ensureFile(jobsIndexPath, []);
  }

  async function ensureBatchesIndexFile() {
    await ensureFile(batchesIndexPath, []);
  }

  async function readSources() {
    await ensureSourcesFile();
    return readJson(sourcesPath);
  }

  async function writeSources(sources) {
    await fs.writeFile(
      sourcesPath,
      JSON.stringify(
        sources.sort((left, right) => left.label.localeCompare(right.label, "pt-BR")),
        null,
        2,
      ),
      "utf8",
    );
  }

  async function readJobsIndex() {
    await ensureJobsIndexFile();
    return readJson(jobsIndexPath);
  }

  async function readBatchesIndex() {
    await ensureBatchesIndexFile();
    return readJson(batchesIndexPath);
  }

  async function persistJob(job) {
    await ensureDir(jobsDir);
    const jobPath = path.join(jobsDir, `${job.id}.json`);
    await fs.writeFile(jobPath, JSON.stringify(job, null, 2), "utf8");

    const jobs = await readJobsIndex();
    const withoutCurrent = jobs.filter((entry) => entry.id !== job.id);
    const next = [toJobSummary(job), ...withoutCurrent]
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .slice(0, 500);

    await fs.writeFile(jobsIndexPath, JSON.stringify(next, null, 2), "utf8");
  }

  async function appendJobLog(jobId, entry) {
    await ensureDir(logsDir);
    const targetPath = path.join(logsDir, `${jobId}.ndjson`);
    const payload = {
      at: new Date().toISOString(),
      level: entry?.level || "info",
      scope: entry?.scope || "backend",
      message: entry?.message || "Log sem mensagem.",
      context: entry?.context || null,
    };

    await fs.appendFile(targetPath, `${JSON.stringify(payload)}\n`, "utf8");
  }

  async function persistBatch(batch) {
    await ensureDir(batchesDir);
    const batchPath = path.join(batchesDir, `${batch.id}.json`);
    await fs.writeFile(batchPath, JSON.stringify(batch, null, 2), "utf8");

    const batches = await readBatchesIndex();
    const withoutCurrent = batches.filter((entry) => entry.id !== batch.id);
    const next = [toBatchSummary(batch), ...withoutCurrent]
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .slice(0, DEFAULT_BATCH_LIMIT);

    await fs.writeFile(batchesIndexPath, JSON.stringify(next, null, 2), "utf8");
  }

  async function notifyWebhook({ event, job, source = null, result = null, error = null }) {
    if (!webhookUrl) {
      return;
    }

    const payload = {
      event,
      at: new Date().toISOString(),
      jobId: job.id,
      sourceId: job.sourceId || source?.id || null,
      sourceLabel: job.sourceLabel || source?.label || null,
      sourceUrl: job.sourceUrl || source?.url || null,
      status: job.status,
      catalogDetected:
        job.metrics?.catalogDetected ??
        result?.metadata?.catalogDetected ??
        null,
      requestedCity: result?.metadata?.requestedCity || null,
      effectiveCity: result?.metadata?.effectiveCity || null,
      storeLabel: result?.metadata?.storeLabel || null,
      cityCoverage: result?.metadata?.cityCoverage || null,
      cityEligible:
        typeof result?.metadata?.cityEligible === "boolean"
          ? result.metadata.cityEligible
          : null,
      contextUrl: result?.metadata?.contextUrl || null,
      metrics: job.metrics || null,
      artifactUrls: mapArtifactPaths(job),
      error: error ? { message: error.message } : job.error || null,
      finishedAt: job.finishedAt,
    };

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(webhookToken ? { Authorization: `Bearer ${webhookToken}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      await appendJobLog(job.id, {
        level: response.ok ? "info" : "warn",
        scope: "webhook",
        message: response.ok
          ? "Webhook notificado com sucesso."
          : "Webhook respondeu com status nao esperado.",
        context: {
          webhookUrl,
          status: response.status,
          statusText: response.statusText,
        },
      });
    } catch (webhookError) {
      await appendJobLog(job.id, {
        level: "error",
        scope: "webhook",
        message: "Falha ao notificar webhook.",
        context: {
          webhookUrl,
          error: webhookError.message,
        },
      });
    }
  }

  async function notifyProductsWebhook({ job, source = null, result = null }) {
    const resolvedProductsWebhookUrl = source?.productsWebhookUrl || productsWebhookUrl;
    const resolvedProductsWebhookToken = source?.productsWebhookToken || productsWebhookToken;
    const resolvedProductsWebhookBatchSize = sanitizePositiveInteger(
      source?.productsWebhookBatchSize,
      productsWebhookBatchSize,
    );

    if (
      !resolvedProductsWebhookUrl ||
      !Array.isArray(result?.products) ||
      result.products.length === 0
    ) {
      return;
    }

    const batches = chunkArray(result.products, resolvedProductsWebhookBatchSize);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const products = batches[batchIndex];
      const payload = products.map((product, productIndex) => ({
        at: new Date().toISOString(),
        jobId: job.id,
        sourceId: job.sourceId || source?.id || null,
        sourceLabel: job.sourceLabel || source?.label || null,
        sourceUrl: job.sourceUrl || source?.url || null,
        status: job.status,
        requestedCity: result?.metadata?.requestedCity || null,
        effectiveCity: result?.metadata?.effectiveCity || null,
        storeLabel: result?.metadata?.storeLabel || null,
        cityCoverage: result?.metadata?.cityCoverage || null,
        cityEligible:
          typeof result?.metadata?.cityEligible === "boolean"
            ? result.metadata.cityEligible
            : null,
        contextUrl: result?.metadata?.contextUrl || null,
        adapterId: result?.metadata?.adapterId || job.adapterId || null,
        totalProducts: result.products.length,
        batchIndex: batchIndex + 1,
        totalBatches: batches.length,
        batchSize: products.length,
        itemIndexInBatch: productIndex + 1,
        ...product,
      }));

      try {
        const response = await fetch(resolvedProductsWebhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(resolvedProductsWebhookToken
              ? { Authorization: `Bearer ${resolvedProductsWebhookToken}` }
              : {}),
          },
          body: JSON.stringify(payload),
        });

        await appendJobLog(job.id, {
          level: response.ok ? "info" : "warn",
          scope: "products-webhook",
          message: response.ok
            ? "Lote de produtos enviado com sucesso."
            : "Webhook de produtos respondeu com status nao esperado.",
          context: {
            productsWebhookUrl: resolvedProductsWebhookUrl,
            batchIndex: batchIndex + 1,
            totalBatches: batches.length,
            batchSize: products.length,
            status: response.status,
            statusText: response.statusText,
          },
        });
      } catch (productsWebhookError) {
        await appendJobLog(job.id, {
          level: "error",
          scope: "products-webhook",
          message: "Falha ao enviar lote de produtos.",
          context: {
            productsWebhookUrl: resolvedProductsWebhookUrl,
            batchIndex: batchIndex + 1,
            totalBatches: batches.length,
            batchSize: products.length,
            error: productsWebhookError.message,
          },
        });
      }
    }
  }

  return {
    createSource,
    deleteSource,
    getArtifactsRoot,
    getBatch,
    getHealth,
    getJob,
    getJobLogs,
    getLatestCatalog,
    getSource,
    listBatches,
    listJobs,
    listSources,
    runAdhoc,
    runBatch,
    runSource,
    start,
    stop,
    updateSource,
  };
}

function createAdhocSource(input) {
  return normalizeSourceInput(
    {
      ...input,
      enabled: false,
      scheduleMinutes: 0,
    },
    null,
  );
}

function normalizeSourceInput(input, existing) {
  const url = normalizeUrl(input.url || existing?.url);
  const hostname = new URL(url).hostname.replace(/^www\./, "");
  const label = sanitizeString(input.label) || existing?.label || hostname;
  const now = new Date().toISOString();

  return {
    id:
      sanitizeString(input.id) ||
      existing?.id ||
      slugify(`${label}-${hostname}`).slice(0, 60),
    label,
    url,
    city: sanitizeString(input.city) || null,
    enabled: readBoolean(input.enabled, existing?.enabled ?? true),
    scheduleMinutes: sanitizePositiveInteger(
      input.scheduleMinutes,
      existing?.scheduleMinutes ?? DEFAULT_SCHEDULE_MINUTES,
    ),
    maxSections: sanitizePositiveInteger(
      input.maxSections,
      existing?.maxSections ?? DEFAULT_MAX_SECTIONS,
    ),
    maxPagesPerSection: sanitizePositiveInteger(
      input.maxPagesPerSection,
      existing?.maxPagesPerSection ?? DEFAULT_MAX_PAGES_PER_SECTION,
    ),
    maxItemsPerPage: sanitizePositiveInteger(
      input.maxItemsPerPage,
      existing?.maxItemsPerPage ?? DEFAULT_MAX_ITEMS_PER_PAGE,
    ),
    workerCount: sanitizePositiveInteger(
      input.workerCount,
      existing?.workerCount ?? DEFAULT_WORKER_COUNT,
    ),
    productsWebhookUrl:
      sanitizeString(input.productsWebhookUrl) ||
      existing?.productsWebhookUrl ||
      null,
    productsWebhookToken:
      sanitizeString(input.productsWebhookToken) ||
      existing?.productsWebhookToken ||
      null,
    productsWebhookBatchSize: sanitizePositiveInteger(
      input.productsWebhookBatchSize,
      existing?.productsWebhookBatchSize ?? DEFAULT_PRODUCTS_WEBHOOK_BATCH_SIZE,
    ),
    adapterHint:
      sanitizeString(input.adapterHint) || existing?.adapterHint || "auto",
    headless: readBoolean(input.headless, existing?.headless ?? true),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt || null,
    lastSuccessAt: existing?.lastSuccessAt || null,
    latestJobId: existing?.latestJobId || null,
    latestRunDir: existing?.latestRunDir || null,
    latestSummaryPath: existing?.latestSummaryPath || null,
    latestCatalogJsonPath: existing?.latestCatalogJsonPath || null,
    latestCatalogCsvPath: existing?.latestCatalogCsvPath || null,
    lastError: existing?.lastError || null,
  };
}

function sanitizeString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function sanitizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return fallback;
}

function computeNextRunAt(source) {
  if (!source.enabled) {
    return null;
  }

  if (!source.lastRunAt) {
    return new Date().toISOString();
  }

  const baseTime = Date.parse(source.lastSuccessAt || source.lastRunAt);

  if (!Number.isFinite(baseTime)) {
    return new Date().toISOString();
  }

  return new Date(baseTime + source.scheduleMinutes * 60_000).toISOString();
}

function toJobSummary(job) {
  return {
    id: job.id,
    sourceId: job.sourceId,
    sourceLabel: job.sourceLabel,
    sourceUrl: job.sourceUrl,
    status: job.status,
    reason: job.reason,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    adapterId: job.adapterId,
    metrics: job.metrics || null,
    error: job.error || null,
    output: job.output || null,
    logPath: job.logPath || null,
  };
}

function toBatchSummary(batch) {
  return {
    id: batch.id,
    label: batch.label,
    status: batch.status,
    reason: batch.reason,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    currentItemIndex: batch.currentItemIndex,
    currentJobId: batch.currentJobId,
    metrics: batch.metrics || null,
    error: batch.error || null,
    output: batch.output || null,
    totalItems: Array.isArray(batch.items) ? batch.items.length : 0,
    items: Array.isArray(batch.items) ? batch.items : [],
  };
}

function buildJobId(sourceId) {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(sourceId).slice(0, 48)}`;
}

function buildBatchId(label) {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-batch-${slugify(label).slice(0, 42)}`;
}

async function ensureFile(targetPath, fallbackValue) {
  try {
    await fs.access(targetPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, JSON.stringify(fallbackValue, null, 2), "utf8");
  }
}

async function readJson(targetPath) {
  const content = await fs.readFile(targetPath, "utf8");
  return JSON.parse(content);
}

async function readNdjson(targetPath) {
  const content = await fs.readFile(targetPath, "utf8");

  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function mapArtifactPaths(job) {
  return {
    runDir: job.output?.runDir || null,
    summary: job.output?.summaryPath || null,
    json: job.output?.jsonPath || null,
    csv: job.output?.csvPath || null,
    logs: job.logPath || null,
  };
}

function chunkArray(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function replaceArrayItem(items, index, nextItem) {
  return items.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
}

function normalizeBatchInput(input) {
  const batchLabel = sanitizeString(input.label) || "Lote de catálogos";
  const shared = {
    city: sanitizeString(input.city) || null,
    adapterHint: sanitizeString(input.adapterHint) || "auto",
    maxSections: sanitizePositiveInteger(input.maxSections, DEFAULT_MAX_SECTIONS),
    maxPagesPerSection: sanitizePositiveInteger(
      input.maxPagesPerSection,
      DEFAULT_MAX_PAGES_PER_SECTION,
    ),
    maxItemsPerPage: sanitizePositiveInteger(
      input.maxItemsPerPage,
      DEFAULT_MAX_ITEMS_PER_PAGE,
    ),
    workerCount: sanitizePositiveInteger(input.workerCount, DEFAULT_WORKER_COUNT),
    headless: readBoolean(input.headless, true),
    productsWebhookUrl: sanitizeString(input.productsWebhookUrl) || null,
    productsWebhookToken: sanitizeString(input.productsWebhookToken) || null,
    productsWebhookBatchSize: sanitizePositiveInteger(
      input.productsWebhookBatchSize,
      DEFAULT_PRODUCTS_WEBHOOK_BATCH_SIZE,
    ),
  };
  const rawItems = normalizeBatchRawItems(input);

  if (!rawItems.length) {
    throw new Error("Informe pelo menos uma URL para o lote.");
  }

  return {
    label: batchLabel,
    reason: sanitizeString(input.reason) || "batch",
    items: rawItems.map((item) =>
      createAdhocSource({
        ...shared,
        ...(typeof item === "string" ? { url: item } : item),
      }),
    ),
  };
}

function normalizeBatchRawItems(input) {
  if (Array.isArray(input.items) && input.items.length > 0) {
    return input.items;
  }

  if (Array.isArray(input.urls) && input.urls.length > 0) {
    return input.urls.map((url) => ({ url }));
  }

  if (typeof input.urls === "string") {
    return input.urls
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((url) => ({ url }));
  }

  if (sanitizeString(input.url)) {
    return [{ url: sanitizeString(input.url), label: sanitizeString(input.label) }];
  }

  return [];
}

async function writeBatchArtifacts({ batchRunsRoot, batchId, label, items, catalogs }) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const runDir = path.join(resolveFromCwd(batchRunsRoot), `${stamp}-${slugify(label || batchId)}`);
  const summaryPath = path.join(runDir, "summary.json");
  const jsonPath = path.join(runDir, "catalogs.json");
  const csvPath = path.join(runDir, "catalogs.csv");

  await ensureDir(runDir);

  const csvRows = flattenBatchCsvRows(batchId, label, catalogs);
  const summary = {
    batchId,
    label,
    generatedAt: new Date().toISOString(),
    totalItems: items.length,
    successfulItems: items.filter((item) => item.status === "completed").length,
    failedItems: items.filter((item) => item.status === "failed").length,
    totalProducts: csvRows.length,
    items: items.map((item) => ({
      index: item.index,
      label: item.label,
      url: item.url,
      city: item.city,
      status: item.status,
      jobId: item.jobId,
      metrics: item.metrics,
      error: item.error,
      output: item.output,
    })),
  };

  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        metadata: summary,
        catalogs,
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(csvPath, toCsv(csvRows), "utf8");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  return {
    runDir,
    summaryPath,
    jsonPath,
    csvPath,
  };
}

function flattenBatchCsvRows(batchId, batchLabel, catalogs) {
  const rows = [];

  for (const catalog of catalogs) {
    for (const product of catalog.products || []) {
      rows.push({
        batchId,
        batchLabel,
        itemIndex: catalog.index + 1,
        sourceLabel: catalog.source?.label || null,
        sourceUrl: catalog.source?.url || null,
        sourceCity: catalog.source?.city || null,
        adapterHint: catalog.source?.adapterHint || null,
        jobId: catalog.job?.id || null,
        requestedCity: catalog.metadata?.requestedCity || null,
        effectiveCity: catalog.metadata?.effectiveCity || null,
        storeLabel: catalog.metadata?.storeLabel || null,
        cityCoverage: catalog.metadata?.cityCoverage || null,
        cityEligible:
          typeof catalog.metadata?.cityEligible === "boolean"
            ? catalog.metadata.cityEligible
            : null,
        catalogRootUrl: catalog.metadata?.rootUrl || null,
        ...product,
      });
    }
  }

  return rows;
}

function summarizeBatch(items, catalogs) {
  return {
    totalItems: items.length,
    completedItems: items.filter((item) => item.status === "completed").length,
    failedItems: items.filter((item) => item.status === "failed").length,
    totalProducts: catalogs.reduce(
      (sum, catalog) => sum + (Array.isArray(catalog.products) ? catalog.products.length : 0),
      0,
    ),
  };
}

function ensureUniqueSourceId(candidateId, sources) {
  const existing = new Set(sources.map((source) => source.id));

  if (!existing.has(candidateId)) {
    return candidateId;
  }

  let counter = 2;
  let nextId = `${candidateId}-${counter}`;

  while (existing.has(nextId)) {
    counter += 1;
    nextId = `${candidateId}-${counter}`;
  }

  return nextId;
}

function createNotFoundError(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

module.exports = {
  DEFAULT_DATA_ROOT,
  DEFAULT_SCHEDULE_MINUTES,
  createCatalogBackendService,
};
