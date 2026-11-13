# The worker image. Build context: deploy/aws. Node 22.18 or newer runs the TypeScript
# directly. Nothing from core/ is needed at run time (only its types are imported).
# Session H's shared worker for Fly and Fargate replaces this.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY worker ./worker
USER node
CMD ["node", "worker/main.ts"]
