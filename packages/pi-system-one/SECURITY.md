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

## Credentials

pi-system-one does not read, store, or display an API key. It calls
`ctx.modelRegistry.classify()`, and pi resolves the credential from `~/.pi/agent/auth.json`
(`/login`) or the provider's own environment variable. Nothing secret is written to this
package's settings files, session entries, or status output, and `baseURL` is no longer a
setting: the endpoint comes from the provider pi resolved.

Treat `~/.pi/agent/pi-system-one.json` and the `.pi/pi-system-one.json` in a project as
non-sensitive. They hold mode switches and a classifier selection only.

## Local model endpoints

Bind a llama.cpp router to loopback. Pi's `/login llama.cpp` stores the connection and
`LLAMA_BASE_URL` / `LLAMA_API_KEY` configure it without a login; do not expose an
unauthenticated router beyond loopback, because a model server reachable from the network
accepts prompts from anyone who can reach it.

A request pinned to a local classifier is not silently sent to a hosted one. When no
classifier is selected at all, every classifier pi can reach is tried in catalog order, so
a machine with a local router and a signed-in cloud account will prefer whichever answers
first; pin one with `PI_SYSTEM_ONE_PROVIDER` to make the choice explicit.

Note that a small local model judges the request state as data it can also be instructed
by. The extension cannot prevent that, which is why local answers are discounted before
any threshold compares them.
