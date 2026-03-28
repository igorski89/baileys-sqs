import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand
} from "@aws-sdk/client-sqs"
import qrcode from "qrcode-terminal"

// ================= ENV =================

const OUTPUT_QUEUE = process.env.OUTPUT_QUEUE!
const AWS_REGION = process.env.AWS_REGION || "us-east-1"

// ================= AWS =================

const sqs = new SQSClient({ region: AWS_REGION })

// ================= FORMATTERS =================

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m"
}

const log = (color: keyof typeof colors, ...args: any[]) => {
  console.log(colors[color], ...args, colors.reset)
}

// ===== QR Code Renderer =====
const renderQR = (qrData: string) => {
  console.clear()
  console.log("\n")
  log("cyan", "╔════════════════════════════════════════════════════════════╗")
  log("cyan", "║                                                            ║")
  log("cyan", "║              📱 SCAN QR CODE WITH WHATSAPP                 ║")
  log("cyan", "║                                                            ║")
  log("cyan", "╚════════════════════════════════════════════════════════════╝")
  console.log("\n")
  
  qrcode.generate(qrData, { small: true }, (qrcode: string) => {
    console.log(qrcode)
  })
  
  console.log("\n")
  log("yellow", "   Open WhatsApp → Settings → Linked Devices → Link a Device")
  log("dim", "   Waiting for scan...")
  console.log("\n")
}

// ===== Message Content Extractor =====
const extractMessageContent = (msg: any): string => {
  const m = msg.message || {}
  
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.imageMessage) return "[📷 Image]"
  if (m.videoMessage) return "[🎥 Video]"
  if (m.audioMessage) return m.audioMessage.ptt ? "[🎤 Voice Message]" : "[🎵 Audio]"
  if (m.documentMessage) return `[📄 Document: ${m.documentMessage.fileName || "unnamed"}]`
  if (m.stickerMessage) return "[🏷️ Sticker]"
  if (m.locationMessage) return "[📍 Location]"
  if (m.contactMessage || m.contactsArrayMessage) return "[👤 Contact]"
  if (m.liveLocationMessage) return "[📍 Live Location]"
  if (m.pollCreationMessage) return `[📊 Poll: ${m.pollCreationMessage.name}]`
  if (m.reactionMessage) return `[❤️ Reaction: ${m.reactionMessage.text}]`
  
  return "[Unknown message type]"
}

// ===== Pretty Print Message =====
const prettyPrintMessage = (msg: any) => {
  const timestamp = msg.messageTimestamp 
    ? new Date(msg.messageTimestamp * 1000).toLocaleString()
    : new Date().toLocaleString()
  
  const from = msg.key?.remoteJid || "unknown"
  const sender = msg.key?.fromMe ? "ME" : (msg.pushName || from.split("@")[0])
  const direction = msg.key?.fromMe ? "➤ OUT" : "➤ IN"
  const directionColor = msg.key?.fromMe ? "green" : "blue"
  const messageId = msg.key?.id?.slice(-8) || "????"
  
  const content = extractMessageContent(msg)
  const hasMedia = msg._media ? " 📎" : ""
  
  console.log("\n")
  log(directionColor, `┌─────────────────────────────────────────────────────────────┐`)
  log(directionColor, `│ ${direction}  ID: ${messageId} ${" ".repeat(39 - messageId.length)}│`)
  log(directionColor, `├─────────────────────────────────────────────────────────────┤`)
  log(directionColor, `│ From: ${sender.padEnd(51)}│`)
  log(directionColor, `│ Time: ${timestamp.padEnd(51)}│`)
  log(directionColor, `├─────────────────────────────────────────────────────────────┤`)
  
  // Wrap content to fit in box (max 59 chars per line)
  const maxLineLength = 59
  const lines: string[] = []
  
  if (content.length <= maxLineLength) {
    lines.push(content)
  } else {
    const words = content.split(" ")
    let currentLine = ""
    
    for (const word of words) {
      if ((currentLine + " " + word).length > maxLineLength) {
        if (currentLine) lines.push(currentLine.trim())
        currentLine = word
      } else {
        currentLine = currentLine ? currentLine + " " + word : word
      }
    }
    if (currentLine) lines.push(currentLine.trim())
  }
  
  for (const line of lines.slice(0, 10)) {
    log(directionColor, `│ ${line.padEnd(59)}│`)
  }
  
  if (lines.length > 10) {
    log(directionColor, `│ ... and ${lines.length - 10} more lines`.padEnd(60) + "│")
  }
  
  if (hasMedia) {
    log(directionColor, `│ ${" ".repeat(58)}│`)
    log(directionColor, `│ ${hasMedia} [${msg._media?.type} - ${msg._media?.mimetype}]`.padEnd(60) + "│")
  }
  
  log(directionColor, `└─────────────────────────────────────────────────────────────┘`)
}

