# nginx:alpine e' multi-arch (amd64 + arm64) — funziona su Raspberry Pi 5 senza modifiche
FROM nginx:alpine

RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY app/ /usr/share/nginx/html/

EXPOSE 80
