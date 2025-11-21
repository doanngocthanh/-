FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Copy package listing first for better caching
COPY package.json package-lock.json* ./

# Install all deps (including playwright) — image already contains browsers
RUN npm install --legacy-peer-deps

# Copy app sources
COPY . .

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
