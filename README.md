<h1>
  <img src="butler-logo.png" alt="Butler" height="36" align="left">
  Carson
</h1>

[![Build](https://github.com/NexusPHP/carson/actions/workflows/build.yml/badge.svg?branch=1.x)](https://github.com/NexusPHP/carson/actions/workflows/build.yml)
[![Lint](https://github.com/NexusPHP/carson/actions/workflows/lint.yml/badge.svg?branch=1.x)](https://github.com/NexusPHP/carson/actions/workflows/lint.yml)
[![Test](https://github.com/NexusPHP/carson/actions/workflows/test.yml/badge.svg?branch=1.x)](https://github.com/NexusPHP/carson/actions/workflows/test.yml)
[![Typecheck](https://github.com/NexusPHP/carson/actions/workflows/typecheck.yml/badge.svg?branch=1.x)](https://github.com/NexusPHP/carson/actions/workflows/typecheck.yml)
[![Pages](https://github.com/NexusPHP/carson/actions/workflows/pages.yml/badge.svg?branch=1.x)](https://github.com/NexusPHP/carson/actions/workflows/pages.yml)

A GitHub App that manages your repository like a butler. Distributed as a GitHub Action.

Carson runs as a **per-consumer GitHub App**: each org or user that wants to use Carson registers their own App, generates a private key, and stores both as Actions secrets. The App identity ("Carson @ Acme") is yours, not ours. There is no central Carson App to install.

## Setup

The fastest path is the click-through installer at <https://nexusphp.github.io/carson/>. It POSTs Carson's [app-manifest](.github/app-manifest.json) to GitHub, walks you through confirming the App in your personal account or organization, and then shows you the App ID and private key with copy / download controls so you can save them as Actions secrets. Two browser tabs and you're done.

<details>
<summary>If you prefer to set up the App by hand, follow the manual steps below.</summary>

### 1. Register the GitHub App (manual)

Visit GitHub's "Register a new GitHub App" page:

- Personal account: <https://github.com/settings/apps/new>
- Organization: `https://github.com/organizations/<your-org>/settings/apps/new`

Fill in:

- **GitHub App name**: anything you like, for example `Carson @ <your-org>`.
- **Homepage URL**: your project URL or `https://github.com/NexusPHP/carson`.
- **Webhook**: uncheck **Active**. Carson does not receive webhooks. It is triggered by your workflow.
- **Repository permissions**:
  - **Checks**: Read and write (for the `signed-commits` check run).
  - **Contents**: Read-only (to read `.github/carson.yml`).
  - **Issues**: Read and write (to label, lock, and close issues and pull requests, and to comment on issues).
  - **Pull requests**: Read and write (to comment on pull requests, and to read PR metadata and commit lists).
- **Subscribe to events**: none.

These match the permissions captured in [`.github/app-manifest.json`](.github/app-manifest.json), which the click-through installer uses. New subscribers may request additional permissions, which their documentation will list.

### 2. Generate a private key

After the App is created, scroll to **Private keys** and click **Generate a private key**. A `.pem` file downloads. Treat it like any other secret: do not commit it, do not paste it into chat, do not share screenshots of it.

### 3. Install the App

In the App's settings, click **Install App** and select the repositories Carson should act on.

### 4. Store credentials as Actions secrets

In the repository (or organization, for multi-repo use), go to **Settings → Secrets and variables → Actions** and add:

- `CARSON_APP_ID`: the numeric App ID shown on the App's settings page.
- `CARSON_PRIVATE_KEY`: the full contents of the `.pem` file from step 2, including the `-----BEGIN`/`-----END` lines.

The secret names are conventional. The workflow snippet below uses `CARSON_*`. Use whatever names you prefer, as long as they match.

</details>

## Usage

### Workflow

Add a workflow to your repository at `.github/workflows/carson.yml`:

```yaml
name: Carson

on:
  pull_request_target:
    types: [opened, synchronize, reopened, edited, closed, ready_for_review, converted_to_draft]
  pull_request_review:
    types: [submitted]
  push:
  issues:
    types: [opened, edited]
  issue_comment:
    types: [created]
  schedule:
    - cron: '0 0 * * *'

jobs:
  carson:
    runs-on: ubuntu-latest
    steps:
      - uses: NexusPHP/carson@<commit-sha>  # v1.0.0
        with:
          app_id: ${{ secrets.CARSON_APP_ID }}
          private_key: ${{ secrets.CARSON_PRIVATE_KEY }}
```

The trigger list above covers every event Carson's bundled subscribers register. Trim entries you don't need. Per-subscriber triggers are listed in [SUBSCRIBERS.md](SUBSCRIBERS.md).

> [!IMPORTANT]
> Carson uses `pull_request_target` so that secrets (and the App's PEM) are available on pull requests opened from forks. Under `pull_request_target`, GitHub Actions runs the workflow file **from the base branch**, so changes to `.github/workflows/carson.yml` in a pull request will not take effect until that PR is merged. Carson never checks out or executes PR code, so the usual `pull_request_target` footgun (running untrusted code with secrets) does not apply. The action treats `pull_request_target` and `pull_request` as the same event internally, so you can use either trigger.

Pin to a specific commit SHA and let [Dependabot](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates) keep it updated via the trailing `# v1.0.0` comment. Carson does not maintain a moving `v1` tag: every release is a fixed `vX.Y.Z`.

### Configuration

Commit a `.github/carson.yml` to your default branch:

```yaml
version: 1
subscribers:
  - welcome
settings:
  welcome:
    first_time:
      pull_request: "Thanks for your first PR, @{{user}}! A reviewer will be with you shortly."
      issue: "Thanks for your first issue, @{{user}}! We'll look into it."
    returning:
      pull_request: "Thanks for the PR, @{{user}}!"
      # `issue:` left unset, so returning contributors fall back to the default issue message.
```

Carson reads its configuration from the **default branch only**, so pull requests cannot alter the bot's behavior by changing `carson.yml`.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `app_id` | yes | The GitHub App ID. |
| `private_key` | yes | The GitHub App private key (PEM contents). |
| `webhook_secret` | no | The GitHub App webhook secret. |
| `log_level` | no | One of `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Defaults to `warn`. Set to `info` to see startup identity, subscriber action logs, and other normal-flow output. The `LOG_LEVEL` env var works as a fallback if this input is not set. |

## Available subscribers

See [SUBSCRIBERS.md](SUBSCRIBERS.md) for the full reference: triggers, settings, required permissions, and examples for each.

- [**auto-labeler**](SUBSCRIBERS.md#auto-labeler): adds labels to PRs based on path globs, title/body regex, or branch name patterns, with optional sync mode.
- [**conflicts-notifier**](SUBSCRIBERS.md#conflicts-notifier): comments on PRs with merge conflicts and marks the comment resolved when fixed.
- [**lock-old-issues**](SUBSCRIBERS.md#lock-old-issues): locks closed issues that have been inactive past a configurable age.
- [**no-response-closer**](SUBSCRIBERS.md#no-response-closer): closes open issues and PRs carrying a configurable label whose activity has been stale past a threshold.
- [**pr-title-linter**](SUBSCRIBERS.md#pr-title-linter): validates PR titles against a configurable set of regex rules and reports the result as a check run.
- [**signed-commits**](SUBSCRIBERS.md#signed-commits): posts a check requiring every commit in a PR to be signed and verified.
- [**stale**](SUBSCRIBERS.md#stale): marks inactive issues and PRs stale, then closes them after a further grace period.
- [**template-enforcer**](SUBSCRIBERS.md#template-enforcer): comments on and labels issues or PRs whose description does not match the configured template, and clears the label when fixed.
- [**thanks**](SUBSCRIBERS.md#thanks): posts a thank-you comment when a pull request is merged by someone other than its author.
- [**triage-labeler**](SUBSCRIBERS.md#triage-labeler): labels pull requests with their review state (needs-review, needs-rework, approved), ignoring drive-by reviews from contributors without write access.
- [**welcome**](SUBSCRIBERS.md#welcome): greets contributors on pull requests and issues, with separate, configurable messages for first-time and returning contributors.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

The `dist/index.js` bundle is committed to the repository so consumers can run the action directly from a tag or SHA. CI will fail if `dist/` is out of date relative to `src/`.

### Running Carson locally

`npm run dev` boots Carson as a long-running Probot server with smee.io webhook forwarding, so subscribers can be iterated on against a sandbox GitHub App without a CI round-trip.

1. Register a separate "Carson Dev" GitHub App (same permissions as production) and install it on a throwaway repo. Pointing your production App at smee would break consumers' CI runs.
2. Open <https://smee.io/new> for a webhook proxy URL.
3. In the App's settings, set **Webhook URL** to the smee URL and check **Active**. Under **Permissions & events → Subscribe to events**, tick at least **Issues**, **Issue comment**, **Pull request**, **Pull request review**, and **Push** to mirror the production workflow triggers. Carson's production App leaves both the webhook and event subscriptions off because it is driven by Actions, but the dev App receives events only through webhooks.
4. Copy `.env.example` to `.env` and fill in `APP_ID`, `WEBHOOK_SECRET`, `WEBHOOK_PROXY_URL` (the smee URL), and the private key. Set either `PRIVATE_KEY` (inline PEM contents) or `PRIVATE_KEY_PATH` (path to the downloaded `.pem`, which is gitignored).
5. `npm run dev`. The server listens on `:3000` and dispatches each inbound webhook through the bundled subscribers.

Set `DEV_REPOSITORY=owner/repo` in `.env` to run the same preflight permission check that CI runs against that repo on boot. If the dev App is under-permissioned the server exits 1 before accepting webhooks. Leave it unset to skip preflight (under-permissioned subscribers will surface as runtime 403s in the logs instead).

The `schedule` cron handler is not wired in dev mode (scheduled subscribers don't fire). `pull_request_target` events are mirrored to `pull_request` so subscribers behave the same as in CI.

The `docs/` directory holds the click-through installer that's served at <https://nexusphp.github.io/carson/>. It is plain HTML and JavaScript with no build step. The [`pages.yml`](.github/workflows/pages.yml) workflow deploys it via GitHub Actions, running only when files under `docs/` (or the workflow itself) change on `1.x`.

## License

Released under the [MIT License](LICENSE).
