# baileys-sqs

Baileys SQS connector - A WhatsApp Web integration using AWS SQS for bidirectional message queuing.

## Architecture

This application implements a two-queue architecture:

- **Input Queue**: Receives messages from external systems to be sent to WhatsApp
- **Output Queue**: Publishes messages received from WhatsApp to external systems

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Your System    │────▶│  Input Queue    │────▶│   WhatsApp      │
│                 │     │  (SQS)          │     │   (Baileys)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        │
┌─────────────────┐     ┌─────────────────┐             │
│  Your System    │◀────│  Output Queue   │◀────────────┘
│                 │     │  (SQS)          │
└─────────────────┘     └─────────────────┘
```

## Prerequisites

- **Node.js**: >= 25.0.0
- **npm**: >= 10.0.0
- AWS Account with SQS access (for production)
- WhatsApp Account

## Installation

```bash
# Clone the repository
git clone https://github.com/igorski89/baileys-sqs.git
cd baileys-sqs

# Install dependencies
npm install

# Build the project
npm run build
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

### Environment Variables

```env
# AWS Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key

# SQS Configuration (Required)
INPUT_QUEUE=https://sqs.us-east-1.amazonaws.com/123456789012/input-queue
OUTPUT_QUEUE=https://sqs.us-east-1.amazonaws.com/123456789012/output-queue

# Optional: override the AWS_* credentials/region/endpoint above for SQS only
# (e.g. real AWS SQS while S3 media storage points at local MinIO)
# SQS_REGION=us-east-1
# SQS_ACCESS_KEY_ID=your_access_key_id
# SQS_SECRET_ACCESS_KEY=your_secret_access_key
# SQS_ENDPOINT_URL=http://localhost:9324

# WhatsApp/Baileys Configuration
SESSION_DIR=./auth_info_baileys
LISTEN_EVENTS=*

# Optional: Pin WhatsApp Web version (skips GitHub fetch)
# Format: [major,minor,patch] as JSON array
# WHATSAPP_VERSION=[2,3000,1035194821]
```

### HTTP Input Endpoint

By default, commands are sent to WhatsApp by pushing them onto `INPUT_QUEUE`. Setting `PORT` starts an HTTP endpoint alongside the SQS poller — **it's additive, not a replacement** — so you can POST the same command payload directly instead of going through SQS:

```env
PORT=3000
AUTH_TOKEN=change_me_to_a_long_random_value
```

```bash
curl -X POST http://localhost:3000/commands \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"send_text","to":"+1234567890","text":"Hello from HTTP!"}'
```

