# Projversor demo (src/demo-projection) and its story
# (src/demo-story-projversor, at /story/) served as static files by nginx.

FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:projection -- --base / \
 && npm run build:story-projversor -- --base /story/

FROM nginxinc/nginx-unprivileged:alpine-slim
LABEL org.opencontainers.image.title="zartigl-projversor" \
      org.opencontainers.image.description="Projversor: GeoVideo particles on a reprojectable sphere" \
      org.opencontainers.image.source="https://github.com/fxi/zartigl" \
      org.opencontainers.image.licenses="MIT"
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist-projection /usr/share/nginx/html
COPY --from=build /app/dist-story-projversor /usr/share/nginx/html/story
EXPOSE 8080
