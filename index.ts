import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import makeWASocket, {
  CacheStore,
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  WAMessageKey,
  WAMessageContent
} from '@whiskeysockets/baileys'
import P from 'pino'
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand
} from '@aws-sdk/client-sqs'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  S3ClientConfig
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'


// ================= ENV =================

const INPUT_QUEUE = process.env.INPUT_QUEUE!
const OUTPUT_QUEUE = process.env.OUTPUT_QUEUE!
const SESSION_DIR = process.env.SESSION_DIR || './auth'
const USE_PAIRING_CODE = process.env.USE_PAIRING_CODE === 'true'
const WHATSAPP_VERSION = process.env.WHATSAPP_VERSION

// SQS_* variables override the generic AWS_* ones so SQS can point at a
// different account/region/endpoint than S3 (e.g. real AWS SQS + local MinIO).
const SQS_REGION = process.env.SQS_REGION || process.env.AWS_REGION || 'us-east-1'
const SQS_ENDPOINT_URL = process.env.SQS_ENDPOINT_URL || process.env.AWS_ENDPOINT_URL
const sqsAccessKeyId = process.env.SQS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID
const sqsSecretAccessKey =
  process.env.SQS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY

// S3_* variables override the generic AWS_* ones so S3 can point at a
// different account/region/endpoint than SQS (e.g. real AWS SQS + local MinIO).
const S3_BUCKET = process.env.S3_BUCKET
const S3_PREFIX = (process.env.S3_PREFIX || 'baileys-sqs/media').replace(/\/$/, '')
const S3_REGION = process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1'
const S3_ENDPOINT_URL = process.env.S3_ENDPOINT_URL
const S3_PUBLIC_URL = process.env.S3_PUBLIC_URL
const S3_URL_EXPIRATION_SECONDS = parseInt(
  process.env.S3_URL_EXPIRATION_SECONDS || '604800',
  10
)

const s3AccessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID
const s3SecretAccessKey =
  process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY

// Use path-style addressing by default when a custom endpoint is provided
// (required for MinIO and most S3-compatible services).
const s3ForcePathStyle =
  process.env.S3_FORCE_PATH_STYLE === 'true' || !!S3_ENDPOINT_URL

// Optional HTTP input endpoint, additive to the SQS input queue (not a
// replacement) — useful for callers that would rather POST a command
// directly than push it onto SQS.
const HTTP_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined
const HTTP_HOST = process.env.HTTP_HOST || '0.0.0.0'
const HTTP_AUTH_TOKEN = process.env.AUTH_TOKEN
const HTTP_MAX_BODY_BYTES = parseInt(process.env.HTTP_MAX_BODY_BYTES || `${10 * 1024 * 1024}`, 10)

const RAW_EVENTS = process.env.LISTEN_EVENTS || '*'
const LISTEN_EVENTS =
  RAW_EVENTS === '*'
    ? null
    : new Set(RAW_EVENTS.split(',').map(e => e.trim()))

// ================= LOGGER =================

const logger = P({
  level: process.env.LOG_LEVEL || 'debug',
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        options: { colorize: true },
        level: 'debug',
      }
    ],
  },
})

// ================= AWS =================

const sqs = new SQSClient({
  region: SQS_REGION,
  endpoint: SQS_ENDPOINT_URL,
  ...(sqsAccessKeyId && sqsSecretAccessKey
    ? { credentials: { accessKeyId: sqsAccessKeyId, secretAccessKey: sqsSecretAccessKey } }
    : {})
})

// ================= S3 =================

const buildS3ClientConfig = (endpointUrl?: string): S3ClientConfig => {
  const config: S3ClientConfig = {
    region: S3_REGION,
    forcePathStyle: s3ForcePathStyle
  }

  if (endpointUrl) {
    config.endpoint = endpointUrl
  }

  if (s3AccessKeyId && s3SecretAccessKey) {
    config.credentials = {
      accessKeyId: s3AccessKeyId,
      secretAccessKey: s3SecretAccessKey
    }
  }

  return config
}

// Client used for upload operations (e.g. PutObject).
const s3Ops = new S3Client(buildS3ClientConfig(S3_ENDPOINT_URL))

// Separate client used for generating presigned URLs so that the public URL
// can differ from the internal SDK endpoint (common in Docker/local setups).
const s3Sign = new S3Client(
  buildS3ClientConfig(S3_PUBLIC_URL || S3_ENDPOINT_URL)
)

const sendToQueue = async (body: any) => {
  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: OUTPUT_QUEUE,
        MessageBody: JSON.stringify(body)
      })
    )
  } catch (err) {
    logger.error({ err }, 'Failed to send message to queue')
  }
}

// ================= HELPERS =================

