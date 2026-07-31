# Contributing

Altair welcomes focused issues and pull requests. By contributing, you agree
that your contribution is available under MPL-2.0 and that you have the right
to submit it.

## Development

Use Node 20+, pnpm 11.14, and a sibling Vega checkout while the shared protocol
is unpublished:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack --dry-run
```

Changes to WebGAL conversion belong in the independent
`altair-plugin-webgal` repository and need fixtures for untouched round trips,
edited round trips, unknown commands, source spans, diagnostics, and line endings.
Changes to preview behavior need request identity, revision, cancellation, and
lifecycle tests. UI changes must remain keyboard-operable, reflow without
horizontal scrolling at 390 CSS pixels, expose useful labels/live status, and
honor reduced motion.

Do not copy GPL/LGPL reference source. Preserve all MPL file notices; adapted
WebGAL work must retain its notice in the compatibility-plugin repository.

## Pull requests

- Keep one architectural concern per pull request.
- Add or update tests and user-facing documentation.
- Describe compatibility and migration effects explicitly.
- Include screenshots for Altair interface changes.
- Run `git diff --check` and the complete `pnpm check`.
- Do not commit secrets, generated `dist`, local projects, or user assets.
