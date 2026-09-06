import NodeCache from '@cacheable/node-cache'
import makeWASocket, {
  CacheStore,
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  downloadMediaMessage,
  extractMessageContent,
  fetchLatestBaileysVersion,
  getContentType,
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
import { createHash, timingSafeEqual } from 'node:crypto'


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

// FIFO queues (name contains "fifo", e.g. ending in ".fifo") require
// MessageGroupId + MessageDeduplicationId on every send. Standard queues
// reject these fields, so they're only added when the queue is FIFO.
const isFifoQueue = (queueUrl: string) => !!queueUrl?.toLowerCase().includes('fifo')

const OUTPUT_QUEUE_IS_FIFO = isFifoQueue(OUTPUT_QUEUE)

// Groups events by chat so ordering is preserved per-conversation while
// independent chats can still be processed in parallel by the consumer.
// Falls back to the event type for events with no chat (qr, connection, ...).
// Note: a single messages.upsert batch can - rarely, e.g. during initial
// history sync - contain messages from multiple chats; this groups the
// whole batch by the first message's chat as a best-effort approximation.
const getFifoGroupId = (body: any): string => {
  const upsertJid = body?.payload?.messages?.[0]?.key?.remoteJid
  if (upsertJid) return upsertJid

  const updateJid = Array.isArray(body?.payload) && body.payload[0]?.key?.remoteJid
  if (updateJid) return updateJid

  if (body?.event === 'presence.update' && body?.payload?.id) {
    return body.payload.id
  }

  if (body?.type === 'command_ack' && body?.payload?.to) {
    return body.payload.to
  }

  return body?.type === 'baileys_event' ? body.event : (body?.type || 'system')
}

// Deterministic JSON.stringify with sorted object keys, so two objects with
// identical values but different key insertion order (e.g. if Baileys
// builds a redelivered message via a different internal code path than the
// original) still produce the same string - JSON.stringify alone preserves
// insertion order rather than normalizing it.
const canonicalStringify = (value: any): string => {
  if (Array.isArray(value)) {
    return `[${value.map(v => (v === undefined ? 'null' : canonicalStringify(v))).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// Only alphanumerics, "@ . : _ -" are used unescaped in the readable dedup
// prefix (JIDs/message ids/statuses are already within this set in
// practice); anything else is replaced so a stray character can never
// break the SendMessage call outright.
const sanitizeForDedupId = (value: string): string => value.replace(/[^a-zA-Z0-9@.:_-]/g, '_')

// Human-readable prefix for the dedup id, so a dropped/duplicate message
// is identifiable at a glance in a dead-letter queue or SQS console instead
// of being an opaque hash. Mirrors getFifoGroupId's event-shape detection,
// plus the message id/status needed to tell events for the same chat apart.
const getDedupPrefix = (body: any): string => {
  const upsertMsg = body?.payload?.messages?.[0]
  if (upsertMsg?.key?.id) {
    return `messages.upsert:${sanitizeForDedupId(upsertMsg.key.remoteJid || '')}:${sanitizeForDedupId(upsertMsg.key.id)}`
  }

  const updateEntry = Array.isArray(body?.payload) && body.payload[0]
  if (updateEntry?.key?.id) {
    return `messages.update:${sanitizeForDedupId(updateEntry.key.remoteJid || '')}:${sanitizeForDedupId(updateEntry.key.id)}:${sanitizeForDedupId(String(updateEntry.update?.status ?? ''))}`
  }

  if (body?.event === 'presence.update' && body?.payload?.id) {
    return `presence.update:${sanitizeForDedupId(body.payload.id)}`
  }

  if (body?.type === 'command_ack' && body?.payload?.to) {
    const ref = body.payload.correlation_id || body.payload.message_id || ''
    return `command_ack:${sanitizeForDedupId(body.payload.to)}:${sanitizeForDedupId(body.payload.command_type || '')}:${sanitizeForDedupId(ref)}`
  }

  return sanitizeForDedupId(body?.type === 'baileys_event' ? body.event : (body?.type || 'system'))
}

// Content-based dedup id, so a genuinely re-sent/redelivered event (e.g.
// Baileys redelivering a messages.upsert after a reconnect) is actually
// caught by SQS's 5-minute FIFO dedup window. A random id per call would
// only ever match an SDK-internal retry of the exact same request - which
// already carries the same id regardless - so it provides no real
// protection against genuine duplicate sends. `id` is excluded from the
// hash because it's a wrapper correlation id we generate fresh per call
// (baked-in randomness), not part of the actual event content.
//
// The id is prefixed with a readable summary (chat/message/status) so a
// dropped duplicate is identifiable at a glance in a dead-letter queue or
// the SQS console, instead of being an opaque hash - the hash suffix still
// covers the full content, so it remains the source of truth for whether
// two sends are true duplicates, even for fields the prefix doesn't capture.
const computeDedupId = (body: any): string => {
  const { id, ...content } = body || {}
  const hash = createHash('sha256').update(canonicalStringify(content)).digest('hex')
  // SQS caps MessageDeduplicationId at 128 chars; cap the prefix well below
  // that so prefix + "-" + a full 64-char hash never risks exceeding it.
  const prefix = getDedupPrefix(body).slice(0, 55)
  return `${prefix}-${hash}`
}

const sendToQueue = async (body: any) => {
  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: OUTPUT_QUEUE,
        MessageBody: JSON.stringify(body),
        ...(OUTPUT_QUEUE_IS_FIFO
          ? {
              MessageGroupId: getFifoGroupId(body),
              MessageDeduplicationId: computeDedupId(body)
            }
          : {})
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

// Per-chat disappearing-messages duration (seconds), so outgoing sends can
// carry the ephemeralExpiration option Baileys requires on every send -
// unlike groups (queryable via groupMetadata), Baileys doesn't track or
// auto-apply a 1:1 chat's setting; without this, WhatsApp shows outgoing
// messages as "won't disappear" even when the chat has it enabled.
// In-memory only - lost on restart, but self-heals as soon as any message
// flows through the chat again (see updateEphemeralCache below).
const ephemeralExpirationByChat = new Map<string, number>()

const updateEphemeralCache = (jid: string | undefined | null, expiration: number | null | undefined) => {
  // undefined = no signal either way (field just wasn't present), leave
  // the cache untouched. Baileys itself encodes "turned off" as null, not
  // 0 (it does `protocolMsg.ephemeralExpiration || null` internally), so
  // both 0 and null here mean "explicitly off" and must clear the cache.
  if (!jid || expiration === undefined) return
  if (expiration) {
    if (ephemeralExpirationByChat.get(jid) !== expiration) {
      logger.debug({ jid, expiration }, 'ephemeral cache: enabled/updated')
    }
    ephemeralExpirationByChat.set(jid, expiration)
  } else {
    if (ephemeralExpirationByChat.has(jid)) {
      logger.debug({ jid }, 'ephemeral cache: disabled')
    }
    ephemeralExpirationByChat.delete(jid)
  }
}

// Every message sent within a chat that has disappearing messages enabled
// carries its own contextInfo.expiration, so we can also learn/refresh the
// setting passively from incoming traffic - this is what lets the cache
// self-heal after a restart, for any chat that's still active.
const getMessageEphemeralExpiration = (msg: any): number | undefined => {
  const content = extractMessageContent(msg?.message)
  if (!content) return undefined

  const type = getContentType(content)
  return type ? (content as any)[type]?.contextInfo?.expiration : undefined
}

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
          const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode
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

      // Track disappearing-messages settings as they change.
      if (events['chats.update']) {
        for (const chat of events['chats.update'] as any[]) {
          updateEphemeralCache(chat?.id, chat?.ephemeralExpiration)
        }
      }

      // Forward every other event to OUTPUT_QUEUE - consumers filter out
      // whatever they don't want on their side.
      for (const [eventName, data] of Object.entries(events)) {
        if (eventName === 'connection.update' || eventName === 'creds.update') continue

        let meta: any = {}

        // ===== messages.upsert =====
        if (eventName === 'messages.upsert') {
          const upsertData = data as { messages: any[], type: string }
          const messagesMeta = []

          for (const msg of upsertData.messages || []) {
            const media = await extractMedia(msg)
            if (media) msg._media = media

            const expiration = getMessageEphemeralExpiration(msg)
            if (expiration !== undefined) {
              updateEphemeralCache(msg.key?.remoteJid, expiration)
            }

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

// Baileys requires 'quoted' to be a full WAMessage with both 'key' and
// 'message' - strip it if a caller sends an incomplete one to avoid a crash.
const sanitizeQuotedOption = (options: any) => {
  if (options.quoted && !options.quoted.message) {
    logger.warn({
      quotedKeys: Object.keys(options.quoted),
      hasKey: !!options.quoted.key,
      hasMessage: !!options.quoted.message
    }, 'quoted object missing message property - stripping to prevent crash')
    delete options.quoted
  }
}

// Attach the chat's known disappearing-messages duration, if any, so
// outgoing content isn't silently sent as non-expiring. Never overrides an
// explicit value the caller already set.
const applyEphemeralOption = (jid: string, options: any) => {
  if (options.ephemeralExpiration !== undefined) return
  const expiration = ephemeralExpirationByChat.get(jid)
  if (expiration) {
    options.ephemeralExpiration = expiration
    logger.debug({ jid, expiration }, 'applying cached ephemeralExpiration to outgoing message')
  }
}

const handleCommand = async (cmd: any) => {
  if (!sock) {
    logger.error('Socket not initialized')
    return
  }

  const jid = normalizeJid(cmd.to)

  if (cmd.type === 'send_text') {
    const options = cmd.options || {}
    sanitizeQuotedOption(options)
    applyEphemeralOption(jid, options)

    // If client provides full message object, use it directly; otherwise use text
    const messageContent = cmd.message || { text: cmd.text }

    const sentMsg = await sock.sendMessage(jid, messageContent, options)
    logger.debug({ jid, hasOptions: !!cmd.options, hasQuoted: !!options.quoted, hasCustomMessage: !!cmd.message }, 'sent text message')
    return { to: jid, messageId: sentMsg?.key?.id ?? null }
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

    // Only override mimetype when the caller explicitly provides one -
    // otherwise let Baileys fall back to the correct per-type default
    // (e.g. image/webp for stickers, application/pdf for documents).
    if (media.mimetype) {
      message.mimetype = media.mimetype
    }
    message.fileName = media.filename || 'file'

    // Override/add the media buffer based on type
    if (media.type === 'image') message.image = buffer
    else if (media.type === 'video') message.video = buffer
    else if (media.type === 'audio') message.audio = buffer
    else if (media.type === 'sticker') message.sticker = buffer
    else message.document = buffer

    const options = cmd.options || {}
    sanitizeQuotedOption(options)
    applyEphemeralOption(jid, options)

    const sentMsg = await sock.sendMessage(jid, message, options)
    logger.debug({ jid, mediaType: media.type, hasOptions: !!cmd.options, hasQuoted: !!options.quoted, hasCustomMessage: !!cmd.message }, 'sent media message')
    return { to: jid, messageId: sentMsg?.key?.id ?? null }
  }

  if (cmd.type === 'send_presence') {
    const VALID_PRESENCE = ['composing', 'recording', 'paused']
    if (!VALID_PRESENCE.includes(cmd.presence)) {
      throw new Error(`Invalid presence: ${cmd.presence}. Must be one of ${VALID_PRESENCE.join(', ')}`)
    }

    // Required for the update to reliably show up on the recipient's side -
    // best-effort, since it depends on the contact's privacy settings.
    try {
      await sock.presenceSubscribe(jid)
    } catch (err) {
      logger.warn({ err, jid }, 'presenceSubscribe failed, sending presence update anyway')
    }

    await sock.sendPresenceUpdate(cmd.presence, jid)
    logger.debug({ jid, presence: cmd.presence }, 'sent presence update')
    return { to: jid }
  }

  if (cmd.type === 'send_reaction') {
    if (typeof cmd.reaction !== 'string') {
      throw new Error('send_reaction requires a "reaction" string (use an empty string to remove a reaction)')
    }

    const messageKey = cmd.message_key
    if (!messageKey?.id) {
      throw new Error('send_reaction requires "message_key" with at least an "id" field')
    }

    const sentMsg = await sock.sendMessage(jid, {
      react: {
        text: cmd.reaction,
        key: {
          remoteJid: messageKey.remoteJid || jid,
          fromMe: !!messageKey.fromMe,
          id: messageKey.id,
          participant: messageKey.participant
        }
      }
    })
    logger.debug({ jid, reaction: cmd.reaction, messageId: messageKey.id }, 'sent reaction')
    return { to: jid, messageId: sentMsg?.key?.id ?? null }
  }

  if (cmd.type === 'send_read_receipt') {
    const keys = cmd.message_keys || (cmd.message_key ? [cmd.message_key] : [])
    if (!Array.isArray(keys) || keys.length === 0 || keys.some((k: any) => !k?.id)) {
      throw new Error('send_read_receipt requires "message_keys" (array) or "message_key" (single), each with an "id" field')
    }

    // readMessages checks the recipient's read-receipt privacy setting itself
    // and sends a "read" or "read-self" receipt as appropriate.
    await sock.readMessages(
      keys.map((k: any) => ({
        remoteJid: k.remoteJid || jid,
        fromMe: !!k.fromMe,
        id: k.id,
        participant: k.participant
      }))
    )
    logger.debug({ jid, count: keys.length }, 'sent read receipt')
    return { to: jid }
  }

  if (cmd.type === 'send_edit') {
    if (typeof cmd.text !== 'string') {
      throw new Error('send_edit requires a "text" string')
    }

    const messageKey = cmd.message_key
    if (!messageKey?.id) {
      throw new Error('send_edit requires "message_key" with at least an "id" field')
    }

    const sentMsg = await sock.sendMessage(jid, {
      text: cmd.text,
      // Only your own messages can be edited - default to true unless the
      // caller explicitly says otherwise.
      edit: {
        remoteJid: messageKey.remoteJid || jid,
        fromMe: messageKey.fromMe !== undefined ? !!messageKey.fromMe : true,
        id: messageKey.id,
        participant: messageKey.participant
      }
    })
    logger.debug({ jid, messageId: messageKey.id }, 'edited message')
    return { to: jid, messageId: sentMsg?.key?.id ?? null }
  }

  if (cmd.type === 'send_delete') {
    const messageKey = cmd.message_key
    if (!messageKey?.id) {
      throw new Error('send_delete requires "message_key" with at least an "id" field')
    }

    const sentMsg = await sock.sendMessage(jid, {
      // Deletes your own message, or anyone's in a group if you're admin -
      // default to true (your own message) unless told otherwise.
      delete: {
        remoteJid: messageKey.remoteJid || jid,
        fromMe: messageKey.fromMe !== undefined ? !!messageKey.fromMe : true,
        id: messageKey.id,
        participant: messageKey.participant
      }
    })
    logger.debug({ jid, messageId: messageKey.id }, 'deleted message')
    return { to: jid, messageId: sentMsg?.key?.id ?? null }
  }

  if (cmd.type === 'send_location') {
    const location = cmd.location
    if (typeof location?.latitude !== 'number' || typeof location?.longitude !== 'number') {
      throw new Error('send_location requires "location" with numeric "latitude" and "longitude"')
    }

    const sentMsg = await sock.sendMessage(jid, {
      location: {
        degreesLatitude: location.latitude,
        degreesLongitude: location.longitude,
        name: location.name,
        address: location.address
      }
    })
    logger.debug({ jid, latitude: location.latitude, longitude: location.longitude }, 'sent location')
    return { to: jid, messageId: sentMsg?.key?.id ?? null }
  }

  if (cmd.type === 'send_contact') {
    const contacts = cmd.contacts || (cmd.contact ? [cmd.contact] : [])
    if (!Array.isArray(contacts) || contacts.length === 0 || contacts.some((c: any) => !c?.vcard)) {
      throw new Error('send_contact requires "contacts" (array) or "contact" (single), each with a "vcard" string')
    }

    const sentMsg = await sock.sendMessage(jid, {
      contacts: {
        displayName: contacts.length === 1 ? contacts[0].displayName : undefined,
        contacts: contacts.map((c: any) => ({ displayName: c.displayName, vcard: c.vcard }))
      }
    })
    logger.debug({ jid, count: contacts.length }, 'sent contact')
    return { to: jid, messageId: sentMsg?.key?.id ?? null }
  }

  if (cmd.type === 'send_poll') {
    const poll = cmd.poll
    if (typeof poll?.name !== 'string' || !Array.isArray(poll?.values) || poll.values.length < 2) {
      throw new Error('send_poll requires "poll" with a "name" string and at least 2 "values"')
    }

    const sentMsg = await sock.sendMessage(jid, {
      poll: {
        name: poll.name,
        values: poll.values,
        selectableCount: poll.selectableCount
      }
    })
    logger.debug({ jid, question: poll.name, optionCount: poll.values.length }, 'sent poll')

    // The poll's encryption secret is generated locally by Baileys at send
    // time and only ever available on this return value - it's never sent
    // back to us afterward. Surface it here so a caller that supplied a
    // correlation_id can persist it and decrypt votes itself later; we
    // never store it ourselves.
    const messageSecret = sentMsg?.message?.messageContextInfo?.messageSecret
    return {
      to: jid,
      messageId: sentMsg?.key?.id ?? null,
      extra: { message_secret: messageSecret ? Buffer.from(messageSecret).toString('base64') : null }
    }
  }

  if (cmd.type === 'raw') {
    // Escape hatch: passes "body" straight through as sock.sendMessage's
    // content argument, for any Baileys message shape without a dedicated
    // command type yet (buttons, lists, albums, view-once, ...).
    if (typeof cmd.body !== 'object' || cmd.body === null || Array.isArray(cmd.body)) {
      throw new Error('raw requires a "body" object to pass directly to sock.sendMessage')
    }

    const options = cmd.options || {}
    sanitizeQuotedOption(options)
    applyEphemeralOption(jid, options)

    const sentMsg = await sock.sendMessage(jid, cmd.body, options)
    logger.debug({ jid, bodyKeys: Object.keys(cmd.body) }, 'sent raw message')
    return { to: jid, messageId: sentMsg?.key?.id ?? null }
  }

  throw new Error(`Unknown command type: ${cmd.type}`)
}

// Optional pass-through id set by the caller. When present, emits a
// confirmation event on OUTPUT_QUEUE reporting what happened - the real
// WhatsApp message id (when the command produces one), any command-specific
// extra data (e.g. a poll's encryption secret), or the error if it failed.
// Silently does nothing when correlation_id is absent, so this has zero
// effect on any existing caller that doesn't use it.
const dispatchCommand = async (cmd: any) => {
  try {
    const result = await handleCommand(cmd)
    if (cmd.correlation_id) {
      await sendToQueue({
        type: 'command_ack',
        payload: {
          correlation_id: cmd.correlation_id,
          command_type: cmd.type,
          to: result?.to ?? null,
          ok: true,
          message_id: result?.messageId ?? null,
          ...(result?.extra || {})
        }
      })
    }
  } catch (err: any) {
    if (cmd.correlation_id) {
      await sendToQueue({
        type: 'command_ack',
        payload: {
          correlation_id: cmd.correlation_id,
          command_type: cmd.type,
          to: (cmd.to ? normalizeJid(cmd.to) : null) ?? null,
          ok: false,
          error: err?.message || String(err)
        }
      })
    }
    throw err // preserve existing error handling at both call sites below
  }
}

// ================= HTTP INPUT ENDPOINT =================

const readJsonBody = (req: IncomingMessage): Promise<any> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []

    req.on('data', (chunk: Buffer) => {
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

      const cmd = await readJsonBody(req)

      if (!cmd?.type || !cmd?.to) {
        return sendJson(res, 400, { ok: false, error: 'Command must include "type" and "to"' })
      }

      await dispatchCommand(cmd)
      return sendJson(res, 200, { ok: true })
    } catch (err: any) {
      logger.error({ err }, 'HTTP command error')
      return sendJson(res, 400, { ok: false, error: err.message || 'Internal error' })
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
          await dispatchCommand(body)

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
