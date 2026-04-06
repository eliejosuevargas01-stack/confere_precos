# Confere Precos Backend

Backend de scraping de catálogos para supermercados.

Este repositório foi reduzido para backend-only. Ele:

- recebe fontes novas por API
- tenta aplicar a cidade enviada
- descobre o catálogo completo do site
- registra logs por job
- salva artefatos locais
- envia o resultado final para um webhook
- pode enviar os produtos para outro webhook em lotes

## Scripts

```bash
npm run dev
npm run start
npm run check
npm run catalog:redetop -- --city gaspar
```

## Variáveis de ambiente

Use `.env.example` como base:

```bash
BACKEND_PORT_HOST=3100
CATALOG_API_TOKEN=troque-este-token
CATALOG_API_ALLOW_ORIGIN=*
CATALOG_API_WEBHOOK_URL=https://seu-webhook.example.com/catalog
CATALOG_API_WEBHOOK_TOKEN=
CATALOG_API_PRODUCTS_WEBHOOK_URL=https://seu-webhook.example.com/products
CATALOG_API_PRODUCTS_WEBHOOK_TOKEN=
CATALOG_API_PRODUCTS_WEBHOOK_BATCH_SIZE=10
```

## API

Base local:

```text
http://localhost:3100
```

Endpoints principais:

```text
GET  /v1/health
GET  /v1/sources
GET  /v1/sources/:sourceId
POST /v1/sources
PATCH /v1/sources/:sourceId
DELETE /v1/sources/:sourceId
POST /v1/sources/:sourceId/run
POST /v1/catalog/run
POST /v1/catalog/run-batch
GET  /v1/jobs
GET  /v1/jobs/:jobId
GET  /v1/jobs/:jobId/logs
GET  /v1/jobs/:jobId/logs/stream
GET  /v1/batches
GET  /v1/batches/:batchId
GET  /v1/sources/:sourceId/jobs
GET  /v1/sources/:sourceId/catalog/latest
```

## Body de exemplo

Criar fonte:

```json
{
  "label": "SuperKoch Gaspar",
  "url": "https://www.superkoch.com.br",
  "city": "Gaspar",
  "adapterHint": "auto",
  "scheduleMinutes": 120,
  "maxSections": 6,
  "maxPagesPerSection": 4,
  "maxItemsPerPage": 250,
  "enabled": true
}
```

Rodar job:

```json
{
  "wait": false,
  "reason": "n8n"
}
```

Rodar lote sequencial:

```json
{
  "label": "Lote Gaspar",
  "city": "Gaspar",
  "adapterHint": "auto",
  "maxSections": 20,
  "maxPagesPerSection": 12,
  "maxItemsPerPage": 500,
  "workerCount": 3,
  "headless": true,
  "wait": false,
  "reason": "api",
  "items": [
    { "label": "SuperKoch", "url": "https://www.superkoch.com.br" },
    { "label": "Komprao", "url": "https://www.komprao.com.br" },
    { "label": "Rede Top", "url": "https://www.redetoponline.com.br" }
  ]
}
```

## Cidade por API

O campo `city` é usado de forma ativa.

O backend tenta:

- encontrar seletor de cidade, loja, unidade ou retirada
- aplicar a cidade via clique, modal, select, cookie ou URL
- continuar o scraping já no contexto da cidade resolvida

Os resultados incluem:

- `requestedCity`
- `effectiveCity`
- `storeLabel`
- `cityCoverage`
- `cityEligible`
- `contextUrl`

## Logs

Cada job salva logs `ndjson` e expõe leitura incremental:

```bash
GET /v1/jobs/:jobId/logs?after=0&limit=50
```

Os logs mostram:

- início do job
- estratégia de cidade tentada
- se a cidade foi aplicada ou não
- descoberta de raiz do catálogo
- seções/departamentos encontrados
- quantidade de produtos por página
- sucesso ou falha do webhook

## Webhook

Quando um job termina, o backend envia um POST para `CATALOG_API_WEBHOOK_URL`.

O payload inclui:

- `event`
- `jobId`
- `sourceId`
- `sourceUrl`
- `status`
- `catalogDetected`
- `requestedCity`
- `effectiveCity`
- `storeLabel`
- `cityCoverage`
- `cityEligible`
- `contextUrl`
- `metrics`
- `artifactUrls`

## Webhook de produtos

Se `CATALOG_API_PRODUCTS_WEBHOOK_URL` estiver configurado, cada job concluído com produtos envia lotes em JSON.

- cada chamada envia um array
- o tamanho padrão do lote é `10`
- o tamanho pode ser alterado por `CATALOG_API_PRODUCTS_WEBHOOK_BATCH_SIZE`
- também é possível definir `productsWebhookUrl`, `productsWebhookToken` e `productsWebhookBatchSize` por fonte ou por request

Cada item do array repete o contexto do job e traz os campos do produto no mesmo objeto.

## Deploy com Docker

O repositório já está pronto para deploy backend-only.

Subida local ou VPS:

```bash
cp .env.example .env
docker compose --env-file .env -f docker-compose.selfhosted.yml up -d --build
```

Validação:

```bash
curl http://localhost:3100/v1/health
docker compose --env-file .env -f docker-compose.selfhosted.yml logs -f
```

## Coolify

Configuração recomendada:

- `Build Pack`: Dockerfile
- `Dockerfile Location`: `./Dockerfile`
- `Port`: `3100`

Volumes persistentes:

- `/app/data`
- `/app/output`

Health check:

- `/v1/health`

## Estrutura principal

- [Dockerfile](/home/eliezer/Escritorio/scrapping_supermercados/Dockerfile)
- [docker-compose.selfhosted.yml](/home/eliezer/Escritorio/scrapping_supermercados/docker-compose.selfhosted.yml)
- [src/backend/server.js](/home/eliezer/Escritorio/scrapping_supermercados/src/backend/server.js)
- [src/lib/catalog-backend-service.js](/home/eliezer/Escritorio/scrapping_supermercados/src/lib/catalog-backend-service.js)
- [src/lib/intelligent-catalog-scraper.js](/home/eliezer/Escritorio/scrapping_supermercados/src/lib/intelligent-catalog-scraper.js)
- [src/lib/city-context-discovery.js](/home/eliezer/Escritorio/scrapping_supermercados/src/lib/city-context-discovery.js)
