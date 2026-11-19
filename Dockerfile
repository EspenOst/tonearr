FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=5056
COPY package.json ./
COPY src ./src
COPY public ./public
# Starts as root only to fix the owner of /data, then runs the app as "node" (see the script)
COPY docker-entrypoint.sh /usr/local/bin/tonearr-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/tonearr-entrypoint.sh \
 && chmod +x /usr/local/bin/tonearr-entrypoint.sh \
 && mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 5056
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:5056/ >/dev/null || exit 1
ENTRYPOINT ["tonearr-entrypoint.sh"]
CMD ["node", "src/server.js"]
