# Trade Backend

Node.js API, admin workflows, websocket feeds, signal engine, and MongoDB-backed app state for the Netrue crypto trading platform.

## Local Setup

```bash
npm install
cp .env.example .env
npm start
```

Set `MONGODB_URI`, `APP_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` before production deployment.

## Scripts

- `npm start` runs the API server.
- `npm test` runs the Node test suite.
- `npm run check` checks backend JavaScript syntax.
- `npm run signal-engine:start` starts the local signal engine process.

## Deployment Notes

This backend exposes normal HTTP API routes plus websocket endpoints. If you deploy the frontend separately, configure the frontend domain to proxy `/api`, `/ws`, and `/socket.io` to this backend or set the frontend API base URL.
