# Asterisk inbound voice (cheap SIP)

Pattern adapted from [PTCIP](https://github.com/NOVA-privacy-first/PTCIP) — **no Twilio**.

## Lab (softphone only)

1. Edit `pjsip.conf`: set `EXTERNAL_IP` to your LAN IP (or leave for local-only).
2. `docker compose up -d`
3. Register a softphone (Linphone) to `hotline` / `hotline-lab` on this host:5060.
4. Dial `hotline` — Asterisk AGI-calls orchestrator on `:4573`.

## Production trunk (Zadarma / Telnyx)

1. Replace `SIP_USER` / `SIP_PASSWORD` / server URI in `pjsip.conf`.
2. Set `EXTERNAL_IP` to public IP; forward UDP 5060 + 10000–10099.
3. Route DID to the SIP extension in the provider PBX.
