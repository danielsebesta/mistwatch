FROM node:24-alpine AS build
WORKDIR /app/ts
COPY ts/package.json ts/package-lock.json ./
RUN npm ci
COPY ts/ ./
RUN npm run build
FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/ts/dist ./dist
COPY --from=build /app/ts/package.json ./
ENV MISTWATCH_HOME=/data MISTWATCH_NO_KEYRING=1
VOLUME /data
ENTRYPOINT ["node", "dist/cli.js"]
