# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Build metadata (optional)
ARG GIT_REF=""
ARG BUILD_DATE=""
LABEL org.opencontainers.image.revision=$GIT_REF \
      org.opencontainers.image.created=$BUILD_DATE

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node src ./src
COPY --chown=node:node config.example.yaml ./config.example.yaml
COPY --chown=node:node package.json ./package.json

# /app/data n'est utile que si aucun volume n'est monté dessus (docker-compose.yml
# monte ./data:/app/data, ce qui écrase ce chown par celui du dossier hôte — voir
# README pour l'ajuster si besoin).
RUN mkdir -p /app/data && chown node:node /app/data

USER node

CMD ["node", "src/index.js"]