const normalizeJid = (to: string) => {
  if (to.includes('@')) return to
  // Remove + prefix and any spaces from phone number
  const cleanNumber = to.replace(/[\s+]/g, '')
  return `${cleanNumber}@s.whatsapp.net`
}

// ===== URL fetch with timeout =====
const fetchBufferFromUrl = async (url: string, timeoutMs = 10000): Promise<Buffer> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, { signal: controller.signal })

    if (!res.ok) {
      throw new Error(`Failed to fetch media: ${res.status}`)
    }

    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } finally {
    clearTimeout(timeout)
  }
}

// ===== Normalize outgoing media =====
const resolveMediaBuffer = async (media: any): Promise<Buffer> => {
  if (media.data_base64) {
    return Buffer.from(media.data_base64, 'base64')
  }

  if (media.url) {
    return await fetchBufferFromUrl(media.url)
  }

  throw new Error('Media must include either data_base64 or url')
}

// ===== Media type detection =====
const getMediaType = (msg: any): 'image' | 'video' | 'audio' | 'document' | null => {
  const m = msg.message || {}
  if (m.imageMessage) return 'image'
  if (m.videoMessage) return 'video'
  if (m.audioMessage) return 'audio'
  if (m.documentMessage) return 'document'
  return null
}

const extensionFromMimetype = (mimetype?: string): string => {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/ogg': 'ogv',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'application/pdf': 'pdf'
  }

  if (!mimetype) return 'bin'
  return map[mimetype] || mimetype.split('/').pop() || 'bin'
}

const uploadMediaToS3 = async (
  type: string,
  mimetype: string | undefined,
  buffer: Buffer,
  msgId?: string
): Promise<{ url: string; key: string }> => {
  if (!S3_BUCKET) {
    throw new Error('S3_BUCKET is not configured')
  }

  const ext = extensionFromMimetype(mimetype)
  const key = `${S3_PREFIX}/${type}/${Date.now()}-${msgId || Math.random().toString(36).slice(2)}.${ext}`

  await s3Ops.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype || 'application/octet-stream'
    })
  )

  const url = await getSignedUrl(
    s3Sign,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    { expiresIn: S3_URL_EXPIRATION_SECONDS }
  )

  logger.debug({ bucket: S3_BUCKET, key, type }, 'Uploaded media to S3')

  return { url, key }
}

// ===== Incoming media → base64 or S3 URL =====
const extractMedia = async (msg: any) => {
  const type = getMediaType(msg)
  if (!type) return null

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {})
    if (!buffer) return null

    const mimetype = msg.message?.[`${type}Message`]?.mimetype

    if (S3_BUCKET) {
      const { url, key } = await uploadMediaToS3(type, mimetype, buffer, msg.key?.id)
      return {
        type,
        mimetype,
        url,
        s3_key: key,
        storage: 's3'
      }
    }

    return {
      type,
      mimetype,
      data_base64: buffer.toString('base64'),
      storage: 'base64'
    }
  } catch (err) {
    logger.error({ err, msgId: msg.key?.id }, 'Failed to extract media')
    return null
  }
}

// external map to store retry counts of messages when decryption/encryption fails
const msgRetryCounterCache = new NodeCache({ stdTTL: 100, checkperiod: 120 }) as CacheStore

// ================= WHATSAPP =================

let sock: any

