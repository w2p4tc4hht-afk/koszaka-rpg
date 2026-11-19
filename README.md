# KOSZAKA RPG — backend-ready starter

## What is included
- Telegram Mini App frontend with Telegram `initData` authentication header
- Express API with Telegram WebApp HMAC validation
- PostgreSQL schema for per-player profiles and action history
- Server-authoritative pet care actions, XP, levels and coins
- Health endpoint

## Deploy prerequisites
1. Create a PostgreSQL database in Render and set `DATABASE_URL`.
2. Set `BOT_TOKEN` to the Telegram bot token on the server only.
3. Apply `src/schema.sql` to the database.
4. Deploy the Node web service from the repository (`npm install`, `npm start`).
5. Configure the bot's Mini App URL to the deployed HTTPS URL.

## Important
- Do not put BOT_TOKEN in `public/` or browser code.
- Telegram Stars purchases are not activated yet. They must be implemented with server-created invoices (`currency: XTR`), webhook/pre_checkout handling and payment idempotency before selling any items.
- Social visits, gifts, inventory, rooms, moderation and leaderboards are planned follow-up modules.
- Never trust client-provided Telegram user IDs; the backend validates Telegram initData.