// ===== Pretty Print Connection Status =====
const prettyPrintConnection = (status: string) => {
  if (status === "connected") {
    console.clear()
    log("green", "\n╔════════════════════════════════════════════════════════════╗")
    log("green", "║                                                            ║")
    log("green", "║              ✅ WHATSAPP CONNECTED                         ║")
    log("green", "║                                                            ║")
    log("green", "╚════════════════════════════════════════════════════════════╝\n")
  } else if (status === "disconnected") {
    log("red", "\n╔════════════════════════════════════════════════════════════╗")
    log("red", "║                                                            ║")
    log("red", "║              ❌ WHATSAPP DISCONNECTED                      ║")
    log("red", "║                                                            ║")
    log("red", "╚════════════════════════════════════════════════════════════╝\n")
  }
}

// ===== Pretty Print Event =====
const prettyPrintEvent = (event: any) => {
  const eventType = event.event || event.type || "unknown"
  const timestamp = new Date().toLocaleTimeString()
  
  switch (eventType) {
    case "qr":
      renderQR(event.payload.qr)
      break
      
    case "connection":
      prettyPrintConnection(event.payload.status)
      if (event.payload.error) {
        log("red", `   Error: ${event.payload.error} (Code: ${event.payload.code || "unknown"})`)
      }
      break
      
    case "messages.upsert":
      for (const msg of event.payload?.messages || []) {
        prettyPrintMessage(msg)
      }
      break
      
    case "messages.update":
      for (const update of event.meta?.updates || []) {
        log("magenta", `[${timestamp}] 📨 Message ${update.message_id} status: ${update.status}`)
      }
      break
      
    case "presence.update":
      const presence = event.payload
      const presenceIcon = presence.presence === "available" ? "🟢" : "⚪"
      log("cyan", `[${timestamp}] ${presenceIcon} ${presence.id} is ${presence.presence}`)
      break
      
    default:
      log("dim", `[${timestamp}] 📦 Event: ${eventType}`)
      if (process.env.DEBUG === "true") {
        console.log(JSON.stringify(event, null, 2))
      }
  }
}

// ================= SQS POLLER =================

const pollLoop = async () => {
  log("cyan", "🚀 Starting Baileys Output Queue Listener...")
  log("cyan", `📍 Queue: ${OUTPUT_QUEUE}`)
  log("cyan", "👂 Listening for events...\n")
  
  while (true) {
    try {
      const res = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: OUTPUT_QUEUE,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 10,
          MessageAttributeNames: ["All"],
          AttributeNames: ["All"]
        })
      )
      
      const messages = res.Messages || []
      
      for (const msg of messages) {
        try {
          const body = JSON.parse(msg.Body!)
          prettyPrintEvent(body)
          
          // Delete the message after processing
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: OUTPUT_QUEUE,
              ReceiptHandle: msg.ReceiptHandle!
            })
          )
        } catch (err) {
          log("red", "Error processing message:", err)
          // Delete the message to avoid poison pill
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: OUTPUT_QUEUE,
              ReceiptHandle: msg.ReceiptHandle!
            })
          )
        }
      }
    } catch (err) {
      log("red", "SQS Error:", err)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

// ================= BOOT =================

const main = async () => {
  if (!OUTPUT_QUEUE) {
    console.error("❌ ERROR: OUTPUT_QUEUE environment variable is required")
    console.error("   Set it to your SQS output queue URL")
    process.exit(1)
  }
  
  pollLoop()
}

main()
