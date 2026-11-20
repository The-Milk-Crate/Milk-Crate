# The worker image. Build context: deploy/aws. Node 22.18 or newer runs the TypeScript
# directly. Session G's functions come from _core/, the copy of core/src/ that
# scripts/copy-core.sh makes (stand-up.sh runs it before CDK builds this image).
# Session H's shared worker for Fly and Fargate replaces this.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY _core ./_core
COPY worker ./worker
USER node
CMD ["node", "worker/main.ts"]
