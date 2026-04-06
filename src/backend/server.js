const path = require("path");
const express = require("express");
const {
  DEFAULT_DATA_ROOT,
  createCatalogBackendService,
} = require("../lib/catalog-backend-service");

const app = express();
const backend = createCatalogBackendService({
  dataRoot: process.env.CATALOG_API_DATA_ROOT || DEFAULT_DATA_ROOT,
});
const artifactsRoot = backend.getArtifactsRoot();
const staticRoot = path.join(__dirname, "static");

app.use(express.json({ limit: "2mb" }));
app.use(applyCorsHeaders);
app.options(/.*/, (_req, res) => {
  res.status(204).end();
});
app.use("/artifacts/backend", express.static(artifactsRoot));
app.use("/console", express.static(staticRoot));

app.get("/", (_req, res) => {
  res.redirect("/console/");
});

app.get("/v1/health", async (_req, res) => {
  const sources = await backend.listSources();
  const jobs = await backend.listJobs({ limit: 10 });

  res.json({
    ...backend.getHealth(),
    totals: {
      sources: sources.length,
      enabledSources: sources.filter((source) => source.enabled).length,
      runningSources: sources.filter((source) => source.running).length,
      recentJobs: jobs.length,
    },
  });
});

app.get("/v1/sources", async (_req, res) => {
  const items = await backend.listSources();
  res.json({ items });
});

app.get("/v1/sources/:sourceId", async (req, res) => {
  const source = await backend.getSource(req.params.sourceId);

  if (!source) {
    res.status(404).json({ error: "Fonte não encontrada." });
    return;
  }

  res.json({ item: source });
});