const startWhatsApp = async () => {
  logger.info(`Starting WhatsApp with SESSION_DIR: ${SESSION_DIR}`)

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)

  // Get WhatsApp version - use env var if provided, otherwise fetch latest
  let version: [number, number, number]
  let isLatest = false

  if (WHATSAPP_VERSION) {
    try {
      version = JSON.parse(WHATSAPP_VERSION) as [number, number, number]
      logger.debug({ version: version.join('.') }, 'using WHATSAPP_VERSION from env')
    } catch (err) {
      logger.error({ err, WHATSAPP_VERSION }, 'Failed to parse WHATSAPP_VERSION, falling back to latest')
      const latest = await fetchLatestBaileysVersion()
      version = latest.version
      isLatest = latest.isLatest
      logger.debug({ version: version.join('.'), isLatest }, 'using latest WA version')
    }
  } else {
    const latest = await fetchLatestBaileysVersion()
    version = latest.version
    isLatest = latest.isLatest
    logger.debug({ version: version.join('.'), isLatest }, 'using latest WA version')
  }

  sock = makeWASocket({
    version,
    logger,
    waWebSocketUrl: process.env.SOCKET_URL ?? DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
  })

  // Process events efficiently in a batch
  sock.ev.process(
    async (events: Record<string, any>) => {
      // Connection state changes
      if (events['connection.update']) {
        const update = events['connection.update']
        const { connection, lastDisconnect, qr } = update

        if (qr) {
          await sendToQueue({
            type: 'qr',
            payload: { qr }
          })

          // Pairing code for Web clients
          if (USE_PAIRING_CODE && !sock.authState.creds.registered) {
            logger.info('Requesting pairing code...')
            const phoneNumber = process.env.PHONE_NUMBER
            if (phoneNumber) {
              try {
                const code = await sock.requestPairingCode(phoneNumber)
                logger.info({ code }, 'Pairing code generated')
                await sendToQueue({
                  type: 'pairing_code',
                  payload: { code, phoneNumber }
                })
              } catch (err) {
                logger.error({ err }, 'Failed to get pairing code')
              }
            }
          }
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut

          logger.error({ statusCode, shouldReconnect }, 'Connection closed')

          await sendToQueue({
            type: 'connection',
            payload: {
              status: 'disconnected',
              error: lastDisconnect?.error?.message,
              code: statusCode
            }
          })

          if (shouldReconnect) {
            logger.info('Reconnecting in 5 seconds...')
            setTimeout(startWhatsApp, 5000)
          } else {
            logger.fatal('Connection closed. You are logged out.')
          }
        }

        if (connection === 'open') {
          logger.info('WhatsApp connection opened')
          await sendToQueue({
            type: 'connection',
            payload: { status: 'connected' }
          })
        }

        logger.debug(update, 'connection update')
      }

      // Credentials updated
      if (events['creds.update']) {
        await saveCreds()
        logger.debug('creds saved')
      }

      // Process other events based on LISTEN_EVENTS
      for (const [eventName, data] of Object.entries(events)) {
        if (LISTEN_EVENTS && !LISTEN_EVENTS.has(eventName)) continue
        if (eventName === 'connection.update' || eventName === 'creds.update') continue

        let meta: any = {}

        // ===== messages.upsert =====
        if (eventName === 'messages.upsert') {
          const upsertData = data as { messages: any[], type: string }
          const messagesMeta = []

          for (const msg of upsertData.messages || []) {
            const media = await extractMedia(msg)
            if (media) msg._media = media

            messagesMeta.push({
              message_id: msg.key?.id,
              from: msg.key?.remoteJid,
              direction: msg.key?.fromMe ? 'outgoing' : 'incoming',
              has_media: !!media,
              timestamp: msg.messageTimestamp
            })
          }

          meta.messages = messagesMeta
          meta.type = upsertData.type
          logger.debug({ count: messagesMeta.length }, 'messages.upsert')
        }

        // ===== messages.update =====
        if (eventName === 'messages.update') {
          const updateData = (data || []) as any[]
          meta.updates = updateData.map((u: any) => ({
            message_id: u.key?.id,
            status: u.update?.status
          }))
        }

        // ===== presence.update =====
        if (eventName === 'presence.update') {
          meta.presence = data
        }

        // ===== connection.update (already handled above) =====
        if (eventName === 'connection.update') {
          const connData = data as { connection: string }
          meta.connection = {
            status: connData.connection,
            is_online: connData.connection === 'open'
          }
        }

        // ===== Emit single message =====
        const eventId = `${eventName}-${Date.now()}-${Math.random()}`

        await sendToQueue({
          id: eventId,
          type: 'baileys_event',
          event: eventName,
          meta,
          payload: data
        })
      }
    }
  )

  return sock
}

// ================= INPUT QUEUE =================

const handleCommand = async (cmd: any) => {
  if (!sock) {
    logger.error('Socket not initialized')
    return
  }

  const jid = normalizeJid(cmd.to)

  if (cmd.type === 'send_text') {
    // Validate and sanitize options
    const options = cmd.options || {}
    if (options.quoted) {
      // Baileys requires quoted to be a full WAMessage with both 'key' and 'message'
      if (!options.quoted.message) {
        logger.warn({
          quotedKeys: Object.keys(options.quoted),
          hasKey: !!options.quoted.key,
          hasMessage: !!options.quoted.message
        }, 'quoted object missing message property - stripping to prevent crash')
        delete options.quoted
      }
    }

    // If client provides full message object, use it directly; otherwise use text
    const messageContent = cmd.message || { text: cmd.text }

    await sock.sendMessage(jid, messageContent, options)
    logger.debug({ jid, hasOptions: !!cmd.options, hasQuoted: !!options.quoted, hasCustomMessage: !!cmd.message }, 'sent text message')
    return
  }

  if (cmd.type === 'send_media') {
    const media = cmd.media
    const buffer = await resolveMediaBuffer(media)

    // Start with cmd.message if provided, otherwise create empty object
    const message: any = cmd.message || {}

    // Convert text/conversation to caption for media messages
    // Baileys uses 'caption' for media text, not 'text' or 'conversation'
    if (message.text || message.conversation) {
      message.caption = message.text || message.conversation
      delete message.text
      delete message.conversation
    }

    // Always set mimetype and fileName
    message.mimetype = media.mimetype || 'application/octet-stream'
    message.fileName = media.filename || 'file'

    // Override/add the media buffer based on type
    if (media.type === 'image') message.image = buffer
    else if (media.type === 'video') message.video = buffer
    else if (media.type === 'audio') message.audio = buffer
    else message.document = buffer

    // Validate and sanitize options
    const options = cmd.options || {}
    if (options.quoted) {
      // Baileys requires quoted to be a full WAMessage with both 'key' and 'message'
      if (!options.quoted.message) {
        logger.warn({
          quotedKeys: Object.keys(options.quoted),
          hasKey: !!options.quoted.key,
          hasMessage: !!options.quoted.message
        }, 'quoted object missing message property - stripping to prevent crash')
        delete options.quoted
      }
    }

    await sock.sendMessage(jid, message, options)
    logger.debug({ jid, mediaType: media.type, hasOptions: !!cmd.options, hasQuoted: !!options.quoted, hasCustomMessage: !!cmd.message }, 'sent media message')
    return
  }

  throw new Error(`Unknown command type: ${cmd.type}`)
}

