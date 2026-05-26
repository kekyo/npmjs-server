ARG NODE_IMAGE=node:24-trixie-slim

# Stage 1: Install production dependencies on Debian/glibc
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev && \
    npm cache clean --force && \
    rm -rf /tmp/*

COPY dist ./dist

# Stage 2: Runtime image on Debian/glibc
FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

RUN groupadd --gid 1001 npmjsserver && \
    useradd --uid 1001 --gid npmjsserver --create-home --shell /usr/sbin/nologin npmjsserver

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN mkdir -p /packages /data && \
    chown -R npmjsserver:npmjsserver /app && \
    chown -R npmjsserver:npmjsserver /packages && \
    chown -R npmjsserver:npmjsserver /data

USER npmjsserver

EXPOSE 4873

#HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
#  CMD ["node", "-e", "fetch('http://localhost:4873/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

VOLUME ["/packages", "/data"]

CMD ["node", "dist/cli.mjs", "--config-file", "/data/config.json", "--package-dir", "/packages"]
