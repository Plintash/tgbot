**Telegram Bot on Cloudflare Workers (Hono)**

- Install and run locally:
  - `npm install`
  - `npm run dev`

- Deploy:
  - `npm run deploy`

Setup
- Create a Telegram bot via `@BotFather` and get the bot token.
- Store secrets in Cloudflare:
  - `wrangler secret put BOT_API_TOKEN`
  - `wrangler secret put WEBHOOK_SECRET_TOKEN` (choose any random string)
- Configure your public Worker URL:
  - Option A (recommended): add to `wrangler.jsonc` under `vars`:
    - `{ "vars": { "BASE_URL": "https://<your-worker-subdomain>.workers.dev" } }`
  - Option B: set as an environment variable in your deployment environment.

Webhook
- 注册方式（二选一）：
  - 部署后自动触发：`npm run deploy` 会随后执行 `postdeploy`，调用 `scripts/trigger-set-webhook.mjs` 读取 `.env` 的 `BASE_URL` 并访问 `<BASE_URL>/set-webhook` 完成注册。
  - 手动触发：直接访问 `GET https://<your-worker-subdomain>.workers.dev/set-webhook`。
- 可选的冷启动自动重设：将 `AUTO_WEBHOOK_INIT=true` 填入环境（Worker `vars` 或 Secret），启动时会先 `deleteWebhook` 再 `setWebhook` 以确保干净状态。

Status Verification
- Run `npm run check:status` to verify:
  - Telegram auth (`getMe`)
  - Telegram webhook registration (`getWebhookInfo` matches `<BASE_URL>/webhook`)
  - Worker health (`GET /` returns OK)
  - Webhook secret enforcement (200 with correct secret, 401 with invalid secret)
- Ensure `.env` contains:
  - `BOT_API_TOKEN=...`
  - `WEBHOOK_SECRET_TOKEN=...`
  - `BASE_URL=https://<your-worker-subdomain>.workers.dev`
 - 可选：`AUTO_WEBHOOK_INIT=true`（启用冷启动自动重设）
 - 可选：`TEST_CHAT_ID=<你的聊天ID>`（状态脚本会直接调用 `sendMessage` 验证发送路径）

Security
- 推荐将 `BOT_API_TOKEN` 与 `WEBHOOK_SECRET_TOKEN` 存为 Cloudflare Secrets（而非 `vars`）：
  - `pnpm exec wrangler secret put BOT_API_TOKEN`
  - `pnpm exec wrangler secret put WEBHOOK_SECRET_TOKEN`
  - 设置后可从 `wrangler.jsonc` 的 `vars` 移除对应字段，避免明文泄露。

Behavior
- Receives Telegram updates at `/webhook`.
- Responds with: `Hello` followed by any available `@username`, `first_name`, and `last_name`.
- Uses `waitUntil` to send Telegram replies in the background for performance.
- Verifies `X-Telegram-Bot-Api-Secret-Token` if configured.

Notes
- Ensure your Worker is publicly accessible before setting the webhook.
- For type generation, you can run `npm run cf-typegen`.
