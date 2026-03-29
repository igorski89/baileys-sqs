# baileys-sqs

Baileys SQS connector - A WhatsApp Web integration using AWS SQS for bidirectional message queuing.

> ⚠️ **Important:** WhatsApp blocks Docker connections (405 error). For initial setup and QR code scanning, you **must** run locally without Docker. See [Troubleshooting](#connection-failure-405-error---most-common-issue) for details.

## Architecture

This application implements a two-queue architecture:

- **Input Queue**: Receives messages from external systems to be sent to WhatsApp
- **Output Queue**: Publishes messages received from WhatsApp to external systems

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Your System    │────▶│  Input Queue    │────▶│   WhatsApp      │
│                 │     │  (SQS)          │     │   (Baileys)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                              ▲                         │
                              │                         │
┌─────────────────┐     ┌─────┴───────────┐             │
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
git clone <repository-url>
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

# WhatsApp/Baileys Configuration
SESSION_DIR=./auth_info_baileys
BASE64_MEDIA=true
LISTEN_EVENTS=*
```

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

# Or with spaces in message
npm run sender "+1234567890" "How are you today?"
```

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
├── index.ts                       # Main application entry point
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
- **[ElasticMQ](https://github.com/softwaremill/elasticmq)** - SQS-compatible message queue for local development
- **TypeScript** - Type-safe JavaScript
- **tsx](https://github.com/privatenumber/tsx)** - TypeScript execution for ESM
- **Docker** - Containerization

## Baileys v7.0 Migration Notes

This project has been migrated to Baileys v7.0.0-rc.9 which includes significant changes:

### ESM-Only Module System
Baileys 7.0 is now ESM-only. This project has been converted to use ES modules:
- `"type": "module"` in `package.json`
- Uses `tsx` for TypeScript execution (replaces ts-node)
- Compatible with Node.js native ESM

### LID (Local Identifier) System
WhatsApp now assigns LIDs to users for privacy. The auth state has been updated to support:
- `lid-mapping` - Maps phone numbers to LIDs
- `device-list` - Device pairing information
- `tctoken` - Token information

For more details, see the [Baileys v7.0 Migration Guide](https://baileys.wiki/docs/migration/to-v7.0.0/).

## Troubleshooting

### Connection Failure (405 Error) - Most Common Issue

If you see `Connection Failure (Code: 405)` in the logs, **WhatsApp is blocking your connection**. This is **not a bug** - it's WhatsApp's anti-spam protection.

**Why this happens:**
- Docker containers use data center IPs that WhatsApp flags as suspicious
- Cloud providers (AWS, GCP, Azure) have IPs that are commonly blocked
- Running from a VPN or proxy may also trigger this

**Solution - Run Locally (Required for QR Code):**

You **must** run the app locally (not in Docker) for the initial authentication:

```bash
# Terminal 1: Start ElasticMQ
docker run -p 9324:9324 -p 9325:9325 \
  -v $(pwd)/elasticmq.conf:/opt/elasticmq.conf \
  softwaremill/elasticmq:latest \
  -Dconfig.file=/opt/elasticmq.conf

# Terminal 2: Run the app locally
export AWS_REGION=elasticmq
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local
export AWS_ENDPOINT_URL=http://localhost:9324
export INPUT_QUEUE=http://localhost:9324/queue/input-queue
export OUTPUT_QUEUE=http://localhost:9324/queue/output-queue
export SESSION_DIR=./auth_info_baileys
npm run dev

# Terminal 3: Run the listener locally
export AWS_REGION=elasticmq
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local
export AWS_ENDPOINT_URL=http://localhost:9324
export OUTPUT_QUEUE=http://localhost:9324/queue/output-queue
npm run listener
```

After successfully scanning the QR code and authenticating, you can stop the local run and use Docker if needed (the auth will be saved).

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
