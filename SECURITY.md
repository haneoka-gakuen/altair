# Security policy

## Reporting

Report vulnerabilities through GitHub's private vulnerability reporting for
the repository when available. Do not file a public issue for preview-token
bypass, origin confusion, path traversal, code execution, project-content
injection, or dependency compromise. Include affected versions, impact, a
minimal reproduction, and any known mitigation.

No response SLA is promised before the first stable release. Maintainers will
acknowledge, reproduce, coordinate a fix and advisory, and credit reporters
who want attribution.

## Supported versions

Before 1.0, only the latest released minor version receives security fixes.

## Trust boundaries

- WebGAL and project files are untrusted input.
- AI output is a review-required draft, never an executable authority.
- Preview bootstrap requires an exact origin, one-use token, complete identity,
  payload limits, timeouts, and a transferred `MessagePort`.
- `AltairPluginHost` is for trusted in-process plugins. Untrusted plugins need a
  Worker, sandboxed frame, or separate-process capability broker.
- Altair must not receive ambient filesystem or network authority merely
  because it runs inside a desktop shell.
