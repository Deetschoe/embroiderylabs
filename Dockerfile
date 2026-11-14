# Static site: no Python, no build step. Everything runs in the visitor's browser.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html app.html market.html profile.html emb.png /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
COPY mockups /usr/share/nginx/html/mockups
COPY designs /usr/share/nginx/html/designs

EXPOSE 8000
