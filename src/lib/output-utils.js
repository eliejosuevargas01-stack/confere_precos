const fs = require("fs/promises");
const path = require("path");

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeScrapeOutputs({ result, outputConfig, defaultJsonPath, cwd }) {
  const jsonPath = resolveFrom(cwd, outputConfig?.jsonPath || defaultJsonPath);
  const csvPath = outputConfig?.csvPath ? resolveFrom(cwd, outputConfig.csvPath) : null;

  await ensureDir(path.dirname(jsonPath));
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");

  const saved = { jsonPath, csvPath: null };

  if (csvPath) {
    const csvRows = result.data?.collection?.items;

    if (Array.isArray(csvRows) && csvRows.length > 0) {
      await ensureDir(path.dirname(csvPath));
      await fs.writeFile(csvPath, toCsv(csvRows), "utf8");
      saved.csvPath = csvPath;
    }
  }

  return saved;
}

function toCsv(rows) {
  const headers = collectHeaders(rows);
  const lines = [headers.map(escapeCsvValue).join(",")];

  for (const row of rows) {
    const line = headers.map((header) => escapeCsvValue(serializeCsvValue(row[header])));
    lines.push(line.join(","));
  }

  return `${lines.join("\n")}\n`;
}

function collectHeaders(rows) {
  const headers = new Set();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      headers.add(key);
    }
  }

  return Array.from(headers);
}

function serializeCsvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => serializeCsvValue(item))
      .filter(Boolean)
      .join(" | ");
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function escapeCsvValue(value) {
  const normalized = String(value ?? "");
  const escaped = normalized.replaceAll('"', '""');
  return `"${escaped}"`;
}

function resolveFrom(basePath, targetPath) {
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(basePath || process.cwd(), targetPath);
}

function slugify(input) {
  return String(input)
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80);
}

module.exports = {
  ensureDir,
  slugify,
  toCsv,
  writeScrapeOutputs,
};
