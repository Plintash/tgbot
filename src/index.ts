import { Hono } from 'hono'

type Bindings = {
  BOT_API_TOKEN: string
  WEBHOOK_SECRET_TOKEN?: string
  BASE_URL?: string
  AUTO_WEBHOOK_INIT?: string
}

const app = new Hono<{ Bindings: Bindings }>()

// Simple health endpoint
app.get('/', (c) => {
  return c.text('OK')
})

// Telegram Update types (minimal subset used)
type TelegramUser = {
  id: number
  is_bot: boolean
  first_name?: string
  last_name?: string
  username?: string
}

type TelegramChat = {
  id: number
  type: string
}

type TelegramMessage = {
  message_id: number
  date: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
}

type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
}

const TELEGRAM_API = (token: string) => `https://api.telegram.org/bot${token}`

function getRequestId(): string {
  // Use standard Web Crypto if available; fallback for older runtimes
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  // Adapted RFC4122 v4 format without hyphen replacement complexities
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'))
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  )
}

function buildGreeting(user?: TelegramUser): string {
  if (!user) return 'Hello there'
  const parts: string[] = []
  if (user.username) parts.push(`@${user.username}`)
  if (user.first_name) parts.push(user.first_name)
  if (user.last_name) parts.push(user.last_name)
  const info = parts.join(' ').trim()
  return info ? `Hello ${info}` : 'Hello there'
}

async function sendMessage(token: string, chatId: number, text: string) {
  const url = `${TELEGRAM_API(token)}/sendMessage`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  })
  let data: any
  try {
    const ct = res.headers.get('content-type') || ''
    data = ct.includes('application/json') ? await res.json() : await res.text()
  } catch {
    data = await res.text().catch(() => '')
  }
  if (!res.ok || (data && data.ok === false)) {
    console.error('Telegram sendMessage failed', res.status, data)
  } else {
    console.log('Telegram sendMessage ok', typeof data === 'string' ? data : JSON.stringify(data))
  }
}

// One-time webhook initializer: delete previous and set current webhook
let webhookInitPromise: Promise<void> | null = null
async function configureWebhook(env: Bindings) {
  const token = env.BOT_API_TOKEN
  const baseUrl = env.BASE_URL?.replace(/\/$/, '')
  const secret = env.WEBHOOK_SECRET_TOKEN

  // Always attempt to delete existing webhook to ensure a clean state
  try {
    const delRes = await fetch(`${TELEGRAM_API(token)}/deleteWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: true }),
    })
    const delData = await delRes.json().catch(async () => ({ ok: false, description: await delRes.text() }))
    if (!delRes.ok || !delData.ok) {
      console.warn('deleteWebhook did not succeed', delRes.status, delData)
    }
  } catch (err) {
    console.warn('deleteWebhook error', err)
  }

  if (!baseUrl) {
    console.warn('configureWebhook skipped: BASE_URL not configured')
    return
  }
  // Register the current webhook
  try {
    const setRes = await fetch(`${TELEGRAM_API(token)}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${baseUrl}/webhook`,
        secret_token: secret,
        max_connections: 40,
        allowed_updates: ['message', 'edited_message'],
      }),
    })
    const setData = await setRes.json().catch(async () => ({ ok: false, description: await setRes.text() }))
    if (!setRes.ok || !setData.ok) {
      console.error('setWebhook failed', setRes.status, setData)
    } else {
      console.log('Webhook configured')
    }
  } catch (err) {
    console.error('setWebhook error', err)
  }
}

// Middleware to trigger one-time webhook configuration at app startup
app.use('*', async (c, next) => {
  // Only run auto webhook init when explicitly enabled
  const enabled = (c.env.AUTO_WEBHOOK_INIT || '').toLowerCase() === 'true'
  if (enabled && !webhookInitPromise) {
    webhookInitPromise = configureWebhook(c.env).catch((err) => {
      console.error('Webhook init failed', err)
      webhookInitPromise = null
    })
    c.executionCtx.waitUntil(webhookInitPromise)
  }
  return next()
})

// Webhook receiver
app.post('/webhook', async (c) => {
  const reqId = getRequestId()
  const secretHeader = c.req.header('X-Telegram-Bot-Api-Secret-Token')
  const configuredSecret = c.env.WEBHOOK_SECRET_TOKEN

  // Verify secret token if configured
  if (configuredSecret && secretHeader !== configuredSecret) {
    console.warn(`[${reqId}] Webhook rejected: invalid secret token`)
    return c.text('unauthorized', 401)
  }

  let update: TelegramUpdate
  try {
    update = await c.req.json<TelegramUpdate>()
  } catch (err) {
    console.error(`[${reqId}] Invalid JSON`, err)
    return c.text('bad request', 400)
  }

  const message = update.message || update.edited_message
  if (!message || !message.chat) {
    console.log(`[${reqId}] No message payload; acking`)
    return c.text('ok')
  }

  const greeting = buildGreeting(message.from)
  const chatId = message.chat.id

  // Respond quickly; perform Telegram call in background
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await sendMessage(c.env.BOT_API_TOKEN, chatId, greeting)
      } catch (err) {
        console.error('sendMessage threw', err)
      }
    })()
  )

  console.log(`[${reqId}] Update processed for chat ${chatId}`)
  return c.text('ok')
})

// Helper route to configure Telegram webhook securely
app.get('/set-webhook', async (c) => {
  const token = c.env.BOT_API_TOKEN
  const baseUrl = c.env.BASE_URL
  const secret = c.env.WEBHOOK_SECRET_TOKEN

  if (!baseUrl) {
    return c.json({ ok: false, error: 'BASE_URL not configured' }, 400)
  }
  const webhookUrl = `${baseUrl.replace(/\/$/, '')}/webhook`

  const res = await fetch(`${TELEGRAM_API(token)}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret,
      max_connections: 40,
      allowed_updates: ['message', 'edited_message'],
    }),
  })

  const data = await res.json().catch(async () => ({ ok: false, description: await res.text() }))
  if (!res.ok || !data.ok) {
    console.error('Failed to set webhook', res.status, data)
    return c.json({ ok: false, status: res.status, data }, 500)
  }
  return c.json({ ok: true, result: data })
})

export default app
