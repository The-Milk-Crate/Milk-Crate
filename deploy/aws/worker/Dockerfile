# The worker image. Build context: deploy/aws. Node 22.18 or newer runs the TypeScript
# directly. Session G's functions come from _core/ (a copy of core/src/) and session H's
# processing step from _worker/ (a copy of worker/src/); scripts/copy-core.sh makes both
# (stand-up.sh runs it before CDK builds this image).
# The base image and the ffmpeg line are the same in both platforms' Dockerfiles; a test in
# worker/test/ fails if they drift apart. The processing step runs ffmpeg and ffprobe.
FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY _core ./_core
COPY _worker ./_worker
COPY worker ./worker
USER node
CMD ["node", "worker/main.ts"]
