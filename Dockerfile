# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Frontend typechecking validates the shared Go response fixture.
COPY internal/httpapi/testdata/ ../internal/httpapi/testdata/
# Vite writes to ../internal/webassets/dist, which the Go stage embeds.
RUN npm run build

FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=frontend /src/internal/webassets/dist ./internal/webassets/dist
RUN mkdir -p /out/data && chmod 0750 /out/data
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/agnes-proxy ./cmd/agnes-proxy

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/agnes-proxy /agnes-proxy
COPY --from=build --chown=65532:65532 /out/data /data
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8000
USER nonroot:nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/agnes-proxy", "healthcheck", "--url", "http://127.0.0.1:8000/health"]
ENTRYPOINT ["/agnes-proxy"]
CMD ["serve"]
