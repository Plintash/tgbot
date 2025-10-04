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
- After deployment, call the setup route to register the webhook:
  - `GET https://<your-worker-subdomain>.workers.dev/set-webhook`
- This sets the webhook to `<BASE_URL>/webhook` and enables secret verification.

Behavior
- Receives Telegram updates at `/webhook`.
- Responds with: `Hello` followed by any available `@username`, `first_name`, and `last_name`.
- Uses `waitUntil` to send Telegram replies in the background for performance.
- Verifies `X-Telegram-Bot-Api-Secret-Token` if configured.

Notes
- Ensure your Worker is publicly accessible before setting the webhook.
- For type generation, you can run `npm run cf-typegen`.
