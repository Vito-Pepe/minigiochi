# node:alpine e' multi-arch (amd64 + arm64) — funziona su Raspberry Pi 5 senza modifiche
FROM node:22-alpine

WORKDIR /app
COPY server.js ./

# /data: giochi caricati (volume condiviso con nginx). /state: codici dei link (privato).
# Dell'utente "node", così i volumi sono scrivibili.
RUN mkdir -p /data /state /repo && chown node:node /data /state

ENV NODE_ENV=production DATA_DIR=/data STATE_DIR=/state REPO_DIR=/repo PORT=3000 PUBLIC_PORT=3001
USER node
VOLUME /data /state
# 3000 = gestione (solo da nginx), 3001 = giochi pubblici tramite link
EXPOSE 3000 3001
CMD ["node", "server.js"]
