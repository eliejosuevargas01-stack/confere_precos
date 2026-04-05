FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV BACKEND_PORT=3100
ENV CATALOG_API_DATA_ROOT=/app/data/catalog-api

EXPOSE 3100

CMD ["npm", "run", "start"]
