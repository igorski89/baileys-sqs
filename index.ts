import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import makeWASocket, { 
  CacheStore, 
  DEFAULT_CONNECTION_CONFIG, 
  DisconnectReason, 
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

// ================= ENV =================

const INPUT_QUEUE = process.env.INPUT_QUEUE!
const OUTPUT_QUEUE = process.env.OUTPUT_QUEUE!
const SESSION_DIR = process.env.SESSION_DIR || './auth'
const BASE64_MEDIA = process.env.BASE64_MEDIA !== 'false'
const USE_PAIRING_CODE = process.env.USE_PAIRING_CODE === 'true'
const WHATSAPP_VERSION = process.env.WHATSAPP_VERSION

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
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT_URL
})

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

const getMediaType = (msg: any) => {
  const m = msg.message || {}
  if (m.imageMessage) return 'image'
  if (m.videoMessage) return 'video'
  if (m.audioMessage) return 'audio'
  if (m.documentMessage) return 'document'
  return null
}

// ===== Incoming media → base64 =====
const extractMedia = async (sock: any, msg: any) => {
  if (!BASE64_MEDIA) return null

  const type = getMediaType(msg)
  if (!type) return null

  try {
    const buffer = await sock.downloadMediaMessage(msg)
    if (!buffer) return null

    return {
      type,
      mimetype: msg.message?.[`${type}Message`]?.mimetype,
      data_base64: buffer.toString('base64')
    }
  } catch (err) {
    logger.error({ err, msgId: msg.key?.id }, 'Failed to extract media')
    return null
  }
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
            const media = await extractMedia(sock, msg)
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
    await sock.sendMessage(jid, { text: cmd.text })
    logger.debug({ jid, text: cmd.text }, 'sent text message')
  }

  if (cmd.type === 'send_media') {
    const media = cmd.media
    const buffer = await resolveMediaBuffer(media)

    const message: any = {
      mimetype: media.mimetype || 'application/octet-stream',
      fileName: media.filename || 'file'
    }

    if (media.type === 'image') message.image = buffer
    else if (media.type === 'video') message.video = buffer
    else if (media.type === 'audio') message.audio = buffer
    else message.document = buffer

    await sock.sendMessage(jid, message)
    logger.debug({ jid, mediaType: media.type }, 'sent media message')
  }
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
  pollLoop()
}

main()
