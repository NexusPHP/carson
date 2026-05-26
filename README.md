# Carson

A GitHub App that manages your repository like a butler. Distributed as a GitHub Action.

Carson runs as a **per-consumer GitHub App**: each org or user that wants to use Carson registers their own App, generates a private key, and stores both as Actions secrets. The App identity ("Carson @ Acme") is yours, not ours. There is no central Carson App to install.

## Setup

The fastest path is the click-through installer at <https://nexusphp.github.io/carson/>. It POSTs Carson's [app-manifest](.github/app-manifest.json) to GitHub, walks you through confirming the App in your personal account or organization, and then shows you the App ID and private key with copy / download controls so you can save them as Actions secrets. Two browser tabs and you're done.

If you prefer to set up the App by hand, follow the manual steps below.

### 1. Register the GitHub App (manual)

Visit GitHub's "Register a new GitHub App" page:

- Personal account: <https://github.com/settings/apps/new>
- Organization: `https://github.com/organizations/<your-org>/settings/apps/new`

Fill in:

- **GitHub App name**: anything you like, for example `Carson @ <your-org>`.
- **Homepage URL**: your project URL or `https://github.com/NexusPHP/carson`.
- **Webhook**: uncheck **Active**. Carson does not receive webhooks. It is triggered by your workflow.
- **Repository permissions**:
  - **Contents**: Read-only (to read `.github/carson.yml`).
  - **Issues**: Read and write (to comment on issues and pull requests).
- **Subscribe to events**: none.

The minimum required permissions are also captured in [`.github/app-manifest.json`](.github/app-manifest.json) for reference. New subscribers may request additional permissions, which their documentation will list.

### 2. Generate a private key

After the App is created, scroll to **Private keys** and click **Generate a private key**. A `.pem` file downloads. Treat it like any other secret: do not commit it, do not paste it into chat, do not share screenshots of it.

### 3. Install the App

In the App's settings, click **Install App** and select the repositories Carson should act on.

### 4. Store credentials as Actions secrets

In the repository (or organization, for multi-repo use), go to **Settings → Secrets and variables → Actions** and add:

- `CARSON_APP_ID`: the numeric App ID shown on the App's settings page.
- `CARSON_PRIVATE_KEY`: the full contents of the `.pem` file from step 2, including the `-----BEGIN`/`-----END` lines.

The secret names are conventional. The workflow snippet below uses `CARSON_*`. Use whatever names you prefer, as long as they match.

## Usage

### Workflow

Add a workflow to your repository at `.github/workflows/carson.yml`:

```yaml
name: Carson

on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches: [main]
  issues:
    types: [opened]
  issue_comment:
    types: [created]

jobs:
  carson:
    runs-on: ubuntu-latest
    steps:
      - uses: NexusPHP/carson@<commit-sha>  # v1.0.0
        with:
          app_id: ${{ secrets.CARSON_APP_ID }}
          private_key: ${{ secrets.CARSON_PRIVATE_KEY }}
```

Pin to a specific commit SHA and let [Dependabot](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates) keep it updated via the trailing `# v1.0.0` comment. Carson does not maintain a moving `v1` tag: every release is a fixed `vX.Y.Z`.

### Configuration

Commit a `.github/carson.yml` to your default branch:

```yaml
version: 1
subscribers:
  - welcome
settings:
  welcome:
    pull_request: "Thanks for the PR! A reviewer will be with you shortly."
    issue: "Thanks for reporting this. We'll look into it."
```

Carson reads its configuration from the **default branch only**, so pull requests cannot alter the bot's behavior by changing `carson.yml`.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `app_id` | yes | The GitHub App ID. |
| `private_key` | yes | The GitHub App private key (PEM contents). |
| `webhook_secret` | no | The GitHub App webhook secret. |

## Available subscribers

See [SUBSCRIBERS.md](SUBSCRIBERS.md) for the full reference: triggers, settings, required permissions, and examples for each.

- **conflicts-notifier**: comments on PRs with merge conflicts and marks the comment resolved when fixed.
- **welcome**: greets first-time contributors on their first pull request or issue.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

The `dist/index.js` bundle is committed to the repository so consumers can run the action directly from a tag or SHA. CI will fail if `dist/` is out of date relative to `src/`.

The `docs/` directory holds the click-through installer that's served at <https://nexusphp.github.io/carson/>. It is plain HTML and JavaScript with no build step. GitHub Pages is configured to deploy from the `1.x` branch's `/docs` folder.

## License

Released under the [MIT License](LICENSE).
