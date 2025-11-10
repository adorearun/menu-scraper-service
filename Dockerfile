FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
  libnss3 libasound2 libatk-bridge2.0-0 libatk1.0-0 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcups2 \
  libx11-6 libx11-xcb1 libxcb1 libxcursor1 libxi6 libgtk-3-0 libxrender1 libxext6 \
  libpangocairo-1.0-0 libatspi2.0-0 fonts-liberation libpcre2-16-0 wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
RUN npx playwright install --with-deps
COPY server.mjs ./server.mjs
ENV PORT=8080
EXPOSE 8080
CMD ["node","server.mjs"]
