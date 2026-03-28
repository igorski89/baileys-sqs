import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} from "@whiskeysockets/baileys"

import P from "pino"
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand
} from "@aws-sdk/client-sqs"

// ================= ENV =================

const INPUT_QUEUE = process.env.INPUT_QUEUE!
const OUTPUT_QUEUE = process.env.OUTPUT_QUEUE!
const SESSION_DIR = process.env.SESSION_DIR || "./auth"
const BASE64_MEDIA = process.env.BASE64_MEDIA !== "false"

const RAW_EVENTS = process.env.LISTEN_EVENTS || "*"
const LISTEN_EVENTS =
  RAW_EVENTS === "*"
    ? null
    : new Set(RAW_EVENTS.split(",").map(e => e.trim()))

// ================= AWS =================

const sqs = new SQSClient({ region: process.env.AWS_REGION })

const sendToQueue = async (body: any) => {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: OUTPUT_QUEUE,
      MessageBody: JSON.stringify(body)
    })
  )
}

// ================= HELPERS =================

const normalizeJid = (to: string) =>
  to.includes("@") ? to : `${to}@s.whatsapp.net`

const getMediaType = (msg: any) => {
  const m = msg.message || {}
  if (m.imageMessage) return "image"
  if (m.videoMessage) return "video"
  if (m.audioMessage) return "audio"
  if (m.documentMessage) return "document"
  return null
}

// ===== Incoming media → base64 =====
const extractMedia = async (msg: any) => {
  if (!BASE64_MEDIA) return null

  const type = getMediaType(msg)
  if (!type) return null

  const buffer = await downloadMediaMessage(msg, "buffer", {})

  return {
    type,
    mimetype: msg.message?.[`${type}Message`]?.mimetype,
    data_base64: buffer.toString("base64")
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
    return Buffer.from(media.data_base64, "base64")
  }

  if (media.url) {
    return await fetchBufferFromUrl(media.url)
  }

  throw new Error("Media must include either data_base64 or url")
}

// ================= WHATSAPP =================

let sock: any

const startWhatsApp = async () => {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)

  const logger = P({ level: "silent" })

  sock = makeWASocket({
    auth: state,
    logger
  })

  sock.ev.on("creds.update", saveCreds)

  // ===== CONNECTION + QR =====
  sock.ev.on("connection.update", async (update: any) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      await sendToQueue({
        type: "qr",
        payload: { qr }
      })
    }

    if (connection === "open") {
      await sendToQueue({
        type: "connection",
        payload: { status: "connected" }
      })
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

      await sendToQueue({
        type: "connection",
        payload: { status: "disconnected" }
      })

      if (shouldReconnect) {
        console.log("Reconnecting...")
        startWhatsApp()
      }
    }
  })

  // ===== ALL EVENTS (ONE EVENT → ONE MESSAGE) =====
  sock.ev.process(async (events: any) => {
    for (const [eventName, data] of Object.entries(events)) {

      if (LISTEN_EVENTS && !LISTEN_EVENTS.has(eventName)) continue

      let meta: any = {}

      // ===== messages.upsert =====
      if (eventName === "messages.upsert") {
        const messagesMeta = []

        for (const msg of data.messages || []) {

          const media = await extractMedia(msg)
          if (media) msg._media = media

          messagesMeta.push({
            message_id: msg.key?.id,
            from: msg.key?.remoteJid,
            direction: msg.key?.fromMe ? "outgoing" : "incoming",
            has_media: !!media,
            timestamp: msg.messageTimestamp
          })
        }

        meta.messages = messagesMeta
        meta.type = data.type
      }

      // ===== messages.update =====
      if (eventName === "messages.update") {
        meta.updates = (data || []).map((u: any) => ({
          message_id: u.key?.id,
          status: u.update?.status
        }))
      }

      // ===== connection.update =====
      if (eventName === "connection.update") {
        meta.connection = {
          status: data.connection,
          is_online: data.connection === "open"
        }
      }

      // ===== presence.update =====
      if (eventName === "presence.update") {
        meta.presence = data
      }

      // ===== emit single message =====
      const eventId = `${eventName}-${Date.now()}-${Math.random()}`

      await sendToQueue({
        id: eventId,
        type: "baileys_event",
        event: eventName,
        meta,
        payload: data
      })
    }
  })

  return sock
}

// ================= INPUT QUEUE =================

const handleCommand = async (cmd: any) => {
  const jid = normalizeJid(cmd.to)

  if (cmd.type === "send_text") {
    await sock.sendMessage(jid, { text: cmd.text })
  }

  if (cmd.type === "send_media") {
    const media = cmd.media

    const buffer = await resolveMediaBuffer(media)

    const message: any = {
      mimetype: media.mimetype || "application/octet-stream",
      fileName: media.filename || "file"
    }

    if (media.type === "image") message.image = buffer
    else if (media.type === "video") message.video = buffer
    else if (media.type === "audio") message.audio = buffer
    else message.document = buffer

    await sock.sendMessage(jid, message)
  }
}

const pollLoop = async () => {
  while (true) {
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
        await handleCommand(body)

        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: INPUT_QUEUE,
            ReceiptHandle: msg.ReceiptHandle!
          })
        )
      } catch (err) {
        console.error("Command error", err)
      }
    }
  }
}

// ================= BOOT =================

const main = async () => {
  await startWhatsApp()
  pollLoop()
}

main()