The request body is the exact same JSON shape used for `INPUT_QUEUE` messages (`send_text`, `send_media`, `send_presence`, `send_reaction` — see [Sender](#using-the-sender-cli-tool) for the format). A `GET /health` route is also available and returns `{"ok":true,"connected":<bool>}` without requiring auth.

Since SQS doesn't guarantee ordering, sending a typing indicator (`send_presence`) and then a `send_text` reply through SQS can arrive out of order at WhatsApp. Sending both through this HTTP endpoint sequentially avoids that:

```bash
curl -X POST http://localhost:3000/commands -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"send_presence","to":"+1234567890","presence":"composing"}'

curl -X POST http://localhost:3000/commands -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"send_text","to":"+1234567890","text":"Hello from HTTP!"}'
```

`presence` must be one of `composing` (typing), `recording` (voice note), or `paused` (stop showing the indicator).

`send_reaction` reacts to a specific message with an emoji, or removes an existing reaction when `reaction` is an empty string. `message_key` is the target message's key — `{"id": ..., "remoteJid": ..., "fromMe": ...}` — as delivered on `OUTPUT_QUEUE`/webhook events (`remoteJid` defaults to `to` if omitted):

```bash
curl -X POST http://localhost:3000/commands -H "Authorization: Bearer $AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"send_reaction","to":"+1234567890","reaction":"👍","message_key":{"id":"3EB0...","fromMe":false}}'
```

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Enables the HTTP endpoint when set | disabled |
| `HTTP_HOST` | Bind address | `0.0.0.0` |
| `AUTH_TOKEN` | Bearer token required in `Authorization: Bearer <token>` | none (unauthenticated) |

> **Note:** If `AUTH_TOKEN` is not set, the endpoint accepts unauthenticated requests. Only run it without a token on a trusted network, and always set `AUTH_TOKEN` before exposing the port publicly.

### Media Storage (S3 / MinIO)

By default, incoming media attachments are inlined into outgoing queue messages as base64 data.

To upload attachments to an S3-compatible object store instead, configure an S3 bucket:

```env
S3_ENDPOINT_URL=http://localhost:9000
S3_BUCKET=baileys-sqs-media
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_FORCE_PATH_STYLE=true
```

When `S3_BUCKET` is provided, the connector uploads each attachment to the configured bucket and returns a **presigned URL** in the `_media.url` field of the outgoing message instead of `data_base64`.

> **Note:** The S3 bucket is **not** created automatically — it must already exist and the configured credentials must have write access to it.

| Variable | Description | Default |
|----------|-------------|---------|
| `S3_ENDPOINT_URL` | S3-compatible API endpoint | - |
| `S3_PUBLIC_URL` | Host used for presigned URLs (optional; falls back to `S3_ENDPOINT_URL`) | - |
| `S3_BUCKET` | Bucket name | - |
| `S3_PREFIX` | Key prefix for uploaded objects | `baileys-sqs/media` |
| `S3_REGION` | Region for the S3 client | `AWS_REGION` / `us-east-1` |
| `S3_ACCESS_KEY_ID` | Access key | `AWS_ACCESS_KEY_ID` |
| `S3_SECRET_ACCESS_KEY` | Secret key | `AWS_SECRET_ACCESS_KEY` |
| `S3_FORCE_PATH_STYLE` | Use path-style URLs (required for MinIO) | `true` when endpoint is set |
| `S3_URL_EXPIRATION_SECONDS` | Presigned URL lifetime in seconds | `604800` (7 days) |

`S3_*` and `SQS_*` credentials/region/endpoint are independent overrides of the generic `AWS_*` variables — set either, both, or neither. This lets SQS talk to real AWS while S3 points at a local MinIO instance (or vice versa) without one config clobbering the other.

#### Local Testing with MinIO

Both Docker Compose files include a ready-to-use [MinIO](https://min.io/) service:

- S3 API: http://localhost:9000
- MinIO Console: http://localhost:9001 (login: `minioadmin` / `minioadmin`)
- Preconfigured bucket: `baileys-sqs-media`

When a media message is received, the listener will display the storage type and the returned URL.

## Usage

### Local Development with Docker Compose (Recommended)

The easiest way to get started is using Docker Compose, which includes ElasticMQ (SQS-compatible local queue server):

#### Option A: Hot Reload Development (Automatic restart on code changes)

```bash
# Start with hot reloading (includes app and listener services)
docker-compose -f docker-compose.dev.yml up

# Code changes will automatically restart the application
# View app logs
docker-compose -f docker-compose.dev.yml logs -f app

# View listener logs (QR codes and pretty printed messages)
docker-compose -f docker-compose.dev.yml logs -f listener

# Stop services
docker-compose -f docker-compose.dev.yml down

# Stop and remove volumes (clears queue data and auth)
docker-compose -f docker-compose.dev.yml down -v
```

This mode:
- Mounts your source code as a volume
- Uses `ts-node-dev` to auto-restart on file changes
- Installs dependencies inside the container (including devDependencies)
- Includes a `listener` service for QR code display and message debugging
- **No need to rebuild the image after code changes**

#### Option B: Production-like Development (Requires rebuild)

```bash
# Build and run the production Docker image
docker-compose up --build

# After code changes, you must rebuild:
docker-compose down
docker-compose up --build
```

This mode:
- Uses the production multi-stage Dockerfile
- Compiles TypeScript during build
- Requires `--build` flag after code changes

Both modes will:
- Start ElasticMQ with `input-queue` and `output-queue` pre-configured
- Mount volumes for persistent WhatsApp auth and queue data

### Development (without Docker) - Recommended for First Setup

**⚠️ Important:** WhatsApp blocks connections from data center IPs (Docker containers, cloud providers). For initial QR code authentication, run locally:

```bash
# 1. Start ElasticMQ separately (in another terminal)
docker run -p 9324:9324 -p 9325:9325 \
  -v $(pwd)/elasticmq.conf:/opt/elasticmq.conf \
  softwaremill/elasticmq:latest \
  -Dconfig.file=/opt/elasticmq.conf

# 2. Set environment variables
export AWS_REGION=elasticmq
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local
export AWS_ENDPOINT_URL=http://localhost:9324
export INPUT_QUEUE=http://localhost:9324/queue/input-queue
export OUTPUT_QUEUE=http://localhost:9324/queue/output-queue
export SESSION_DIR=./auth_info_baileys

# 3. Run the main app (in one terminal)
npm run dev

# 4. Run the listener (in another terminal)
npm run listener

# 5. Scan the QR code with WhatsApp on your phone
# 6. After successful auth, you can stop and use Docker if needed
```

### Development (without Docker) - Quick

```bash
# Run with tsx (no build required)
npm run dev
```

### Production Docker

```bash
# Build the image
docker build -t baileys-sqs .

# Run with environment variables
docker run --env-file .env baileys-sqs
```

### Multi-Platform Build (amd64 + arm64)

The plain `docker build` above only produces an image for your local machine's architecture. To build and push an image that runs on both `linux/amd64` and `linux/arm64` (e.g. Intel/AMD servers and Apple Silicon/ARM), use `docker buildx`:

```bash
# One-time: create a builder that supports multi-platform output
docker buildx create --name baileys-sqs-builder --driver docker-container --use

# Build for both platforms and push the manifest list to a registry
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t <registry>/<namespace>/baileys-sqs:latest \
  --push \
  .
```

Replace `<registry>/<namespace>` with your target, e.g. `docker.io/yourusername`, `ghcr.io/yourusername`, or a private registry host. `--push` is required for multi-platform builds — the `docker` image store can't load more than one platform locally, so `-o type=docker` / the default local load won't work with `--platform` set to multiple values.

Verify the pushed manifest actually contains both platforms:

```bash
docker buildx imagetools inspect <registry>/<namespace>/baileys-sqs:latest
```

### Production with AWS SQS

Configure your `.env` with actual AWS credentials and SQS queue URLs:

```env
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
INPUT_QUEUE=https://sqs.us-east-1.amazonaws.com/123456789012/input-queue
OUTPUT_QUEUE=https://sqs.us-east-1.amazonaws.com/123456789012/output-queue
```

## Output Queue Listener

A separate listener script is included for development/debugging purposes. It connects to the output queue and provides:

1. **QR Code Rendering**: Terminal-based QR code display for easy WhatsApp authentication
2. **Pretty Printed Messages**: Formatted message display with colored output

### Using the Listener (Docker Compose - Recommended)

When using `docker-compose.dev.yml`, a dedicated `listener` service is included:

```bash
# Start all services including the listener
docker-compose -f docker-compose.dev.yml up

# View only the listener logs (for QR code and message display)
docker-compose -f docker-compose.dev.yml logs -f listener

# Or run just the listener service
docker-compose -f docker-compose.dev.yml up listener
```

The listener container will:
- Automatically connect to the ElasticMQ output queue
- Display QR codes when authentication is needed
- Pretty print all incoming/outgoing messages
- Auto-reload when you modify `listener.ts`

### Using the Listener (Local)

```bash
# Run the listener in development mode (hot reload)
npm run listener

# Or run the compiled version
npm run build
npm run listener:prod
```

### Using the Sender (CLI Tool)

A command-line tool is included to send WhatsApp messages via the input queue:

```bash
# Interactive mode - prompts for phone and message
npm run sender

# Direct mode - send immediately
npm run sender "+1234567890" "Hello, World!"

**Interactive mode example:**
```
📱 WhatsApp SQS Sender
Connected to: http://localhost:9324/queue/input-queue
Enter messages in format: "phone number" "message body"
Type "quit" or "exit" to stop

> "+1234567890" "Hello from the CLI!"
✅ Message queued: +1234567890 - "Hello from the CLI!"

> quit
👋 Goodbye!
```

**Environment Variables:**
```env
INPUT_QUEUE=http://localhost:9324/queue/input-queue
AWS_REGION=elasticmq
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local
AWS_ENDPOINT_URL=http://localhost:9324
```

### Using the Sender (Docker)

The sender is also available as a Docker service:

```bash
# Run with Docker Compose (development)
docker-compose -f docker-compose.dev.yml run --rm sender

# Or in production mode
docker-compose run --rm sender
```

**Direct mode with Docker:**
```bash
docker-compose -f docker-compose.dev.yml run --rm sender sh -c "npx tsx sender.ts '+1234567890' 'Hello from Docker!'"
```

### Features

- **QR Code Display**: When a QR code event is received, the terminal is cleared and a large QR code is displayed with instructions
- **Message Formatting**: Incoming/outgoing messages are displayed in styled boxes with:
  - Sender information
  - Timestamps
  - Message content (text, media type indicators)
  - Media attachment info
- **Connection Status**: Visual indicators for connection state changes
- **Presence Updates**: Online/offline status of contacts
- **Auto-delete**: Messages are deleted from the queue after processing

### Environment Variables

```env
AWS_REGION=us-east-1
OUTPUT_QUEUE=https://sqs.us-east-1.amazonaws.com/123456789012/output-queue
```

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run start` | Run the main application |
| `npm run dev` | Run main app in development mode with tsx |
| `npm run listener` | Run output queue listener (development) |
| `npm run listener:prod` | Run output queue listener (production) |
| `npm run sender` | Run CLI tool to send WhatsApp messages |
| `npm run sender:prod` | Run sender CLI (production) |
| `npm run clean` | Remove the `dist` directory |
| `npm test` | Run tests (placeholder) |

## Project Structure

```
baileys-sqs/
├── index.ts                       # Main application entry point (SQS + WhatsApp + media handling)
├── listener.ts                    # Output queue listener (QR renderer + pretty print)
├── sender.ts                      # CLI tool to send WhatsApp messages
├── package.json                   # Dependencies and scripts
├── tsconfig.json                  # TypeScript configuration
├── Dockerfile                     # Production multi-stage Docker build
├── Dockerfile.dev                 # Development Docker build
├── docker-compose.yml             # Production-like Docker Compose
├── docker-compose.dev.yml         # Development Docker Compose (hot reload)
├── elasticmq.conf                 # ElasticMQ queue configuration
├── .env.example                   # Environment variable template
├── .gitignore                     # Git ignore patterns
├── .dockerignore                  # Docker ignore patterns
├── LICENSE                        # MIT License
└── README.md                      # This file
```

## Technologies

- **[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)** - WhatsApp Web API (v7.0.0-rc.9)
- **[@aws-sdk/client-sqs](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sqs/)** - AWS SQS SDK v3
- **[@aws-sdk/client-s3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/)** - AWS S3 SDK v3
- **[ElasticMQ](https://github.com/softwaremill/elasticmq)** - SQS-compatible message queue for local development
- **[MinIO](https://min.io/)** - S3-compatible object storage for local media uploads
- **TypeScript** - Type-safe JavaScript
- **[tsx](https://github.com/privatenumber/tsx)** - TypeScript execution for ESM
- **Docker** - Containerization

## Troubleshooting

### QR Code Not Appearing

1. Check listener logs: `docker-compose -f docker-compose.dev.yml logs -f listener`
2. Clear auth data: `rm -rf docker-volumes/auth/*` and restart
3. Ensure `SESSION_DIR` env var matches the volume mount path
4. **Most importantly**: Make sure you're not running in Docker (see 405 error above)

### Messages Not Being Sent/Received

1. Check ElasticMQ is running: `docker-compose -f docker-compose.dev.yml logs elasticmq`
2. Verify queue URLs are correct in environment variables
3. Check AWS credentials are set (even for local ElasticMQ)
4. Check app logs: `docker-compose -f docker-compose.dev.yml logs -f app`

## License

MIT

## Author

Igor Ievsiukov <igor.ievsiukov@gmail.com>
