# Xadrez com os amigos: um container com o servidor (Node 22, TypeScript rodando direto), o front já gerado e o SQLite
# num volume em /data.
#
#   docker build -t xadrez .
#   docker run -p 3000:3000 -v xadrez-data:/data xadrez
#
# A base é fixada pelo digest do ÍNDICE multiplataforma (vale para amd64 e arm64). Para atualizar:
#   docker buildx imagetools inspect node:22-bookworm-slim | awk '/^Digest:/ {print $2; exit}'
# e troque o sha256 abaixo (ou passe --build-arg BASE_IMAGE=node:22-bookworm-slim para seguir a tag).
ARG BASE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# ---------------------------------------------------------------- front (Vite) e Stockfish
FROM ${BASE_IMAGE} AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY vite.config.ts ./
COPY shared ./shared
COPY web ./web
RUN npm run build

# ---------------------------------------------------------------- dependências de produção (chess.js e ws)
FROM ${BASE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------- imagem final
FROM ${BASE_IMAGE}
# tini: init leve que repassa o SIGTERM (o servidor fecha as conexões e o banco antes de sair).
# O npm não é usado em runtime e costuma trazer CVEs: sai da imagem.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY shared ./shared
COPY server ./server
COPY --from=web /app/web/dist ./web/dist

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/xadrez.db \
    WEB_DIR=/app/web/dist

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/main.ts"]
