# Repository Guidelines

## Project Structure & Module Organization

- `client/` contains the React/TypeScript interface, page components, and shared styles. Static assets live in `client/public/`.
- `server/` contains Express routes, authentication, persistence, subscription parsing, configuration compilation, Mihomo validation, and AI integration.
- `shared/types.ts` defines shared workspace models and reference utilities.
- `tests/` contains core, HTTP integration, and proxy-chain runtime tests. `scripts/setup.mjs` installs pinned Mihomo and Sub-Store dependencies.
- `dist/`, `bin/`, and `data/` hold generated output, downloaded dependencies, and local state. They are ignored by Git.

## Build, Test, and Development Commands

Use Node.js 24 or newer and run commands from the project root.

- `npm ci` installs dependencies from the lockfile.
- `npm run setup` downloads the required parsing and validation dependencies. Run it before tests or publication.
- `npm run dev` starts the API on port 3000 and Vite on port 5173.
- `npm run check` performs strict TypeScript checking.
- `npm test` runs the test suite serially through `tsx` and Node's test runner.
- `npm run build` checks types and builds the frontend into `dist/`.
- `npm start` serves the API and built frontend. Set `PUBLIC_URL` to the actual browser origin first.

## Coding Style & Naming Conventions

Follow the existing two-space indentation, double quotes, semicolons, and trailing commas. Use PascalCase for React components, camelCase for functions and variables, and lowercase names for server modules. Preserve existing ESM import conventions. Match the current Prettier formatting. Package scripts provide type checking, with no configured lint command.

## Testing Guidelines

Name tests `tests/*.test.ts` and use descriptive behavior statements with `node:test` and `node:assert/strict`. Add focused regression tests for changed behavior. Cover node identity, reference validation, chain order, account isolation, and safe refresh behavior. No numeric coverage threshold is configured. Report mocked AI checks separately from real model calls.

## Commit & Pull Request Guidelines

Use concise imperative messages, such as `Fix provider refresh references`. Pull requests should describe the behavior changed, link relevant issues, record verification commands and results, and include screenshots for interface changes.

## Security & Configuration

Use `.env.example` as the configuration reference. Keep credentials, subscription tokens, encryption keys, and runtime data out of commits and logs. Route user-supplied remote URLs through the existing guarded fetch implementation. Preserve draft/publication separation and revision conflict checks. Maintain attribution and AGPL-3.0 license compatibility when reusing dependencies.
