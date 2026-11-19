# Membrane 单文件记忆引擎；数据用 volume 持久化，不要把 db 打进镜像。
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY web ./web
ENV MEMBRANE_DB=/data/membrane.db \
    MEMBRANE_HOST=0.0.0.0 \
    MEMBRANE_PORT=8317
EXPOSE 8317
VOLUME ["/data"]
CMD ["node", "dist/cli.js", "serve"]
