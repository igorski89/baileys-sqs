# Stage 1: Build
FROM node:25-alpine AS builder

WORKDIR /app

# Install git for GitHub dependencies
RUN apk add --no-cache git

# Copy package files
COPY package.json tsconfig.json ./

# Install all dependencies (including devDependencies for build)
RUN npm install

# Copy source code
COPY *.ts ./
COPY types.d.ts ./

# Build TypeScript
RUN npm run build

# Stage 2: Production
FROM node:25-alpine AS production

WORKDIR /app

# Install git for GitHub dependencies
RUN apk add --no-cache git

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package.json ./

# Install only production dependencies
RUN npm install --omit=dev && \
    npm cache clean --force

# Copy compiled output from builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

# Switch to non-root user
USER nodejs

# Set environment
ENV NODE_ENV=production

# Run the application
CMD ["node", "dist/index.js"]
