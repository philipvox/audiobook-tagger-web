# Audiobook Tagger — Self-hosted Web Version
# 100% client-side static site. No backend needed.
#
# Build:   docker build -t audiobook-tagger .
# Run:     docker run -d -p 8080:80 --name audiobook-tagger audiobook-tagger
# Access:  http://localhost:8080
#
# For Unraid: Add as a Docker container, map port 80 to your preferred port.
# Note: When self-hosting over HTTP, your ABS server can also be HTTP (no mixed content issue).

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src/ src/
COPY index.html vite.config.js tailwind.config.js postcss.config.js ./
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# SPA fallback + security headers
RUN printf 'server {\n\
    listen 80;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    add_header X-Content-Type-Options "nosniff" always;\n\
    add_header X-Frame-Options "DENY" always;\n\
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
