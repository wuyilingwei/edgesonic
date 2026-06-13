# 049 — Sandbox SDK transcoder image.
#
# jrottenberg/ffmpeg:4.1-alpine ships precompiled ffmpeg 4.1 with libmp3lame,
# libopus, libvorbis and aac, which covers every entry in DEFAULT_PROFILES.
# We layer Node 18 on top + a thin HTTP entry that spawns ffmpeg per request
# and pipes the audio through. Image weighs ~150-200 MB.
#
# Sandbox SDK boots the container, then a Durable Object owns its lifecycle.
# The entrypoint MUST stay listening on PORT (default 8080) so getSandbox()
# can call exposePort and forward HTTP into it.

FROM jrottenberg/ffmpeg:4.1-alpine

# jrottenberg base sets `ENTRYPOINT ["ffmpeg"]` — clear it so we can run node.
ENTRYPOINT []

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY app.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "app.js"]
