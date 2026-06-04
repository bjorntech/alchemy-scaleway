# Contributing

Thanks for helping improve `@finnvid/alchemy-scaleway`.

## Development

Use Bun for local development:

```sh
bun install
```

Before opening a pull request, run:

```sh
bun run check
bun test
bun run coverage
bun run crap
```

Run `bun run coverage` before `bun run crap` so the CRAP report uses fresh coverage data.

## Provider Guidelines

- Keep the flat source layout under `src/`.
- Use Alchemy v2 `Resource` plus `Provider.effect(...Provider.of({ read, reconcile, delete }))`.
- Keep direct Scaleway API calls in `src/Clients.ts`.
- Keep Object Storage S3-compatible behavior separate from REST clients.
- Use `ScalewayError` for typed cloud/API failures.
- Do not commit secrets or local `.env` files.
- Gate live Scaleway tests behind explicit opt-in environment variables.

See `ARCHITECTURE.md` and `AGENTS.md` for more detailed project conventions.

## Pull Requests

- Keep pull requests small and focused.
- Explain what changed, why it changed, and how you verified it.
- Use conventional commit-style PR titles: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, or `test:`. Optional scopes are fine, for example `feat(secret): add version lifecycle`.
- For new resources, major behavior changes, or adoption/ownership changes, open an issue or short design note first.
- Avoid long AI-generated walls of text in issues and PRs. Keep descriptions concise and specific.
- Include screenshots only when changing visual documentation or generated docs output.

## Adding Resources

Before implementing a new Scaleway API area, read `docs/resource-bring-up.md` and classify the work as a resource, helper, runtime binding, or intentionally deferred API surface.
