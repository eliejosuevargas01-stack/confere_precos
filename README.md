# Scraper com navegador real

Este projeto usa o Playwright para abrir um navegador de verdade, renderizar JavaScript, interagir com a página e só então extrair os dados. Isso resolve o caso em que o conteúdo aparece depois de chamadas XHR/fetch, hidratação de SPA ou injeção via JavaScript.

## O que ele faz

- abre Chromium, Firefox ou WebKit
- espera a página renderizar
- executa ações como clique, digitação, hover, scroll e espera por seletor
- extrai texto, atributos e listas depois do render
- salva screenshot e HTML final renderizado para depuração

## Instalação

```bash
npm install
npm run install:browser
```

## Uso

Execute com um arquivo JSON de configuração:

```bash
npm run scrape -- examples/quotes-js.json
```

Se quiser ver o navegador abrindo de forma visual:

```bash
npm run scrape -- examples/quotes-js.json --headless false
```

Se quiser sobrescrever a URL sem editar o arquivo:

```bash
npm run scrape -- examples/quotes-js.json --url https://quotes.toscrape.com/js/
```

Para un supermercado, usa el template:

```bash
npm run scrape -- examples/supermercado-template.json
```

## Investigação Automática De Novos Links

Se você quer colar URLs novas sem montar JSON manual, use o modo automático:

```bash
npm run auto
```

Por padrão ele lê o arquivo `links.txt`, investiga cada domínio e tenta extrair produtos por duas vias:

- respostas JSON capturadas na rede
- cards de produto detectados no DOM renderizado

Se você adicionar um link novo em `links.txt`, basta rodar de novo.

Também pode passar URLs direto na linha de comando:

```bash
npm run auto -- https://www.superkoch.com.br https://www.redetoponline.com.br
```

Opções úteis:

```bash
npm run auto -- --headless false
npm run auto -- --query arroz
npm run auto -- --refresh-profile
npm run auto -- --stdout
```

O modo automático salva:

- perfil reutilizável por domínio em `profiles/*.json`
- JSON e CSV em `output/auto-runs/<timestamp>-<dominio>/`
- screenshot e HTML renderizado da melhor página encontrada

## Comparativo De Precos Por Cidade

Para comparar os itens essenciais entre os sites monitorados e respeitar a cidade do usuario quando o site permite trocar a loja:

```bash
npm run compare -- --city gaspar
```

Tambem pode limitar os produtos e os sites:

```bash
npm run compare -- --city gaspar --products arroz,feijao,papel_higienico
npm run compare -- --city gaspar https://www.superkoch.com.br https://www.mercadofelisbino.com.br
```

Opcoes uteis:

```bash
npm run compare -- --file links.txt
npm run compare -- --headless false
npm run compare -- --max-items 120
npm run compare -- --stdout
```

Saidas do comparativo:

- `comparison.json`: resultado completo por site, cidade e produto
- `comparisons.csv`: uma linha por item essencial em cada site comparavel
- `best-offers.csv`: melhor oferta elegivel por item
- `site-status.csv`: status de cobertura, cidade e suporte de cada dominio

Modelo atual dos adapters:

- `superkoch.com.br`: troca automatica de loja por cidade usando o seletor do proprio site
- `mercadofelisbino.com.br`: cidade fixa em Gaspar e busca direta por `listar.php?filtro=...`
- `redetoponline.com.br`: busca estruturada por termo e cidade fixa detectada pelo rodape
- `komprao.com.br`: leitura automatica do encarte por cidade via `Issuu/SVG`, com extracao de nome, preco e promocao a partir do folheto

Observacoes do `komprao`:

- o comparativo funciona melhor quando `--city` e informado, porque o encarte fica em `https://www.komprao.com.br/ofertas/<cidade>`
- quando o encarte traz dois precos no mesmo bloco, o comparador usa o menor como oferta atual e o maior como preco original
- se alguma publicacao do Issuu responder com `403`, ela aparece no `site-status.csv`, mas as demais publicacoes da cidade continuam sendo processadas

## Vitrine Salva Para Usuario Final

Gera o snapshot em arquivo com os produtos comparados de forma exata:

```bash
npm run storefront:refresh -- --city gaspar
```

Esse comando salva:

- `data/storefront/latest.json`: vitrine pronta para o frontend
- `data/storefront/raw/latest-comparison.json`: comparacao bruta por site/produto
- `data/storefront/raw/latest-exact.json`: agrupamento exato por marca/embalagem
- `data/storefront/raw/latest-catalog.json`: catalogo completo agrupado para a vitrine
- historico em `data/storefront/history/`

Opcoes uteis:

```bash
npm run storefront:refresh -- --city gaspar --interval 120
npm run storefront:refresh -- --file links.txt --max-items 80
npm run storefront:refresh -- --stdout
```

Para manter isso rodando em lote, voce pode:

- subir o servidor web, que agenda uma nova rodada automaticamente
- ou chamar `npm run storefront:refresh` via `cron` a cada 1h ou 2h

## Interface Visual

Levanta la interfaz local:

```bash
npm run web
```

Luego abre:

```text
http://localhost:3000
```

Desde essa tela você pode:

- abrir uma vitrine pronta com os dados do ultimo snapshot salvo
- ver cards por categoria com imagem, loja mais barata e lista de ofertas por rede
- detectar a cidade do usuario pelo navegador e carregar a vitrine dessa cidade
- manter snapshots separados por cidade em disco
- navegar sem esperar uma comparacao ao vivo terminar

Como funciona:

