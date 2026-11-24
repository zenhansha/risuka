# The Playwright image already contains Chromium and every library it needs (amd64 and arm64).
# Keep this tag equal to the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    PORT=8080 \
    ORBIT_DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src

RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
EXPOSE 8080
CMD ["node", "src/index.js"]
