FROM node:20-alpine
# redis-server runs alongside the API so the free plan doesn't need a
# separate Redis service. Ephemeral by design: queued jobs are lost on
# redeploy, which is acceptable for the pipeline queue.
RUN apk add --no-cache redis
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY start.sh ./start.sh
RUN chmod +x ./start.sh
EXPOSE 4000 6379
CMD ["./start.sh"]