app.post("/v1/sources", requireApiToken, async (req, res) => {
  try {
    const item = await backend.createSource(req.body || {});
    res.status(201).json({ item });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.patch("/v1/sources/:sourceId", requireApiToken, async (req, res) => {
  try {
    const item = await backend.updateSource(req.params.sourceId, req.body || {});
    res.json({ item });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.delete("/v1/sources/:sourceId", requireApiToken, async (req, res) => {
  try {
    await backend.deleteSource(req.params.sourceId);
    res.json({ ok: true });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.post("/v1/sources/:sourceId/run", requireApiToken, async (req, res) => {
  try {
    const wait = readBooleanFlag(req.body?.wait, req.query.wait);
    const result = await backend.runSource(req.params.sourceId, {
      reason: req.body?.reason || req.query.reason || "api",
      wait,
    });

    res.status(result.alreadyRunning ? 202 : wait ? 200 : 202).json({
      alreadyRunning: result.alreadyRunning,
      job: serializeJobForResponse(result.job),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.post("/v1/catalog/run", requireApiToken, async (req, res) => {
  try {
    const wait = readBooleanFlag(req.body?.wait, req.query.wait, true);
    const job = await backend.runAdhoc(req.body || {}, { wait });

    res.status(wait ? 200 : 202).json({
      job: serializeJobForResponse(job),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.post("/v1/catalog/run-batch", requireApiToken, async (req, res) => {
  try {
    const wait = readBooleanFlag(req.body?.wait, req.query.wait, false);
    const batch = await backend.runBatch(req.body || {}, { wait });

    res.status(wait ? 200 : 202).json({
      batch: serializeBatchForResponse(batch),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get("/v1/sources/:sourceId/catalog/latest", async (req, res) => {
  try {
    const latest = await backend.getLatestCatalog(req.params.sourceId);

    if (!latest) {
      res.status(404).json({ error: "Ainda não existe catálogo salvo para esta fonte." });
      return;
    }

    res.json({
      source: latest.source,
      job: serializeJobForResponse(latest.job),
      summary: latest.summary,
      artifactUrls: mapArtifactUrls({
        ...(latest.job?.output || {}),
        logPath: latest.job?.logPath || null,
      }),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get("/v1/sources/:sourceId/jobs", async (req, res) => {
  try {
    const items = await backend.listJobs({
      sourceId: req.params.sourceId,
      limit: toPositiveInt(req.query.limit, 50),
    });
    res.json({
      items: items.map(serializeJobForResponse),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get("/v1/jobs", async (req, res) => {
  try {
    const items = await backend.listJobs({
      sourceId: req.query.sourceId || null,
      limit: toPositiveInt(req.query.limit, 50),
    });
    res.json({
      items: items.map(serializeJobForResponse),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get("/v1/batches", async (req, res) => {
  try {
    const items = await backend.listBatches({
      limit: toPositiveInt(req.query.limit, 50),
    });
    res.json({
      items: items.map(serializeBatchForResponse),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get("/v1/batches/:batchId", async (req, res) => {
  try {
    const item = await backend.getBatch(req.params.batchId);

    if (!item) {
      res.status(404).json({ error: "Lote não encontrado." });
      return;
    }

    res.json({
      item: serializeBatchForResponse(item),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get("/v1/jobs/:jobId", async (req, res) => {
  try {
    const item = await backend.getJob(req.params.jobId);

    if (!item) {
      res.status(404).json({ error: "Job não encontrado." });
      return;
    }

    res.json({
      item: serializeJobForResponse(item),
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get("/v1/jobs/:jobId/logs", async (req, res) => {
  try {
    const payload = await backend.getJobLogs(req.params.jobId, {
      limit: toPositiveInt(req.query.limit, 200),
      after: toNonNegativeInt(req.query.after, 0),
    });

    res.json(payload);
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

app.get("/v1/jobs/:jobId/logs/stream", async (req, res) => {
  const jobId = req.params.jobId;
  let after = toNonNegativeInt(req.query.after, 0);
  let closed = false;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const pushLogs = async () => {
    try {
      const payload = await backend.getJobLogs(jobId, {
        limit: 200,
        after,
      });

      if (payload.items.length > 0) {
        after = payload.nextAfter;
        for (const item of payload.items) {
          send("log", item);
        }
      }

      const job = await backend.getJob(jobId);

      if (!job) {
        send("error", { message: "Job não encontrado." });
        cleanup();
        return;
      }

      if (job.status === "completed" || job.status === "failed") {
        send("done", {
          status: job.status,
          finishedAt: job.finishedAt,
        });
        cleanup();
      }
    } catch (error) {
      send("error", { message: error.message });
      cleanup();
    }
  };

  const interval = setInterval(() => {
    pushLogs().catch(() => {});
  }, 1500);

  const cleanup = () => {
    if (closed) {
      return;
    }

    closed = true;
    clearInterval(interval);
    res.end();
  };

  req.on("close", cleanup);
  send("ready", { jobId });
  pushLogs().catch(() => {});
});

async function start() {
  await backend.start();
  const port = Number.parseInt(process.env.BACKEND_PORT || process.env.PORT || "3100", 10);

  app.listen(port, () => {
    console.log(`Backend de catálogo disponível em http://localhost:${port}`);
  });
}

function applyCorsHeaders(req, res, next) {
  const allowOrigin = process.env.CATALOG_API_ALLOW_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
}

function requireApiToken(req, res, next) {
  const configuredToken = process.env.CATALOG_API_TOKEN || process.env.BACKEND_API_TOKEN;

  if (!configuredToken) {
    next();
    return;
  }

  const header = String(req.headers.authorization || "");
  const token = header.replace(/^Bearer\s+/i, "").trim();

  if (token !== configuredToken) {
    res.status(401).json({ error: "Token inválido." });
    return;
  }

  next();
}

function serializeJobForResponse(job) {
  if (!job) {
    return null;
  }

  return {
    ...job,
    artifactUrls: mapArtifactUrls({
      ...(job.output || {}),
      logPath: job.logPath || null,
    }),
  };
}

function serializeBatchForResponse(batch) {
  if (!batch) {
    return null;
  }

  return {
    ...batch,
    items: Array.isArray(batch.items)
      ? batch.items.map((item) => ({
          ...item,
          artifactUrls: mapArtifactUrls({
            ...(item.output || {}),
          }),
        }))
      : [],
    artifactUrls: mapArtifactUrls({
      ...(batch.output || {}),
    }),
  };
}

function mapArtifactUrls(output) {
  return {
    runDir: toArtifactUrl(output?.runDir),
    summary: toArtifactUrl(output?.summaryPath),
    json: toArtifactUrl(output?.jsonPath),
    csv: toArtifactUrl(output?.csvPath),
    logs: toArtifactUrl(output?.logPath || output?.logsPath || null),
  };
}

function toArtifactUrl(absolutePath) {
  if (!absolutePath) {
    return null;
  }

  const relativePath = path.relative(artifactsRoot, absolutePath).split(path.sep).join("/");
  return `/artifacts/backend/${relativePath}`;
}

function readBooleanFlag(bodyValue, queryValue, fallback = false) {
  const candidate = bodyValue ?? queryValue;

  if (typeof candidate === "boolean") {
    return candidate;
  }

  if (candidate === "true") {
    return true;
  }

  if (candidate === "false") {
    return false;
  }

  return fallback;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

start().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
