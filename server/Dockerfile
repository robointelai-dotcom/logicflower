FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 logicflower \
  && useradd --system --uid 10001 --gid logicflower --home-dir /app logicflower \
  && mkdir -p /var/lib/logicflower/artifacts \
  && chown -R logicflower:logicflower /var/lib/logicflower/artifacts
COPY --from=build --chown=logicflower:logicflower /app/node_modules ./node_modules
COPY --from=build --chown=logicflower:logicflower /app/dist ./dist
COPY --from=build --chown=logicflower:logicflower /app/package.json ./package.json
VOLUME ["/var/lib/logicflower/artifacts"]
USER logicflower
EXPOSE 4000
CMD ["node", "dist/src/index.js"]
