import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import readline from 'readline'

// ================= ENV =================

const INPUT_QUEUE = process.env.INPUT_QUEUE!
const AWS_REGION = process.env.AWS_REGION || 'us-east-1'
const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL

// ================= AWS =================

const sqs = new SQSClient({
  region: AWS_REGION,
  endpoint: AWS_ENDPOINT_URL
})

// ================= HELPERS =================

const sendTextMessage = async (to: string, text: string) => {
  const message = {
    type: 'send_text',
    to: to.replace(/[\s+]/g, ''), // Remove spaces and + prefix
    text
  }

  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: INPUT_QUEUE,
        MessageBody: JSON.stringify(message)
      })
    )
    console.log(`✅ Message queued: ${to} - "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`)
    return true
  } catch (err) {
    console.error('❌ Failed to send:', err)
    return false
  }
}

// ================= CLI =================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

const showHelp = () => {
  console.log(`
📱 WhatsApp SQS Sender

Usage:
  sender "+1234567890" "Hello, World!"
  sender 1234567890 "How are you?"

Interactive mode (no args):
  sender

Environment variables:
  INPUT_QUEUE     - SQS queue URL (required)
  AWS_REGION      - AWS region (default: us-east-1)
  AWS_ENDPOINT_URL - Optional endpoint for local ElasticMQ
`)
}

// ================= MAIN =================

const main = async () => {
  if (!INPUT_QUEUE) {
    console.error('❌ ERROR: INPUT_QUEUE environment variable is required')
    showHelp()
    process.exit(1)
  }

  const args = process.argv.slice(2)

  // Direct mode: sender "phone" "message"
  if (args.length >= 2) {
    const phone = args[0]
    const message = args.slice(1).join(' ')
    await sendTextMessage(phone, message)
    process.exit(0)
  }

  // Help mode
  if (args.includes('--help') || args.includes('-h')) {
    showHelp()
    process.exit(0)
  }

  // Interactive mode
  console.log('📱 WhatsApp SQS Sender')
  console.log('Connected to:', INPUT_QUEUE)
  console.log('Enter messages in format: "phone number" "message body"')
  console.log('Type "quit" or "exit" to stop\n')

  while (true) {
    const input = await question('> ')

    if (input.toLowerCase() === 'quit' || input.toLowerCase() === 'exit') {
      console.log('👋 Goodbye!')
      rl.close()
      process.exit(0)
    }

    if (!input.trim()) continue

    // Try to parse quoted format: "phone" "message"
    const match = input.match(/^["']?([^"']+)["']?\s+["']?(.+?)["']?$/)

    if (match) {
      const [, phone, message] = match
      await sendTextMessage(phone, message)
    } else {
      // Ask separately
      const phone = await question('Phone number: ')
      if (!phone) continue

      const message = await question('Message: ')
      if (!message) continue

      await sendTextMessage(phone, message)
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
