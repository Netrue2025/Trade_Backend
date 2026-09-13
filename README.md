# Trade Backend

Node.js API, admin workflows, websocket feeds, signal engine, and MongoDB-backed app state for the Netrue crypto trading platform.

## Local Setup

```bash
npm install
cp .env.example .env
npm start
```

Set `MONGODB_URI`, `APP_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` before production deployment. On Railway, the backend also accepts `MONGO_URI`, `MONGO_URL`, `DATABASE_URL`, and the legacy `mongo_URI` alias for MongoDB.
If the frontend is deployed separately, also set `FRONTEND_ORIGIN` to the exact frontend URL, for example `https://netruefi.org`.

## Scripts

- `npm start` runs the API server.
- `npm test` runs the Node test suite.
- `npm run check` checks backend JavaScript syntax.
- `npm run signal-engine:start` starts the local signal engine process.
- `npm run storage:report` prints read-only MongoDB storage metadata.
- `npm run backups:cleanup` runs a dry-run app-state backup cleanup report. It does not delete anything without explicit confirmation flags.

## Deployment Notes

This backend exposes normal HTTP API routes plus websocket endpoints. If you deploy the frontend separately, set `FRONTEND_ORIGIN` here and set `TRADE_API_BASE_URL` on the frontend service.

Railway does not upload local `.env` files automatically. Add the variables in the service's **Variables** tab, and make sure the MongoDB connection URL is reachable from the backend service.

Recommended MongoDB backup settings:

```bash
MONGODB_APP_STATE_BACKUP_LIMIT=5
MONGODB_APP_STATE_BACKUP_INTERVAL_MS=21600000
MONGODB_APP_STATE_BACKUPS_ENABLED=true
TRADE_LEARNING_ENABLED=false
```

Dry-run backup cleanup:

```bash
npm run backups:cleanup
```

The cleanup script requires `--execute --keep=5 --confirm=DELETE_OLD_APP_STATE_BACKUPS` before it can delete old backup documents. Review the dry-run output first.
