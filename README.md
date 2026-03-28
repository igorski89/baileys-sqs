# baileys-sqs

Baileys SQS connector - A WhatsApp Web integration using AWS SQS for bidirectional message queuing.

## Architecture

This application implements a two-queue architecture:

- **Input Queue**: Receives messages from external systems to be sent to WhatsApp
- **Output Queue**: Publishes messages received from WhatsApp to external systems

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Your System    │────▶│  Input Queue    │────▶│   WhatsApp    │
│                 │     │  (SQS)          │     │   (Baileys)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                              ▲                         │
                              │                         │
┌─────────────────┐     ┌─────┴─────────┐              │
│  Your System    │◀────│  Output Queue │◀─────────────┘
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

# SQS Configuration
SQS_INPUT_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/input-queue
SQS_OUTPUT_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/output-queue

# WhatsApp/Baileys Configuration
AUTH_DIRECTORY=./auth_info_baileys
LOG_LEVEL=info
```

## Usage

### Local Development with Docker Compose (Recommended)

The easiest way to get started is using Docker Compose, which includes ElasticMQ (SQS-compatible local queue server):

#### Option A: Hot Reload Development (Automatic restart on code changes)

```bash
# Start with hot reloading
docker-compose -f docker-compose.dev.yml up

# Code changes will automatically restart the application
# View logs
docker-compose -f docker-compose.dev.yml logs -f app

# Stop services
docker-compose -f docker-compose.dev.yml down

# Stop and remove volumes (clears queue data and auth)
docker-compose -f docker-compose.dev.yml down -v
```

This mode:
- Mounts your source code as a volume
- Uses `ts-node-dev` to auto-restart on file changes
- Installs dependencies inside the container (including devDependencies)
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

### Development (without Docker)

```bash
# Run with ts-node (no build required)
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
SQS_INPUT_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/input-queue
SQS_OUTPUT_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/output-queue
```

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run start` | Run the compiled application |
| `npm run dev` | Run in development mode with ts-node |
| `npm run clean` | Remove the `dist` directory |
| `npm test` | Run tests (placeholder) |

## Project Structure

```
baileys-sqs/
├── index.ts                       # Main application entry point
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

- **[@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)** - WhatsApp Web API
- **[@aws-sdk/client-sqs](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sqs/)** - AWS SQS SDK v3
- **[ElasticMQ](https://github.com/softwaremill/elasticmq)** - SQS-compatible message queue for local development
- **TypeScript** - Type-safe JavaScript
- **Docker** - Containerization

## License

MIT

## Author

Igor Ievsiukov <igor.ievsiukov@gmail.com>
