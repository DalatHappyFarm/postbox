# Contributing

Thanks for helping.

- Open an issue first for anything bigger than a small fix.
- `pnpm install`, then `pnpm test` and `pnpm typecheck` must pass.
- Keep changes small and add a test for new behaviour.
- The API and database keep their technical names (feedback, project, status values) so existing clients do not break.
- Never commit secrets: `.env*` and `.dev.vars` are git-ignored.
- By contributing you agree your work is released under the MIT license.

## Releasing the npm packages

Bump `version` in `packages/cli/package.json` or `packages/react-native/package.json` and merge to `main`.
The Release workflow (`.github/workflows/release.yml`) runs the checks and publishes every package whose version is not on npm yet.
npm trusts that workflow through trusted publishing, so nobody logs in to npm and there is no token to renew.

## Deploying the web app

Merge to `main`: when the dashboard, API, widget or migrations changed, the Deploy workflow (`.github/workflows/deploy.yml`) runs the checks, then migrates and deploys staging, checks that it answers, and does the same for production.
By hand, `scripts/deploy.sh <branch>` deploys and checks one environment (`main` is production, `staging` is staging, any other name is a preview); run that environment's migrations first.
