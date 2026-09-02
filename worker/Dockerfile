FROM node:20-alpine
# Build deps for grpc native modules on musl
RUN apk add --no-cache python3 make g++ libc6-compat
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
# ffmpeg-static ships a bundled binary; keep tmp space for processing
RUN mkdir -p /tmp/clipforge
CMD ["node", "src/index.js"]
