# Confere Precos

Proyecto con frontend y backend de scraping ahora desacoplados.

## Scripts

Frontend:

```bash
npm run frontend:dev
npm run frontend:build
npm run frontend:start
```

Backend de catálogo:

```bash
npm run backend:dev
npm run backend:start
```

Deploy backend-only com Docker:

```bash
cp .env.backend.example .env.backend
docker compose --env-file .env.backend -f docker-compose.backend.yml up -d --build
```

Modo legado acoplado:

```bash
npm run dev
```

## Backend API

Puerto por defecto:

```text
http://localhost:3100
```

Variables útiles:

```bash
BACKEND_PORT=3100
CATALOG_API_TOKEN=troque-este-token
CATALOG_API_DATA_ROOT=data/catalog-api
CATALOG_API_ALLOW_ORIGIN=*
CATALOG_API_WEBHOOK_URL=https://seu-webhook.example.com/catalog
CATALOG_API_WEBHOOK_TOKEN=opcional
```

## Instalar solo el backend en una VPS

Archivos de deploy:

- `Dockerfile.backend`
- `docker-compose.backend.yml`
- `.env.backend.example`

Pasos:

1. Instalar Docker y Docker Compose en la VPS.
2. Clonar el repositorio.
3. Copiar el archivo de entorno:

```bash
cp .env.backend.example .env.backend
```

4. Ajustar al menos:

- `CATALOG_API_TOKEN`
- `CATALOG_API_WEBHOOK_URL`
- `CATALOG_API_WEBHOOK_TOKEN` si tu webhook exige token
- `BACKEND_PORT_HOST` si no quieres exponer `3100`

5. Subir el backend:

```bash
docker compose --env-file .env.backend -f docker-compose.backend.yml up -d --build
```

6. Validar:

```bash
curl http://localhost:3100/v1/health
docker compose --env-file .env.backend -f docker-compose.backend.yml logs -f
```

El backend queda en modo worker:

- recibe URLs nuevas por API
- intenta posicionarse en la ciudad enviada
- descarga el catálogo
- escribe logs locales
- envía el resultado al webhook configurado

## Endpoints principales

Health:

```bash
GET /v1/health
```

Listar fuentes:

```bash
GET /v1/sources
```

Crear fuente nueva por API:

```bash
POST /v1/sources
Authorization: Bearer <TOKEN>
Content-Type: application/json
```

Body ejemplo:

```json
{
  "label": "Rede Top Gaspar",
  "url": "https://www.redetoponline.com.br",
  "city": "Gaspar",
  "adapterHint": "redetop-full",
  "scheduleMinutes": 180,
  "maxSections": 10,
  "maxPagesPerSection": 8,
  "maxItemsPerPage": 250,
  "enabled": true
}
```

El campo `city` ahora se usa de forma activa:

- el backend intenta encontrar el selector de ciudad/loja/unidade del sitio
- si el sitio cambia por cookie, mantiene esa sesion para el scraping
- si el sitio cambia por URL, el scraping continua desde la URL resuelta de esa ciudad
- en la salida quedan `requestedCity`, `effectiveCity`, `storeLabel`, `cityCoverage` y `cityEligible`

Actualizar fuente:

```bash
PATCH /v1/sources/:sourceId
```

Eliminar fuente:

```bash
DELETE /v1/sources/:sourceId
```

Disparar scraping de una fuente:

```bash
POST /v1/sources/:sourceId/run
Authorization: Bearer <TOKEN>
Content-Type: application/json
```

Body:

```json
{
  "wait": false,
  "reason": "n8n"
}
```

Run ad-hoc sin guardar fuente:

```bash
POST /v1/catalog/run
Authorization: Bearer <TOKEN>
Content-Type: application/json
```

Consultar jobs:

```bash
GET /v1/jobs
GET /v1/jobs/:jobId
GET /v1/jobs/:jobId/logs
GET /v1/jobs/:jobId/logs/stream
GET /v1/sources/:sourceId/jobs
```

Último catálogo de una fuente:

```bash
GET /v1/sources/:sourceId/catalog/latest
```

Artefactos servidos por HTTP:

```text
/artifacts/backend/...
```

Los jobs ahora incluyen `artifactUrls.logs` con el archivo `ndjson` de logs del scraping.

## Ejemplo n8n

1. `HTTP Request` para crear o actualizar la fuente.
2. `HTTP Request` a `POST /v1/sources/:sourceId/run` con `wait=false`.
3. Guardar el `job.id`.
4. Hacer polling a `GET /v1/jobs/:jobId/logs` para ver el descubrimiento en curso.
5. Hacer polling a `GET /v1/jobs/:jobId`.
6. Cuando el estado sea `completed`, usar `artifactUrls.csv` o `artifactUrls.json`.
7. Si `CATALOG_API_WEBHOOK_URL` está configurado, el backend también enviará el resultado final automáticamente.

Ejemplo de lectura incremental de logs:

```bash
GET /v1/jobs/:jobId/logs?after=10&limit=50
```

Los logs informan, entre otras cosas:

- si la URL fue aceptada y el job inició
- qué estrategia de ciudad se intentó y si la ciudad quedó aplicada
- si el sistema detectó catálogo o no
- qué raíz, departamentos o secciones eligió
- cuántos productos encontró por página
- si la descarga terminó bien o falló
- si el webhook fue notificado correctamente

## Scraping de catálogo completo

El backend nuevo intenta encontrar el catálogo detallado y no quedarse solo con promociones de home.

Estrategia:

- intenta posicionar la sesion en la ciudad enviada por API
- combina handlers específicos por sitio con heurísticas genéricas de ciudad
- detecta si existe un adapter específico por sitio
- intenta descubrir páginas de catálogo, categorías o departamentos
- recorre secciones y paginación
- guarda el catálogo completo en disco
- expone `JSON`, `CSV` y resumen por API
- escribe logs de descubrimiento por job
- puede notificar un webhook al completar o fallar

Adapter específico ya validado:

- `redetoponline.com.br`

Salida persistida:

```text
data/catalog-api/catalogs/<sourceId>/<timestamp>/
```

## VPS

Playwright corre en modo headless. No necesita entorno gráfico, pero sí un sistema operativo Linux o un contenedor con las dependencias del navegador.

Archivos disponibles:

- [Dockerfile](/home/eliezer/Escritorio/scrapping_supermercados/Dockerfile)
- [docker-compose.selfhosted.yml](/home/eliezer/Escritorio/scrapping_supermercados/docker-compose.selfhosted.yml)
