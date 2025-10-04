// Post-deploy helper: triggers GET <BASE_URL>/set-webhook using .env
import fs from 'node:fs'
import path from 'node:path'

function loadEnv(filePath) {
  const env = {}
  if (!fs.existsSync(filePath)) return env
  const content = fs.readFileSync(filePath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i === -1) continue
    const k = s.slice(0, i).trim()
    let v = s.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    env[k] = v
  }
  return env
}

const root = process.cwd()
const env = loadEnv(path.join(root, '.env'))
const BASE_URL = (env.BASE_URL || process.env.BASE_URL || '').replace(/\/$/, '')

if (!BASE_URL) {
  console.error('BASE_URL is missing; cannot trigger set-webhook')
  process.exit(1)
}

async function main() {
  const url = `${BASE_URL}/set-webhook`
  try {
    const res = await fetch(url, { method: 'GET' })
    const ct = res.headers.get('content-type') || ''
    const isJson = ct.includes('application/json')
    const data = isJson ? await res.json() : await res.text()
    if (!res.ok) {
      console.error('Trigger set-webhook failed', res.status, data)
      process.exit(1)
    }
    console.log('Triggered set-webhook:', typeof data === 'string' ? data : JSON.stringify(data))
  } catch (err) {
    console.error('Error calling set-webhook:', err)
    process.exit(1)
  }
}

main()