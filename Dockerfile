# Projversor demo (src/demo-projection) served as static files by nginx.

FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:projection -- --base /

FROM nginxinc/nginx-unprivileged:alpine
LABEL org.opencontainers.image.title="zartigl-projversor" \
      org.opencontainers.image.description="Projversor: GeoVideo particles on a reprojectable sphere" \
      org.opencontainers.image.source="https://github.com/fxi/zartigl" \
      org.opencontainers.image.licenses="MIT"
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist-projection /usr/share/nginx/html
EXPOSE 8080
