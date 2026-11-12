-- One-time codes that sign a phone in by scanning a QR code on the owner's computer (POST /api/pair, /api/pair/claim).
-- Only a SHA-256 of each code is kept; a code works once and for a few minutes. Additive.
create table pair_codes (
  code_hash text primary key,
  expires_at timestamptz not null
);