// ================= HTTP INPUT ENDPOINT =================

const readJsonBody = (req: IncomingMessage): Promise<any> => {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > HTTP_MAX_BODY_BYTES) {
        reject(new Error('Payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })

    req.on('error', reject)
  })
}

const sendJson = (res: ServerResponse, status: number, body: any) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

// Constant-time comparison so token length/content can't be inferred by timing.
const safeCompare = (a: string, b: string) => {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf)
}

const isAuthorized = (req: IncomingMessage): boolean => {
  if (!HTTP_AUTH_TOKEN) return true

  const header = req.headers['authorization']
  if (!header) return false

  return safeCompare(header, `Bearer ${HTTP_AUTH_TOKEN}`)
}

const startHttpServer = () => {
  if (!HTTP_PORT) {
    logger.info('PORT not set - HTTP input endpoint disabled (SQS input queue only)')
    return
  }

  if (!HTTP_AUTH_TOKEN) {
    logger.warn('AUTH_TOKEN not set - HTTP input endpoint is unauthenticated, do not expose it publicly like this')
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, { ok: true, connected: !!sock?.user })
      }

      if (req.method !== 'POST' || req.url !== '/commands') {
        return sendJson(res, 404, { ok: false, error: 'Not found' })
      }

      if (!isAuthorized(req)) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' })
      }

      if (!sock) {
        return sendJson(res, 503, { ok: false, error: 'WhatsApp socket not ready' })
      }

      const contentLength = Number(req.headers['content-length'])
      if (contentLength > HTTP_MAX_BODY_BYTES) {
        return sendJson(res, 413, { ok: false, error: 'Payload too large' })
      }

      const cmd = await readJsonBody(req)

      if (!cmd?.type || !cmd?.to) {
        return sendJson(res, 400, { ok: false, error: 'Command must include "type" and "to"' })
      }

      await handleCommand(cmd)
      return sendJson(res, 200, { ok: true })
    } catch (err: any) {
      logger.error({ err }, 'HTTP command error')
      const status = err.message === 'Payload too large' ? 413 : 400
      return sendJson(res, status, { ok: false, error: err.message || 'Internal error' })
    }
  })

  server.listen(HTTP_PORT, HTTP_HOST, () => {
    logger.info({ port: HTTP_PORT, host: HTTP_HOST }, 'HTTP input endpoint listening')
  })
}

const pollLoop = async () => {
  logger.info('Starting input queue poll loop')

  while (true) {
    try {
      const res = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: INPUT_QUEUE,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 10
        })
      )

      const messages = res.Messages || []

      for (const msg of messages) {
        try {
          const body = JSON.parse(msg.Body!)
          logger.debug({ cmdType: body.type }, 'Received command')
          await handleCommand(body)

          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: INPUT_QUEUE,
              ReceiptHandle: msg.ReceiptHandle!
            })
          )
        } catch (err) {
          logger.error({ err, msgBody: msg.Body }, 'Command error')
          // Delete the message to avoid poison pill
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: INPUT_QUEUE,
              ReceiptHandle: msg.ReceiptHandle!
            })
          )
        }
      }
    } catch (err) {
      logger.error({ err }, 'SQS poll error')
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

// ================= BOOT =================

const main = async () => {
  if (!INPUT_QUEUE || !OUTPUT_QUEUE) {
    console.error('❌ ERROR: INPUT_QUEUE and OUTPUT_QUEUE environment variables are required')
    process.exit(1)
  }

  await startWhatsApp()
  startHttpServer()
  pollLoop()
}

main()
