# Local Jitsi (No Moderator Login)

This stack runs Jitsi in anonymous mode so meetings start immediately and do not show "waiting for moderator".

## 1) Prepare env

```bash
cp docker/jitsi/env.sample docker/jitsi/.env
```

Update in `docker/jitsi/.env`:

- `PUBLIC_URL` to your host URL (for LAN use your local IP, e.g. `https://192.168.29.242:8443`)
- `DOCKER_HOST_ADDRESS` and `JVB_ADVERTISE_IPS` to the same host IP for LAN use
- Secret values (`JICOFO_COMPONENT_SECRET`, `JICOFO_AUTH_PASSWORD`, `JVB_AUTH_PASSWORD`)

## 2) Start Jitsi

```bash
# Generate a local cert that includes your LAN IP (recommended for iframe usage).
./docker/jitsi/generate-local-cert.sh 192.168.29.242

# Then start Jitsi.
npm run jitsi:up
```

Or directly:

```bash
docker compose --env-file docker/jitsi/.env -f docker/jitsi/docker-compose.yml up -d
```

## 3) First-time certificate trust

Open `https://<your-host>:8443` in browser once and accept the certificate warning.
Without this, iframe loading can hang.

On macOS, you can trust the generated certificate system-wide:

```bash
./docker/jitsi/trust-local-cert-macos.sh
```

## 4) Point Next.js app to local Jitsi

In app `.env` set:

```bash
NEXT_PUBLIC_JITSI_DOMAIN=<your-host>:8443
```

Example:

```bash
NEXT_PUBLIC_JITSI_DOMAIN=192.168.29.242:8443
```

Optional fallback:

```bash
NEXT_PUBLIC_JITSI_FALLBACK_DOMAIN=meet.jit.si
```

Then restart Next.js dev server.

## 5) Logs / stop

```bash
npm run jitsi:logs
npm run jitsi:down
```
