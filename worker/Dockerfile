FROM node:20-alpine

# Build deps for grpc native modules on musl
RUN apk add --no-cache python3 make g++ libc6-compat

# Distro ffmpeg/ffprobe (musl-native). ffmpeg-static / @ffprobe-installer
# ship STATIC GLIBC binaries: they execute on Alpine, but their getaddrinfo
# tries to dlopen glibc NSS modules that do not exist under musl, so every
# https input failed with "Failed to resolve hostname: System error" while
# Node's own fetch resolved the same hosts fine. The distro binaries resolve
# DNS natively and stream R2 presigned URLs without touching local disk.
# fontconfig + a real font keep the local-render fallback (libass burn-in)
# capable when no cloud render provider is configured.
RUN apk add --no-cache ffmpeg fontconfig font-noto-core

# Prefer the distro binaries (the same override mechanism the Modal apps
# use). Platform env vars set in Northflank still win over these defaults.
ENV FFMPEG_PATH_OVERRIDE=/usr/bin/ffmpeg \
    FFPROBE_PATH_OVERRIDE=/usr/bin/ffprobe

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
# ffmpeg-static ships a bundled binary; keep tmp space for processing
RUN mkdir -p /tmp/clipforge
CMD ["node", "src/index.js"]
