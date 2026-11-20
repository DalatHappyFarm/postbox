# Security policy

## Reporting a vulnerability

Please report security problems privately.
Use GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability").
Do not open a public issue for a vulnerability.
We aim to acknowledge a report within 7 days.

## In scope

- The API in `lib/` and `functions/` (auth, rate limits, upload handling, SQL).
- The dashboard in `public/` (XSS, CSP, token handling).
- The CLI in `packages/cli/` and the React Native kit in `packages/react-native/`.

## Out of scope

- Your own deployment's secrets, Cloudflare or Neon account settings.
- Reports that need a leaked admin token or database URL.
- Denial of service by volume beyond the documented rate limits.

## Security model in short

- Testers have no accounts: they send with a per-project public key, which is not a secret and only allows submitting.
- Reading and changing feedback needs the single admin bearer token.
- Images are checked by magic bytes and JPEG metadata (EXIF, GPS) is stripped on the server.
- Everything a tester sends is data: stored text loses control characters (one-line fields lose line breaks too), and agent briefs put the tester's note in a code fence, so a letter cannot forge the owner's instructions or send escape codes to a terminal.
