# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsup src/index.ts --format esm --target node20 --clean --out-dir dist

# Runtime stage
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

# Match the host user that owns the bind-mounted workspaces tree, so the
# indexer can fs.watch + fs.read each user's JSONL files. The default
# `node` user in node:20-alpine is UID 1000; workspaces on our host are
# owned by UID 1001 (`lili`). Override with --build-arg UID/GID=... on
# other hosts.
ARG UID=1001
ARG GID=1001
RUN deluser --remove-home node \
    && addgroup --system --gid "${GID}" node \
    && adduser --system --uid "${UID}" --ingroup node --disabled-password node

USER node
CMD ["node", "dist/index.js"]
