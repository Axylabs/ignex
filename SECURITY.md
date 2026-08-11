# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities. Instead,
report privately so we can fix and release before disclosure.

To report a vulnerability:

- Email the maintainers at the address listed on the project's npm/GitHub page,
- or open a **private security advisory** on GitHub:
  `https://github.com/Axylabs/ignus/security/advisories/new`

Include as much detail as possible:

- Affected package(s) and version(s)
- A minimal reproduction (route/plugin/hook code)
- Impact and any suggested mitigation

We aim to acknowledge reports within 3 business days and provide a timeline for
the fix.

## Security model

`ignus` compiles user route code into a Bun server. Keep in mind:

- **Input validation is opt-in.** Untrusted input should be validated with a
  schema (`TypeBox`/Standard Schema) on every affected route.
- **`ctx.set`/cookies/headers are applied verbatim.** Avoid echoing unvalidated
  user input into headers without sanitizing (header injection).
- **Path traversal** is guarded by `safeJoin` in `@ignus/core` — use `ctx.sendFile`
  rather than manual `fs` reads.
- **Native primitives** fall back to pure-TS implementations when the `castrum`
  addon is unavailable; both paths are covered by the parity test suite.

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

Older versions are not supported.
