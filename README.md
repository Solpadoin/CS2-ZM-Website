# CS2 Zombie Mod Website

Production landing and realtime monitor for the CS2 Zombie Mod test server.

## Frontend

Static files live in `public/` and are deployed to GitHub Pages by `.github/workflows/pages.yml`.

Custom domain:

```text
zm2.ghostbe.site
```

The frontend reads `public/config.json` for the backend API base URL.

## Backend

`server.js` runs as a small Node.js service on the VPS and exposes:

```text
GET /api/health
GET /api/status
```

Recommended production API DNS:

```text
api.zm2.ghostbe.site -> 195.137.244.196
```

Required GitHub Actions secrets for backend deployment:

```text
VPS_HOST
VPS_USER
VPS_PASSWORD
```

Use `CORS_ORIGIN=https://zm2.ghostbe.site` on the VPS once the API domain is configured.
