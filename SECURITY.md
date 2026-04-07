# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Email:** Open a [private security advisory](https://github.com/philipvox/audiobook-tagger-web/security/advisories/new) on this repository.

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

I'll acknowledge receipt within 48 hours and work on a fix.

## Scope

This project is a client-side web app. Key areas of concern:

- **CORS proxy** (`worker/index.js`) — forwards requests between the browser and user-configured servers
- **API key handling** — stored in browser localStorage, sent to OpenAI/Anthropic/ABS APIs
- **Input sanitization** — AI responses parsed and rendered in the UI

## Out of Scope

- Vulnerabilities in third-party dependencies (report upstream)
- Issues requiring physical access to the user's machine
- Social engineering attacks
