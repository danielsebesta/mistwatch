FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . ./
RUN npm run build
FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
ENV MISTWATCH_HOME=/data MISTWATCH_NO_KEYRING=1
VOLUME /data
ENTRYPOINT ["node", "dist/cli.js"]
