# Asterisk inbound voice (cheap SIP)

Pattern adapted from [PTCIP](https://github.com/NOVA-privacy-first/PTCIP) — **no Twilio**.

## Lab (softphone only)

1. `pjsip.conf` is generated — set `PUBLIC_IP` in `.env` (or leave unset for local-only) and run `npm run trunk`.
2. `docker compose up -d`
3. Register a softphone (Linphone) to `hotline` / `hotline-lab` on this host:5060.
4. Dial `hotline` — Asterisk AGI-calls orchestrator on `:4573`.

## Production trunk (Zadarma / Telnyx)

1. Set `SIP_USER` / `SIP_PASSWORD` / `SIP_TRUNK_HOST` in `.env`, then `npm run trunk`.
2. Set `EXTERNAL_IP` to public IP; forward UDP 5060 + 10000–10099.
3. Route DID to the SIP extension in the provider PBX.
