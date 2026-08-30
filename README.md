# Trade Backend

Node.js API, admin workflows, websocket feeds, signal engine, and MongoDB-backed app state for the Netrue crypto trading platform.

## Local Setup

```bash
npm install
cp .env.example .env
npm start
```

Set `MONGODB_URI`, `APP_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` before production deployment.
If the frontend is deployed separately, also set `FRONTEND_ORIGIN` to the exact frontend URL, for example `https://trade-frontend-jwu2.onrender.com`.

## Scripts

- `npm start` runs the API server.
- `npm test` runs the Node test suite.
- `npm run check` checks backend JavaScript syntax.
- `npm run signal-engine:start` starts the local signal engine process.

## Deployment Notes

This backend exposes normal HTTP API routes plus websocket endpoints. If you deploy the frontend separately, set `FRONTEND_ORIGIN` here and set `TRADE_API_BASE_URL` on the frontend service.
