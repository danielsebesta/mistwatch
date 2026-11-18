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
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# MISTWATCH_HOST lets the server accept connections through a published port. Publish it on 127.0.0.1 only.
ENV MISTWATCH_HOME=/data MISTWATCH_NO_KEYRING=1 MISTWATCH_HOST=0.0.0.0
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["serve"]
