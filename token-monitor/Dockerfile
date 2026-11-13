# Token monitor for Claude Code: small, non-root, read-only friendly image.
FROM node:22.11.0-alpine3.20

# Python + openpyxl only for the Excel export; tzdata so TZ works for daily grouping.
RUN apk add --no-cache python3 py3-openpyxl tzdata

WORKDIR /app
# Owned by root and not writable by the runtime user.
COPY server.js index.html export_excel.py pricing.json ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    TOKEN_MONITOR_ROOT=/data/projects \
    TOKEN_MONITOR_DATA=/state \
    TOKEN_MONITOR_OUT=/out \
    TZ=UTC

# Mount points: transcripts (read-only), calibration state, Excel output.
RUN mkdir -p /data/projects /state /out && chown node:node /state /out
VOLUME ["/state", "/out"]

USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4317/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
