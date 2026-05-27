# Carson Subscribers

This document describes each subscriber Carson ships with: what it does, how to configure it, what events it reacts to, and what App permissions it needs.

To use a subscriber, list its ID under `subscribers:` in your repository's `.github/carson.yml`. Subscribers not listed there will not run, even though they are bundled with Carson.

<details>
<summary><strong>Index</strong></summary>

- [Template interpolation](#template-interpolation)
- [Comment markers](#comment-markers)
- Subscribers
  - [conflicts-notifier](#conflicts-notifier)
  - [lock-old-issues](#lock-old-issues)
  - [signed-commits](#signed-commits)
  - [stale](#stale)
  - [welcome](#welcome)

</details>

## Template interpolation

Any subscriber message you set in `carson.yml` may include `{{placeholder}}` tokens that are interpolated from a context dictionary. Syntax:

- `{{name}}` and `{{ name }}` are equivalent. Whitespace inside the braces is tolerated.
- The placeholder name must be a single `\w+` token (letters, digits, underscore). Anything more complex (`{{ user.name }}`, `{{ a-b }}`) is left verbatim.
- Unknown placeholders are also left verbatim, so a typo like `{{usre}}` will appear literally in the comment. This is intentional: silent empty-string substitution hides mistakes.

The context keys available depend on the event the subscriber handles. Each subscriber's section below lists its specific context.

### Universal context

These keys are available to every subscriber's interpolated messages regardless of event:

| Key | Value |
| --- | --- |
| `{{app_name}}` | The configured name of the GitHub App (e.g. `Carson @ your-org`), as set when the App was registered. Falls back to `Carson` if the App identity has not been resolved (rare). |
| `{{app_slug}}` | The URL-safe slug GitHub derives from the App name (e.g. `carson-your-org`). The App profile lives at `https://github.com/apps/{{app_slug}}`. Falls back to `carson`. Use this for the App URL or as a GitHub @-mention target (`@{{app_slug}}` resolves to the bot). |
| `{{app_login}}` | The bot user's GitHub login (e.g. `carson-your-org[bot]`), which is what appears as the author of Carson's comments and check runs. Falls back to `carson[bot]`. Use this when you want the exact author identifier rather than the URL slug. |

A subscriber-specific context key with the same name takes precedence over the universal one.

## Comment markers

Subscribers that need to find their own prior comment on a PR or issue (to edit, delete, or minimize it) embed a hidden HTML marker in the comment body. The marker is invisible in rendered comments but visible in the raw markdown.

Do not remove these markers from Carson comments. The subscriber relies on them to identify which comment is its own.

| Marker | Used by |
| --- | --- |
| `<!-- carson:conflicts-notifier -->` | [conflicts-notifier](#conflicts-notifier) |
| `<!-- carson:stale -->` | [stale](#stale) |

---

## conflicts-notifier

Posts a comment on a pull request that has merge conflicts with its base branch, and marks the comment as resolved when the conflict is fixed.

**Triggers**: `pull_request.opened`, `pull_request.synchronize`, `pull_request.reopened`, `push`
**Permissions**: `issues: write`, `pull_requests: read`

On `push` to a branch (e.g. `main` after a merge), Carson lists all open PRs targeting that branch and runs the per-PR check on each one. This catches the "PR was clean, base advanced, PR is now stale" case that pure `pull_request.*` triggers miss. Tag pushes (`refs/tags/*`) are ignored. For Carson to receive push events, your `.github/workflows/carson.yml` needs `on: push:` in its triggers.

Lifecycle per PR:

- Conflict appears, no prior comment: posts a new comment.
- Conflict appears, prior comment is minimized: unminimizes (re-opens) the existing comment.
- Conflict resolved, visible comment exists: minimizes the comment as `RESOLVED` via GitHub's GraphQL `minimizeComment` mutation. Visually this is the same as a maintainer clicking the comment's "Hide → Resolved" menu. The comment collapses into a "marked as resolved" badge with the text behind a click.
- Conflict resolved, no comment or already minimized: no-op.

There is at most one Carson conflict comment per PR for the PR's lifetime. State (visible vs. resolved) lives in the comment's minimized status. Reply threads underneath the comment are preserved across resolve/unresolve cycles.

If GitHub has not yet computed the PR's mergeable state (transient `mergeable: null` immediately after a push), Carson logs and skips. The next event on the PR catches up.

### Settings

| Key | Type | Default |
| --- | --- | --- |
| `message` | string | ``@{{user}} this PR has merge conflicts with `{{base}}`. Please rebase or resolve them.`` |

### Context

| Key | Value |
| --- | --- |
| `{{user}}` | GitHub login of the PR author |
| `{{repo}}` | Repository name |
| `{{number}}` | PR number |
| `{{title}}` | PR title |
| `{{base}}` | Base branch name |

### Example

```yaml
version: 1
subscribers:
  - conflicts-notifier
settings:
  conflicts-notifier:
    message: "@{{user}} #{{number}} conflicts with `{{base}}`. Please rebase."
```

---

## lock-old-issues

Locks closed issues that have been inactive past a configurable age, preventing necro-comments on resolved threads.

**Triggers**: scheduled (cron via `on: schedule:` in the consumer workflow)
**Permissions**: `issues: write`

On each scheduled run, the subscriber walks the repository's closed issues (paginated), skips pull requests, skips already-locked issues, skips issues whose `closed_at` is more recent than the configured threshold, skips issues carrying any of the exempt labels, and locks the rest using GitHub's lock reason classifier.

The action runner needs to receive `schedule` events for this to run. Add a cron schedule to your `.github/workflows/carson.yml`:

```yaml
on:
  schedule:
    - cron: '0 4 * * *'  # daily at 04:00 UTC
```

### Settings

| Key | Type | Default |
| --- | --- | --- |
| `days` | positive integer | `90` |
| `reason` | one of `off-topic`, `too heated`, `resolved`, `spam` | `resolved` |
| `exempt_labels` | array of strings | `[]` |
| `comment` | string | (no comment posted) |

If `comment` is set, Carson posts it on the issue *before* locking (you can't comment after the lock). The comment supports template interpolation.

### Context (for `comment`)

| Key | Value |
| --- | --- |
| `{{user}}` | GitHub login of the issue's original opener (left verbatim if the user is a ghost) |
| `{{number}}` | Issue number |
| `{{repo}}` | Repository name |
| `{{days}}` | The threshold in days (whatever's configured, defaulting to `90`) |

### Example

```yaml
version: 1
subscribers:
  - lock-old-issues
settings:
  lock-old-issues:
    days: 180
    reason: resolved
    exempt_labels:
      - pinned
      - security
    comment: |
      This issue has been quiet for {{days}} days, so I'm locking it to keep
      the discussion focused. If you have new information, please open a fresh
      issue and link back to this one.
```

---

## signed-commits

Posts a [Check Run](https://docs.github.com/en/rest/checks/runs) on each pull request that passes if every commit has a verified signature and fails if any commit is unsigned.

**Triggers**: `pull_request.opened`, `pull_request.synchronize`, `pull_request.reopened`
**Permissions**: `checks: write`, `pull_requests: read`

Each event re-evaluates every commit on the PR head and updates a single rolling check (keyed by check name, so updates replace rather than duplicate). The check's output lists the offending commits with the short SHA, first-line subject, and author name to help the contributor identify what needs re-signing.

GitHub considers a commit verified if it has a valid GPG, SSH, or S/MIME signature, or if it was created via GitHub's web UI / API (which signs automatically). Commits pushed from a developer machine without a signing key configured will appear unverified.

### Settings

| Key | Type | Default |
| --- | --- | --- |
| `name` | string | `Carson / signed-commits` |
| `treat_unsigned_as` | `"failure"` or `"neutral"` | `failure` |

`treat_unsigned_as: neutral` is useful for an advisory rollout: the check still appears in the PR's checks list but doesn't block merging. Flip to the default `failure` (or wire it into branch protection as required) once contributors have had time to set up signing.

### Example

```yaml
version: 1
subscribers:
  - signed-commits
settings:
  signed-commits:
    name: "Signed commits"
    treat_unsigned_as: neutral
```

---

## stale

Marks inactive issues and pull requests as stale, then closes them after a further grace period.

**Triggers**: scheduled (cron via `on: schedule:` in the consumer workflow)
**Permissions**: `issues: write`

On each scheduled run, the subscriber walks every open issue and PR. For each:

- If the item has any exempt label, skip.
- If the item already has the stale label and its `updated_at` is older than `days_until_close`, post the close message and close.
- Else if the item has no stale label and its `updated_at` is older than `days_until_stale`, apply the stale label and post the stale message.
- Otherwise, skip.

In addition, the subscriber listens to the following webhook events and **removes the stale label + minimizes Carson's stale notice as `OUTDATED`** when a stale item gets new human activity:

- `issue_comment.created`
- `issues.edited`
- `pull_request.synchronize`
- `pull_request.edited`
- `pull_request_review.submitted`

The stale notice is identified by the hidden marker `<!-- carson:stale -->` appended to its body. If the marker isn't found (e.g. on items that became stale before this version shipped), the label is still removed but no comment is minimized.

Bot senders (including Carson's own stale comment and Dependabot's auto-rebase) do not un-stale. The signal is meant to capture maintainer attention specifically. To re-enable a closed-by-stale item, a maintainer can reopen it manually. The next scheduled run will not re-stale it for `days_until_stale` more days.

Add a cron schedule to your `.github/workflows/carson.yml` so the action runs periodically:

```yaml
on:
  schedule:
    - cron: '0 4 * * *'  # daily at 04:00 UTC
```

### Settings

| Key | Type | Default |
| --- | --- | --- |
| `days_until_stale` | positive integer | `60` |
| `days_until_close` | positive integer | `7` |
| `stale_label` | string | `stale` |
| `stale_message` | string | `This {{type}} has been inactive for {{days_inactive}} days. It will be closed in {{days_until_close}} days without further activity.` |
| `close_message` | string | `Closing this {{type}} due to extended inactivity.` |
| `exempt_labels` | array of strings | `[]` |

### Context

| Key | Value |
| --- | --- |
| `{{user}}` | GitHub login of the item's author (left verbatim if the user is a ghost) |
| `{{number}}` | Issue or PR number |
| `{{repo}}` | Repository name |
| `{{title}}` | Item title |
| `{{type}}` | `issue` or `pull request` |
| `{{days_inactive}}` | The configured `days_until_stale` value |
| `{{days_until_close}}` | The configured `days_until_close` value |

### Example

```yaml
version: 1
subscribers:
  - stale
settings:
  stale:
    days_until_stale: 60
    days_until_close: 14
    stale_label: stale
    stale_message: |
      @{{user}} this {{type}} has been inactive for {{days_inactive}} days
      and is being marked stale. It will be closed in {{days_until_close}}
      days without further activity.
    close_message: |
      Closing this {{type}} due to extended inactivity. Feel free to open
      a fresh issue if this still matters and link back to {{number}}.
    exempt_labels:
      - pinned
      - security
```

---

## welcome

Greets contributors on pull requests and issues. First-time and returning contributors are configured independently.

**Triggers**: `pull_request.opened`, `issues.opened`
**Permissions**: `issues: write`

Carson resolves the author's `author_association` to one of two buckets, `first_time` or `returning`, and posts the message for that bucket and event (PR or issue). Bots and ghost-user payloads are always skipped. With no `settings.welcome` configured, all four cells use the default messages below, so a bare `subscribers: [welcome]` greets both first-time and returning contributors.

### Settings

`settings.welcome` has two parallel sub-objects, `first_time` and `returning`, each with the same shape:

| Key | Type | `first_time` default | `returning` default |
| --- | --- | --- | --- |
| `pull_request` | string | `Thanks for opening your first pull request, @{{user}}!` | `Thanks for the pull request, @{{user}}!` |
| `issue` | string | `Thanks for opening your first issue, @{{user}}!` | `Thanks for filing this, @{{user}}!` |
| `author_association` | array | `[FIRST_TIMER, FIRST_TIME_CONTRIBUTOR]` | `[CONTRIBUTOR, MEMBER, COLLABORATOR, OWNER]` |

`author_association` lets you narrow the set of [associations](https://docs.github.com/en/graphql/reference/enums#commentauthorassociation) each bucket reacts to. The values allowed in each bucket are constrained to its default list. The `first_time` bucket only accepts `FIRST_TIMER` and `FIRST_TIME_CONTRIBUTOR`. The `returning` bucket only accepts `CONTRIBUTOR`, `MEMBER`, `COLLABORATOR`, and `OWNER`. Listing a value outside the allowed set fails schema validation.

Use an empty list (`author_association: []`) to disable a whole bucket. Associations that fall outside both bucket lists (notably `NONE` and `MANNEQUIN`, also any value you exclude via a narrowed list) get no greeting.

### Context

| Key | Value |
| --- | --- |
| `{{user}}` | GitHub login of the author |
| `{{repo}}` | Repository name |
| `{{number}}` | PR or issue number |
| `{{title}}` | PR or issue title |

### Example

```yaml
version: 1
subscribers:
  - welcome
settings:
  welcome:
    first_time:
      pull_request: "Welcome @{{user}}! Thanks for opening {{title}} on {{repo}}."
      issue: "Hi @{{user}}, thanks for filing your first issue."
    returning:
      pull_request: "Thanks for the PR, @{{user}}!"
      author_association: [CONTRIBUTOR, COLLABORATOR]
```
