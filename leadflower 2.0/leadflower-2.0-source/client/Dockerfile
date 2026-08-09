FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE=/api/v1
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run typecheck && npm run build

FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Publish index.html into the shared volume so the API can serve an article
# shell with its metadata already in the head. Done at start-up rather than at
# build time because a named volume is empty until a container writes to it.
COPY docker-entrypoint.sh /docker-entrypoint.d/40-publish-shell.sh
RUN chmod +x /docker-entrypoint.d/40-publish-shell.sh

EXPOSE 8080
