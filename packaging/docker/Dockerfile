# syntax=docker/dockerfile:1
# Branch Agent's container image. Written by src/install/container-files.ts; do not edit by hand.
#   docker build -f packaging/docker/Dockerfile -t branch-agent .
#   docker run --network host -v branch-data:/data -v branch-work:/workspace branch-agent
# The engine listens on 127.0.0.1:3210 inside the container only; see docs/configuration.md.
FROM node:24-bookworm-slim AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY data ./data
COPY docs/handbook ./docs/handbook
COPY public ./public
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ENV NODE_ENV=production BRANCH_DATA_DIR=/data BRANCH_WORKSPACE=/workspace \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN groupadd --system branch \
 && useradd --system --gid branch --home-dir /data --shell /usr/sbin/nologin branch \
 && mkdir -p /data /workspace && chown branch:branch /data /workspace
WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/public ./public
COPY LICENSE README.md THIRD_PARTY_NOTICES.md ./
USER branch
VOLUME ["/data", "/workspace"]
EXPOSE 3210
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3210/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["start"]
