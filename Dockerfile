FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Copy package listing first for better caching
COPY package.json package-lock.json* ./

# Install all deps (including playwright) — image already contains browsers
RUN npm install --legacy-peer-deps

# Copy prisma schema before generating client
COPY prisma ./prisma

# Set a DATABASE_URL for SQLite (stored inside the image)
ENV DATABASE_URL="file:./prisma/dev.db"

# Generate Prisma client
RUN npm run db:generate

# Apply migrations (non-interactive) to create DB and schema
RUN npx prisma migrate deploy --schema=./prisma/schema.prisma || true

# Copy app sources
COPY . .

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
