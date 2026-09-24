# Security Policy

## Reporting a Vulnerability

If you discover a potential security vulnerability in `pi-system-one`, please do not report it via public GitHub issues.

Instead, please email security reports directly to:
**theophilodamiao@gmail.com**

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof of concept
- Any suggested mitigations

We will review reports promptly and publish patches with proper attribution.

## Local Laya endpoints

Bind an unauthenticated Laya server to loopback (`LAYA_HOST=127.0.0.1`). Do not expose
an unauthenticated `0.0.0.0:8000` listener to a LAN or public network. If remote access
is intentional, set a strong `LAYA_API_KEY`, restrict access at the network layer, and
use TLS through a trusted reverse proxy.

Selecting `PI_SYSTEM_ONE_PROVIDER=laya` establishes a local-only routing boundary: pi-system-one does
not fall back from Laya to TypeSafe or OpenRouter. API keys are read only from the
environment or Pi's secret directory and are never persisted in settings or sessions.
