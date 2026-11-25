# syntax=docker/dockerfile:1.7

# The console is plain HTML/CSS/JavaScript rendered by a dependency-free Node
# build. No npm installation is required for the production asset build.
FROM node:24-bookworm-slim AS frontend
WORKDIR /src
COPY frontend ./frontend
RUN node frontend/scripts/build.mjs

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
