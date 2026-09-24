# ADR-0008 Authentication and request protection

Status: Accepted (provisioning gated on owner)

Cloudflare Access (single identity, MFA) in front of app and API; the Worker also verifies the Access
JWT (signature/aud/iss/exp/email allowlist) so a misconfigured route cannot bypass auth. Mutations require
JSON, `X-VC-Request: 1` and an allowlisted `Origin`. Pending-queue items are bound to a hash of the
identity. Details: `docs/security.md`.
