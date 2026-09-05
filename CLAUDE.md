# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Carson is

Carson is a GitHub App distributed as a GitHub Action. It is **not** a hosted app. Each consumer registers their own GitHub App and supplies the App ID and PEM via the action's `app_id` / `private_key` inputs (see [README.md](README.md) and [action.yml](action.yml)).

At runtime the Action boots a [Probot](https://probot.github.io) instance in-process, loads the bundled subscribers, and dispatches a single event read from `GITHUB_EVENT_PATH`. The action exits as soon as that event is handled. There is no long-running server.

The shipped artifact is [dist/index.js](dist/index.js), a single ESM bundle built by esbuild. It is committed to the repo so consumers can pin `NexusPHP/carson@<sha>` without a build step. CI fails the [Build](.github/workflows/build.yml) job if `dist/` is out of date relative to `src/`.

## Commands

```sh
npm install
npm run lint         # eslint src tests docs *.config.ts
npm run lint:fix
npm run typecheck    # tsc --noEmit
npm test             # vitest run --coverage  (100% line/branch/fn/stmt thresholds enforced)
npm run build        # esbuild → dist/index.js (must be committed)
npm run all          # lint + typecheck + test
```

Run a single test file or filter by name:

```sh
npx vitest run tests/subscribers/welcome.test.ts
npx vitest run -t 'interpolates'
```

Coverage is enforced at 100% across `src/**/*.ts` (excluding `src/index.ts`). A failing coverage check is a real failure, not a warning. Add tests rather than lowering the threshold.

Engines: Node `^24 || ^26`, npm `^11`. CI runs the matrix on Node 24 and 26.

## Architecture

### Entrypoint and dispatch

[src/index.ts](src/index.ts) is the action entry. It reads `GITHUB_EVENT_NAME` / `GITHUB_EVENT_PATH` / `GITHUB_RUN_ID` / `GITHUB_REPOSITORY` from the runner environment, constructs a Probot via `createProbot({ overrides: { appId, privateKey, secret? } })`, runs a preflight (see below) to resolve the App identity and the repo's enabled subscriber list, registers only those subscribers via `carson.run(probot, preflight.enabledIds)`, then dispatches:

- If `eventName === 'schedule'`: calls `dispatchScheduled(probot, carson.scheduled, GITHUB_REPOSITORY, payload)`. Scheduled events do not flow through Probot's webhook router (they have no installation in the payload), so the dispatcher resolves the installation via `apps.getRepoInstallation` and invokes each registered handler with a hand-built `ScheduledContext`.
- Otherwise: hands the payload to `probot.receive(...)`, which routes to the standard webhook handlers each subscriber registered. The entrypoint rewrites `pull_request_target` to `pull_request` before delivery (identical payload shape), so subscribers register `pull_request.*` once and fire for both triggers. Consumers should prefer `pull_request_target` in their workflow because `pull_request` does not expose secrets on fork PRs.

The preflight ([src/preflight.ts](src/preflight.ts) `runPreflight(...)`) fetches the App via `apps.getAuthenticated`, loads `carson.yml`, and compares the App's `permissions` to the union of `BASE_PERMISSIONS` (`contents: read` for loading `carson.yml`) and each enabled subscriber's `requiredPermissions`. If anything is missing or under-granted, the action `setFailed`s with a per-subscriber breakdown and a link to the App's settings page, before any subscriber gets a chance to 403. This exists because the per-consumer App model has no mechanism to push permission upgrades: when we add a permission to [`.github/app-manifest.json`](.github/app-manifest.json), existing consumer-owned Apps don't auto-upgrade, so the preflight catches the mismatch loudly instead of letting the subscriber fail with a confusing 403.

Because the permission check already needs the resolved installation and `carson.yml`, `runPreflight` returns that config's `subscribers` list as `enabledIds` alongside the pass/fail `error`, and the entrypoint uses it to register only the configured subscribers. A subscriber left out of `subscribers:` never gets a webhook or scheduled handler attached at all, not merely a no-op when one later fires. When the check can't resolve the installation or the App lookup (App not installed, transient API failure), `enabledIds` is `undefined` and `carson.run` falls back to registering everything, same as before this filtering existed. Each subscriber still self-gates per event via `loadEnabledConfig` regardless of whether it was filtered at registration time, so a bug in the filtering path fails safe. When `carson.yml` is absent entirely, `enabledIds` is `[]` and no subscriber is registered.

A `probot.onError` handler flips a `handlerFailed` flag so the action fails the run if any subscriber threw. **A thrown subscriber does not abort other subscribers.** They all run and the action fails at the end.

### The Carson class and Subscriber contract

[src/carson.ts](src/carson.ts) holds a list of `Subscriber` instances and wires them up on `run(probot, enabledIds?)`. When `enabledIds` is given, only subscribers whose `id` is in the list are registered and logged. When omitted, every subscriber registers. Tests and [src/dev.ts](src/dev.ts) rely on the latter: they load [src/app.ts](src/app.ts)'s default export (`carson.app`, which calls `run(probot)` with no filter) so any subscriber can be exercised regardless of a repo's `carson.yml`. Each `Subscriber` ([src/subscriber.ts](src/subscriber.ts)) implements:

- `id: string`: must match the ID consumers list under `subscribers:` in `.github/carson.yml`.
- `description: string`.
- `requiredPermissions: RequiredPermissions`: the GitHub App permissions this subscriber needs at runtime (e.g. `{ issues: 'write', pull_requests: 'write' }`). Used by [src/preflight.ts](src/preflight.ts) to fail the workflow with a clear error when the App is under-permissioned. Must match the per-subscriber row in [SUBSCRIBERS.md](SUBSCRIBERS.md) and the actual API calls in the handler. Note: posting a comment on a pull request via `octokit.rest.issues.createComment` requires `pull_requests: write`. The GitHub REST docs for the endpoint say either `issues: write` or `pull_requests: write` suffices, but in practice the API only honors `pull_requests: write` when the target is a PR. The `issues: write` permission still applies to comments on real issues and to other issue actions (labeling, locking, closing).
- `register(probot)`: attach webhook handlers via `probot.on('event.action', handler)`.
- `registerScheduled(registrar)` (optional): attach a `ScheduledHandler` for cron runs.
- `registerActions(registrar)` (optional): claim ownership of a cross-subscriber action (see below).
- `loadEnabledConfig(context)`: inherited helper that returns the parsed `CarsonConfig` only if the subscriber's `id` is listed under `subscribers:`. Returns `null` (and the handler should bail) if the config is missing, invalid, or doesn't enable this subscriber.

### Cross-subscriber actions

Subscribers do one job each. When one needs another's job done (a mirror guard that closes a PR and wants it locked), it does not call the API itself: it dispatches an action through the router in [src/actions.ts](src/actions.ts), and the subscriber that owns that job handles it. Owners claim an action in `registerActions(registrar)` via `registrar.on('lock', this.id, handler)`. Exactly one owner per action, enforced at registration. Requesters call the inherited `this.dispatch('lock', context, { number })`, which resolves `false` when no enabled subscriber owns the action (after a warning) or when the owner declines it (it is registered but not enabled for the repo, as happens in tests that load the whole app), so a missing owner degrades rather than fails the run. Owners return `true` only when they actually acted. The action vocabulary is the `ActionRequests` interface: add a key there to introduce a new action. Owners are whichever subscribers override `registerActions`.

All registered subscriber IDs are pushed into [src/configuration/cache.ts](src/configuration/cache.ts) via `setRegisteredSubscribers` so the cache layer can warn about unknown IDs in user config.

### Adding a new subscriber

1. Create `src/subscribers/<id>.ts` exporting a class that extends `Subscriber`.
2. Register it in [src/app.ts](src/app.ts). The constructor argument to `new Carson([...])` is the source of truth.
3. Document it in [SUBSCRIBERS.md](SUBSCRIBERS.md) (triggers, permissions, settings, interpolation context, example) and add a link from the index in [README.md](README.md).
4. Add tests under `tests/subscribers/<id>.test.ts` following the pattern in [tests/subscribers/welcome.test.ts](tests/subscribers/welcome.test.ts): a real `Probot` plus nock-mocked GitHub API plus `probot.receive(...)`.
5. If the subscriber needs an event the consumer workflow doesn't yet emit, note it in `SUBSCRIBERS.md`. The consumer's `.github/workflows/carson.yml` must include the trigger.
6. For `repository_dispatch` events, register the plain event name and branch on `payload.action` (the sender's custom `event_type`): custom event types are not in octokit's event-name union, so the action-qualified form does not typecheck. Routing is verified in [tests/repository-dispatch.test.ts](tests/repository-dispatch.test.ts).

### Untrusted PR content under `pull_request_target`

The recommended consumer workflow (see [README.md](README.md)) uses `on: pull_request_target`, which puts the App's PEM in scope even on fork PRs. PR title, body, branch name, commit messages, label names, and head ref content are **attacker-controlled** under that trigger. Carson is safe today because no subscriber checks out or executes PR code. Every operation is an API call.

When reviewing or adding a subscriber that reads PR-supplied strings, watch for:

- **Marker forgery.** Subscribers locate their own prior comments by hidden HTML markers like `<!-- carson:conflicts-notifier -->`. Three layers defend the lookup:
  1. `find(...)` in `conflicts-notifier` and `stale` requires bot-authored comments (`comment.user.type === 'Bot'` for REST, `author.__typename === 'Bot'` for GraphQL).
  2. The lookup uses `endsWith(COMMENT_MARKER)`. A marker that ended up mid-body via attacker-controlled interpolation does not match.
  3. `interpolate(...)` in [src/template.ts](src/template.ts) strips any `<!-- carson:* -->` from substituted values, so a PR title cannot smuggle a marker into a bot-posted comment in the first place.

  New marker-using subscribers must keep all three guarantees: append the marker last, filter on bot author, and anchor the lookup with `endsWith`. A residual narrow vector remains if another installed bot posts a comment ending with the same marker. For defense in depth, add a `performed_via_github_app.id` check (REST only, not exposed on GraphQL's `IssueComment`).
- **Echoing untrusted text into Markdown.** `interpolate(...)` strips carson markers but does not otherwise escape markdown. A PR title containing `[click](http://evil)` interpolated into a comment body still renders as a clickable link. [src/subscribers/signed-commits.ts](src/subscribers/signed-commits.ts) has an `escapeMarkdown` helper that escapes link/image/HTML/code specials (backslash, backtick, square brackets, parens, angle brackets, exclamation) and applies it to attacker-controlled commit subject and author in the check output. Apply the same escape when echoing PR-supplied text where link or image rendering would matter.
- **PR-body-driven configuration.** Carson's config invariant is "default branch only" ([src/configuration/cache.ts:5-12](src/configuration/cache.ts#L5-L12)). A subscriber that treats `/skip` or similar directives in a PR body as configuration bypasses that invariant. Acceptable for cosmetic toggles. Risky for security-relevant subscribers like `signed-commits`.
- **Following links from the body** (SSRF, IP leak, attacker-controlled response bodies), or feeding body content into a shell, a templating engine with expressions, or an LLM with tools. None of this exists today. Flag in review if it lands.

### Configuration

`.github/carson.yml` on the **default branch** is the single source of truth. PRs cannot change Carson's behavior by editing it. The schema is in [src/configuration/schema.ts](src/configuration/schema.ts):

```yaml
version: 1
subscribers: [welcome, stale]
settings:
  welcome:
    pull_request: "..."
```

[src/configuration/cache.ts](src/configuration/cache.ts) caches the parsed config per `owner/repo` for the lifetime of the process so multiple subscribers handling the same event don't refetch. **Tests must call `resetConfigCache()` in `beforeEach`** or stale config bleeds between cases.

Per-subscriber settings are validated lazily by each subscriber with its own Zod schema via `subscriberSettings(config, this.id, Settings)`. Unknown settings are silently ignored by Zod's default behavior.

### Templates

[src/template.ts](src/template.ts) is a deliberately minimal `{{name}}` / `{{ name }}` interpolator. Only `\w+` placeholders are recognized. Anything more complex (`{{ user.name }}`) is left verbatim, and unknown placeholders are left verbatim too (silent empty-string substitution would hide typos). Each call passes a `TemplateContext` dictionary. Each subscriber documents the context keys it exposes in [SUBSCRIBERS.md](SUBSCRIBERS.md#template-interpolation).

### Comment markers

Subscribers that need to find their own prior comment (to minimize, unminimize, or edit it) embed a hidden HTML marker like `<!-- carson:conflicts-notifier -->`. When adding a subscriber that posts trackable comments, pick a unique marker and list it in the table in [SUBSCRIBERS.md](SUBSCRIBERS.md#comment-markers).

### docs/

[docs/](docs/) holds the click-through GitHub App installer served at <https://nexusphp.github.io/carson/>. Plain HTML and JS, no build step. The [Pages workflow](.github/workflows/pages.yml) only runs when files under `docs/` (or the workflow itself) change on `1.x`.

## Testing patterns

- Webhook subscribers: spin up a real `Probot`, `await probot.load(app)`, mock the installation token and config endpoints with `nock`, then call `probot.receive({ id, name, payload })`. See [tests/subscribers/welcome.test.ts](tests/subscribers/welcome.test.ts).
- Scheduled subscribers: tests can either hit `dispatchScheduled` directly with a stubbed Probot (see [tests/scheduled.test.ts](tests/scheduled.test.ts)) or build a `ScheduledContext` manually and call the subscriber's run method.
- [tests/setup.ts](tests/setup.ts) mocks `@actions/core` so `core.warning(...)` and friends are no-ops in tests.
- `nock.disableNetConnect()` in `beforeAll` is the convention. Any unmocked request will fail loudly.

## Style

ESLint config in [eslint.config.ts](eslint.config.ts) is strict: `typescript-eslint` strict plus stylistic, plus `sort-imports` (member syntax order: `none, all, multiple, single`), `consistent-type-imports`, `strict-boolean-expressions`, `prefer-nullish-coalescing`, and 2-space / single-quote / semi formatting via `@stylistic`. Run `npm run lint:fix` before committing.

TypeScript ([tsconfig.json](tsconfig.json)) enables `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `noUnusedLocals`, and `noUnusedParameters`. All imports must use the `.js` extension (NodeNext / `node16` module resolution) even though sources are `.ts`.

## Release flow

`npm run release -- X.Y.Z` ([.github/scripts/release.sh](.github/scripts/release.sh)) bumps `package.json`, the lockfile, and the trailing `# vX.Y.Z` pin comments in README.md and the installer page after checking the version format and that `vX.Y.Z` isn't already tagged on origin. It never commits, tags, or pushes: commit the bump, tag `vX.Y.Z`, and push both yourself. The tag push triggers [release.yml](.github/workflows/release.yml), which creates a draft GitHub Release via `gh release create`. Carson does **not** maintain a moving `v1` tag. Every release is a fixed `vX.Y.Z` and consumers pin a commit SHA with a trailing `# vX.Y.Z` comment for Dependabot.
