// Status verification script for Telegram bot + Cloudflare Worker
// - Reads .env securely
// - Checks Telegram auth via getMe
// - Verifies webhook config via getWebhookInfo
// - Checks Worker health and webhook secret enforcement

import fs from 'node:fs'
import path from 'node:path'

// Minimal .env parser to avoid extra deps
function loadEnv(filePath) {
  const env = {}
  if (!fs.existsSync(filePath)) return env
  const content = fs.readFileSync(filePath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    let val = trimmed.slice(idx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    env[key] = val
  }
  return env
}

const root = process.cwd()
const env = loadEnv(path.join(root, '.env'))

const BOT_API_TOKEN = env.BOT_API_TOKEN || process.env.BOT_API_TOKEN
const WEBHOOK_SECRET_TOKEN = env.WEBHOOK_SECRET_TOKEN || process.env.WEBHOOK_SECRET_TOKEN
const BASE_URL = (env.BASE_URL || process.env.BASE_URL || '').replace(/\/$/, '')
const TEST_CHAT_ID = env.TEST_CHAT_ID || process.env.TEST_CHAT_ID

const TELEGRAM_API = (token) => `https://api.telegram.org/bot${token}`

function timeout(ms) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(t) }
}

async function fetchJson(url, options = {}, ms = 8000) {
  const { signal, cancel } = timeout(ms)
  try {
    const res = await fetch(url, { ...options, signal })
    const ct = res.headers.get('content-type') || ''
    const isJson = ct.includes('application/json')
    const data = isJson ? await res.json() : await res.text()
    return { ok: res.ok, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, data: String(err && err.message ? err.message : err) }
  } finally {
    cancel()
  }
}

function printResult(title, ok, details) {
  const status = ok ? 'PASS' : 'FAIL'
  console.log(`[${status}] ${title}`)
  if (details) console.log(`  -> ${details}`)
}

async function checkTelegramAuth(token) {
  if (!token) return { ok: false, details: 'BOT_API_TOKEN is missing' }
  const r = await fetchJson(`${TELEGRAM_API(token)}/getMe`, { method: 'GET' })
  if (!r.ok || !r.data || !r.data.ok) {
    return { ok: false, details: `getMe failed: status=${r.status} desc=${r.data && r.data.description}` }
  }
  const me = r.data.result
  return { ok: true, details: `Bot: @${me.username} (id=${me.id})` }
}

async function checkWebhookInfo(token, baseUrl) {
  const r = await fetchJson(`${TELEGRAM_API(token)}/getWebhookInfo`, { method: 'GET' })
  if (!r.ok || !r.data || !r.data.ok) {
    return { ok: false, details: `getWebhookInfo failed: status=${r.status} desc=${r.data && r.data.description}` }
  }
  const info = r.data.result
  const expected = baseUrl ? `${baseUrl}/webhook` : null
  const urlOk = expected ? info.url === expected : Boolean(info.url)
  const lastErrDate = info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null
  let msg = `url=${info.url || '<none>'}; pending=${info.pending_update_count}`
  if (expected) msg += `; expected=${expected}`
  if (info.ip_address) msg += `; ip=${info.ip_address}`
  if (typeof info.max_connections === 'number') msg += `; max_conn=${info.max_connections}`
  if (typeof info.has_custom_certificate === 'boolean') msg += `; custom_cert=${info.has_custom_certificate}`
  if (info.last_error_message) msg += `; last_error_message=${info.last_error_message}`
  if (lastErrDate) msg += `; last_error_date=${lastErrDate}`
  return { ok: urlOk, details: msg }
}

async function checkWorkerHealth(baseUrl) {
  if (!baseUrl) return { ok: false, details: 'BASE_URL is missing' }
  const r = await fetchJson(`${baseUrl}/`, { method: 'GET' })
  return { ok: r.ok, details: `status=${r.status} body=${typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}` }
}

async function checkWebhookSecret(baseUrl, secret) {
  if (!baseUrl) return { ok: false, details: 'BASE_URL is missing' }
  // With correct secret: expect 200
  const good = await fetchJson(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret || '' },
    body: JSON.stringify({ update_id: 1 }),
  })
  // With wrong secret: expect 401 if secret is enforced; else 200
  const bad = await fetchJson(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': '__invalid__' },
    body: JSON.stringify({ update_id: 2 }),
  })
  const enforced = secret ? bad.status === 401 && good.status === 200 : good.status === 200 && bad.status === 200
  const details = `good=${good.status}; bad=${bad.status}; enforced=${secret ? 'yes' : 'no'}`
  return { ok: enforced, details }
}

async function main() {
  console.log('== Bot Status Verification ==')
  const results = []

  const auth = await checkTelegramAuth(BOT_API_TOKEN)
  printResult('Telegram auth (getMe)', auth.ok, auth.details)
  results.push(auth.ok)

  const wh = await checkWebhookInfo(BOT_API_TOKEN, BASE_URL)
  printResult('Telegram webhook info', wh.ok, wh.details)
  results.push(wh.ok)

  const health = await checkWorkerHealth(BASE_URL)
  printResult('Worker health (GET /)', health.ok, health.details)
  results.push(health.ok)

  const secret = await checkWebhookSecret(BASE_URL, WEBHOOK_SECRET_TOKEN)
  printResult('Webhook secret enforcement', secret.ok, secret.details)
  results.push(secret.ok)

  if (TEST_CHAT_ID) {
    // Optional: send a test message via Telegram to verify reply path
    const testText = `Status probe @ ${new Date().toISOString()}`
    const r = await fetchJson(`${TELEGRAM_API(BOT_API_TOKEN)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TEST_CHAT_ID, text: testText }),
    })
    const ok = r.ok && r.data && r.data.ok
    printResult('Direct sendMessage test (TEST_CHAT_ID)', !!ok, ok ? `message_id=${r.data.result.message_id}` : `status=${r.status} desc=${r.data && r.data.description}`)
    results.push(!!ok)
  }

  const allOk = results.every(Boolean)
  console.log(`\nOverall: ${allOk ? 'PASS' : 'FAIL'}`)
  process.exit(allOk ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})