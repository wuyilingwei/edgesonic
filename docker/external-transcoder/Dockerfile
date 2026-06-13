# 049 — EdgeSonic external transcoder container.
#
# Self-host this image behind any container platform (Fly.io, Hetzner,
# Docker Compose). The Worker calls POST /transcode with
# `X-EdgeSonic-Container-Key`; the container fans into ffmpeg and streams
# back the encoded audio. See docs/external-transcoder.md for deploy howto.

FROM jrottenberg/ffmpeg:4.1-alpine

# jrottenberg base pre-pins ffmpeg as the ENTRYPOINT — clear it so we run node.
ENTRYPOINT []

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY app.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "app.js"]
