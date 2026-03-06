# Full Interview - Production Docker Runbook

This setup runs:

- Next.js app (production build)
- PostgreSQL
- Nginx TLS proxy (`https://<LAN_IP>:3000`)
- Jitsi stack (`https://<LAN_IP>:8443`)

## Prerequisites

- Docker + Docker Compose
- OpenSSL on host machine
- A valid project `.env` file (SMTP/Clerk/AI keys in place)

## Start Production Stack

```bash
npm run prod:up
```

`prod:up` will automatically:

1. Detect your current LAN IP
2. Create `.env.production.auto` from `.env`
3. Auto-fill dynamic values:
   - `APP_BASE_URL=https://<LAN_IP>:3000`
   - `NEXT_PUBLIC_JITSI_DOMAIN=<LAN_IP>:8443`
   - `NEXT_PUBLIC_JITSI_SCRIPT_HOST=<LAN_IP>:8443`
   - `DATABASE_URL=postgresql://<user>:<password>@postgres:5432/<db>`
4. Create/update TLS certs for that IP under `docker/prod/certs/`
5. Start app + postgres + https proxy
6. Start Jitsi with LAN IP wiring

Your existing sensitive values in `.env` (SMTP/Clerk/AI keys) are preserved.

## Stop Production Stack

```bash
npm run prod:down
```

## Runtime Files (auto-generated)

- `.env.production.auto`
- `docker/jitsi/.env.runtime`
- `docker/prod/certs/app.crt`
- `docker/prod/certs/app.key`

## URLs

- App: `https://<LAN_IP>:3000`
- Jitsi: `https://<LAN_IP>:8443`

## Notes

- The certificate is self-signed. On first use per device, trust the cert.
- App container runs Prisma migrations at startup (`prisma migrate deploy`).