- só entra no painel quando o produto tem assinatura compatível entre lojas
- a assinatura considera nome normalizado, marca/variante no texto e embalagem
- itens ambíguos como `ou`, `sabores`, múltiplas embalagens ou encartes misturados ficam de fora
- a home lê o snapshot da cidade em `data/storefront/<cidade-slug>/latest.json` e o servidor agenda novas rodadas por padrão a cada `120` minutos

Localizacao do usuario:

- o frontend tenta detectar a geolocalizacao do navegador em `localhost`
- o backend resolve a cidade e passa a usar `/api/storefront?city=<cidade>`
- os snapshots ficam separados por cidade em `data/storefront/<cidade-slug>/latest.json`
- se a localizacao nao estiver disponivel, a aplicacao cai na cidade padrao configurada

## Rodar Sem Depender Do Seu Computador

Se o objetivo e parar de usar a sua maquina local como servidor, o caminho mais simples e:

- subir a aplicacao em um container na nuvem ou VPS
- deixar o proprio servidor gerando snapshots automaticamente
- usar o `n8n` apenas para disparar atualizacoes ou alertas, sem rodar o scraping pesado dentro dele

Arquivos prontos para isso:

- `Dockerfile`: imagem da aplicacao com Playwright/Chromium
- `docker-compose.selfhosted.yml`: sobe a aplicacao e, opcionalmente, um `n8n` self-hosted

### Subir so a aplicacao

```bash
docker compose -f docker-compose.selfhosted.yml up -d marketwatch
```

### Subir aplicacao + n8n

```bash
docker compose -f docker-compose.selfhosted.yml --profile automation up -d
```

Endpoints uteis:

- `GET /api/health`: status geral da aplicacao
- `GET /api/storefront?city=Gaspar`: le o snapshot salvo de uma cidade
- `POST /api/storefront/refresh`: dispara uma nova rodada de atualizacao

Se definir `STOREFRONT_REFRESH_TOKEN`, o endpoint de refresh exige:

```http
Authorization: Bearer <seu-token>
```

Exemplo direto:

```bash
curl -X POST "http://localhost:3000/api/storefront/refresh?city=Gaspar&wait=false" \
  -H "Authorization: Bearer troque-este-token" \
  -H "Content-Type: application/json"
```

### Fluxo recomendado com n8n

No `n8n`, o fluxo ideal e:

1. `Schedule Trigger`
2. `HTTP Request`
3. opcionalmente `IF` / `Slack` / `Telegram` / `Email`

Configuracao do `HTTP Request`:

- `Method`: `POST`
- `URL`: `http://marketwatch:3000/api/storefront/refresh?city=Gaspar&wait=false`
- `Header`: `Authorization: Bearer <seu-token>`

Assim o `n8n` so agenda e monitora. O scraping continua rodando na aplicacao, com Playwright, snapshots e persistencia proprios.

## Teste Rápido De Um Site

Para validar um site específico antes de montar os seletores finais:

```bash
npm run probe -- --url https://site.com
```

Se você já souber um seletor que só aparece depois do JavaScript:

```bash
npm run probe -- --url https://site.com --selector ".produto-card" --waitMs 3000 --scroll
```

Esse comando salva:

- screenshot da página renderizada
- HTML final após execução do JavaScript
- JSON com título, URL final e texto visível da página

Os arquivos ficam em `output/probes/<slug-do-site>/`.

## Estrutura da configuração

```json
{
  "browser": "chromium",
  "headless": true,
  "url": "https://site.com",
  "waitUntil": "networkidle",
  "extraWaitMs": 2000,
  "actions": [
    { "type": "waitForSelector", "selector": ".card" },
    { "type": "click", "selector": "#aceitar-cookies", "postDelayMs": 1000 },
    { "type": "fill", "selector": "input[name=q]", "value": "arroz" },
    { "type": "press", "selector": "input[name=q]", "key": "Enter" },
    { "type": "scroll", "pixels": 1200, "times": 4, "delayMs": 1000 }
  ],
  "extract": {
    "pageText": true,
    "fields": {
      "title": { "type": "pageTitle" }
    },
    "collection": {
      "selector": ".produto",
      "fields": {
        "nome": { "selector": ".nome", "type": "text" },
        "preco": { "selector": ".preco", "type": "text" },
        "link": { "selector": "a", "type": "href" },
        "imagem": { "selector": "img", "type": "src" }
      }
    }
  },
  "output": {
    "jsonPath": "output/produtos.json",
    "csvPath": "output/produtos.csv",
    "htmlPath": "output/produtos.html",
    "screenshotPath": "output/produtos.png"
  }
}
```

## Ações suportadas

- `wait`
- `waitForSelector`
- `click`
- `fill`
- `type`
- `press`
- `hover`
- `scroll`

## Tipos de extração suportados

- `text`
- `html`
- `href`
- `src`
- `attribute`
- `exists`
- `pageTitle`
- `pageUrl`

## Observações práticas

- Para páginas dinâmicas, use `waitUntil: "networkidle"` ou uma ação `waitForSelector`.
- Para conteúdo lazy-load, adicione ações de `scroll`.
- Para depurar diferença entre DOM inicial e DOM final, compare o `output/*.html` com o HTML original da requisição.
- Isso simula navegação de navegador real, mas não inclui bypass de CAPTCHA ou mecanismos explícitos de antifraude.
- Si `output.csvPath` está definido y `extract.collection.items` existe, el scraper genera una planilla CSV lista para abrir en Excel o LibreOffice.
