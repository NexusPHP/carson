# Carson Subscribers

This document describes each subscriber Carson ships with: what it does, how to configure it, what events it reacts to, and what App permissions it needs.

To use a subscriber, list its ID under `subscribers:` in your repository's `.github/carson.yml`. Subscribers not listed there will not run, even though they are bundled with Carson.

<details>
<summary><strong>Index</strong></summary>

- [Template interpolation](#template-interpolation)
- [Comment markers](#comment-markers)
- Subscribers
  - [auto-labeler](#auto-labeler)
  - [conflicts-notifier](#conflicts-notifier)
  - [issue-intake](#issue-intake)
  - [lock-old-issues](#lock-old-issues)
  - [no-response-closer](#no-response-closer)
  - [pr-title-linter](#pr-title-linter)
  - [read-only](#read-only)
  - [signed-commits](#signed-commits)
  - [stale](#stale)
  - [template-enforcer](#template-enforcer)
  - [thanks](#thanks)
  - [triage-labeler](#triage-labeler)
  - [webhook-notifier](#webhook-notifier)
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
| `<!-- carson:issue-intake:{event_type}:{ref} -->` | [issue-intake](#issue-intake), [webhook-notifier](#webhook-notifier) |
| `<!-- carson:stale -->` | [stale](#stale) |
| `<!-- carson:template-enforcer -->` | [template-enforcer](#template-enforcer) |

---

## auto-labeler

Adds labels to pull requests based on path globs, title or body regex, or branch name patterns, and to issues based on title or body regex. Rules are evaluated on every PR or issue event, and (optionally) labels Carson added that no longer match are removed.

**Triggers**: `pull_request.opened`, `pull_request.reopened`, `pull_request.synchronize`, `pull_request.edited`, `issues.opened`, `issues.edited`
**Permissions**: `issues: write`, `pull_requests: write`

Each rule pairs a single `label` with one or more *criteria*. A rule matches when **any** criterion matches (OR semantic across criteria within the same rule). The label is added when at least one rule for that label matches. PR rules live under `rules`, issue rules under `issue_rules`, and the two lists are independent.

The `pulls.listFiles` API call is only made when at least one rule uses `files`. PRs whose rules are purely title/body/branch-based avoid the extra round trip.

### Overlap with `actions/labeler`

GitHub publishes [`actions/labeler`](https://github.com/actions/labeler) for the same use case. Differences worth knowing before choosing:

- **Config location**: `auto-labeler` reuses `.github/carson.yml`. `actions/labeler` reads its own `.github/labeler.yml`.
- **Match dimensions**: `auto-labeler` supports title, body, head_branch, and base_branch regex in addition to globs. `actions/labeler` is glob-and-branch only.
- **Sync behavior**: `actions/labeler` defaults to syncing labels (removing labels it manages that no longer match). `auto-labeler` defaults to add-only and requires an explicit `sync_labels: true` to opt in.
- **Glob semantics**: `actions/labeler` exposes a richer matrix (`any-glob-to-any-file`, `all-globs-to-any-file`, etc.). `auto-labeler` exposes only `any` and `all`.

### Settings

| Key | Type | Default |
| --- | --- | --- |
| `sync_labels` | boolean | `false` |
| `rules` | array of PR rule objects (see below) | `[]` (PR events are ignored when empty) |
| `issue_rules` | array of issue rule objects: `label`, `title`, `body` only | `[]` (issue events are ignored when empty) |

Each PR rule object:

| Key | Type | Default |
| --- | --- | --- |
| `label` | string | required |
| `files` | array of glob strings, or `{ any?: string[]; all?: string[] }` | (no file matching) |
| `title` | array of regex strings | (no title matching) |
| `body` | array of regex strings | (no body matching) |
| `head_branch` | array of regex strings | (no head-branch matching) |
| `base_branch` | array of regex strings | (no base-branch matching) |

The `files` matcher accepts two shapes:

- A bare array (`files: ['src/api/**']`) is shorthand for `{ any: ['src/api/**'] }`: matches if any changed file matches any glob.
- An object lets you compose `any` and `all`. `all` matches only when every changed file matches at least one of its globs. When both `any` and `all` are present, both must hold.

Invalid globs and regexes are warning-logged and skipped, so one broken rule does not silence the others.

### Sync labels

With `sync_labels: false` (default), Carson only adds labels. Labels removed by maintainers stay removed even if a rule still matches on the next event.

With `sync_labels: true`, Carson reconciles the PR's labels against the rules: any label appearing in a rule's `label` field is "managed", and managed labels currently on the PR that no longer match are removed. Labels not declared in any rule (manually applied by maintainers, applied by other subscribers, etc.) are never touched.

> [!CAUTION]
> Patterns are compiled to JavaScript `RegExp` and matched with no runtime timeout. A catastrophically backtracking pattern in `carson.yml` will hang the action. Since `carson.yml` lives on the default branch only, this is a maintainer footgun rather than a contributor attack surface, but keep patterns simple and test them locally.

### Example

```yaml
version: 1
subscribers:
  - auto-labeler
settings:
  auto-labeler:
    sync_labels: false
    rules:
      - label: "area:api"
        files: ["src/api/**", "tests/api/**"]
      - label: "type:docs"
        files: ["**/*.md", "docs/**"]
        title: ["^docs?:"]
      - label: docs-only
        files:
          all: ["**/*.md", "docs/**"]
      - label: hotfix
        head_branch: ["^hotfix/"]
      - label: backport
        base_branch: ["^release/"]
      - label: needs-discussion
        body: ["NEEDS DISCUSSION"]
    issue_rules:
      - label: bug
        title: ["[Cc]rash", "[Bb]roken"]
      - label: feature-request
        title: ["^\\[feature\\]"]
```

---

## conflicts-notifier

Posts a comment on a pull request that has merge conflicts with its base branch, and marks the comment as resolved when the conflict is fixed.

**Triggers**: `pull_request.opened`, `pull_request.synchronize`, `pull_request.reopened`, `push`
**Permissions**: `issues: write`, `pull_requests: write`

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

## issue-intake

Turns a `repository_dispatch` event into a labeled GitHub issue carrying a hidden correlation marker, so an external system (an application backend, a script) can file issues through Carson and correlate them later.

**Triggers**: `repository_dispatch` (only the `event_type`s configured under `events`)
**Permissions**: `issues: write`

The sender calls [`POST /repos/{owner}/{repo}/dispatches`](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event) with an `event_type` matching a key under `events` and a flat `client_payload` (string or number values only, up to GitHub's 10-property cap). Carson validates the payload against the event's declared `fields`, interpolates the title and body templates, and creates the issue with the marker `<!-- carson:issue-intake:{event_type}:{ref} -->` appended as the final line of the body. A malformed payload fails the workflow run loudly: the sender is a machine, so a bad payload is a sender bug.

The `ref` is the value of the payload key named by `ref_field` and must match `^[\w.-]{1,64}$`. It is the correlation handle an external system uses to tie the issue back to its own record (see [webhook-notifier](#webhook-notifier) for the return path).

Delivery is at-least-once on the sender's side. The primary idempotency contract is sender-side (dispatch once per ref, retry only when the dispatch API call itself failed). `dedupe: true` adds a best-effort guard: before creating, Carson scans the most recent 100 issues carrying the event's static `labels` for the exact marker and skips creation on a hit.

### Settings

| Key | Type | Default |
| --- | --- | --- |
| `events` | map of `event_type` → event config (see below) | required, non-empty |

Each event config:

| Key | Type | Default |
| --- | --- | --- |
| `ref_field` | string, name of the `client_payload` key holding the correlation ref | required |
| `title` | template string | required |
| `body` | template string | required |
| `labels` | array of static label names | `[]` |
| `label_field` | string, payload key whose value is applied as an extra label | (none) |
| `label_allowlist` | array of allowed values for `label_field` | required when `label_field` is set |
| `fields` | map of payload key → `{ required?: boolean, escape?: boolean }` | `{}` |
| `dedupe` | boolean, scan for an existing issue with the same marker before creating | `false` |

A `label_field` value outside `label_allowlist` is skipped with a warning. The issue is still created. Labels are never created from raw payload values.

### Context

Only keys declared under `fields`, plus the `ref_field` key, reach the templates. Undeclared payload keys are left verbatim as `{{placeholder}}`. Fields with `escape: true` have markdown specials escaped (payload content originates from the sender's end users and is untrusted text). The title is truncated to 256 characters and the body to GitHub's 65536-character limit, marker included.

### Example

```yaml
version: 1
subscribers:
  - issue-intake
settings:
  issue-intake:
    events:
      support-ticket:
        ref_field: ticket_id
        title: "[{{kind}}] {{subject}}"
        body: |
          {{description}}

          ---
          Reported via the in-app support page. Ticket `{{ticket_id}}`.
        labels: [support]
        label_field: kind
        label_allowlist: [bug, feature-request]
        fields:
          kind: { required: true }
          subject: { required: true, escape: true }
          description: { required: true }
        dedupe: true
```

The consumer workflow needs the trigger:

```yaml
on:
  repository_dispatch:
    types: [support-ticket]
```

---

## lock-old-issues

Locks closed issues that have been inactive past a configurable age, preventing necro-comments on resolved threads. Optionally locks an issue the moment one of `lock_on_labels` is applied.

**Triggers**: scheduled (cron via `on: schedule:` in the consumer workflow), `issues.labeled`
**Permissions**: `issues: write`

On each scheduled run, the subscriber searches the repository for closed, unlocked issues whose `closed_at` is older than the configured threshold (server-side, oldest first), skips issues carrying any of the exempt labels, and locks the rest using GitHub's lock reason classifier. The search API caps a query at 1000 results, so a larger backlog converges over successive runs.

On `issues.labeled`, when the applied label is listed in `lock_on_labels`, the issue is locked immediately with the configured `reason` and no comment. Labels applied by bots count too, so an `auto-labeler` rule that applies `spam` chains into an immediate lock.

This subscriber also owns Carson's `lock` action: other subscribers (such as [read-only](#read-only)) request locks through it rather than locking themselves, so `reason` is configured once.

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
| `comment` | string | `This issue has been locked after {{days}} days of inactivity since it was closed. Please open a new issue if the problem persists.` |
| `lock_on_labels` | array of label names that lock the issue immediately when applied | `[]` |

Carson posts the comment on the issue *before* locking (you can't comment after the lock). The comment supports template interpolation.

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

## no-response-closer

Closes open issues and pull requests carrying a configurable label whose activity has been stale past a configurable threshold. Designed for the common "we asked for more info, then never heard back" workflow.

**Triggers**: scheduled (cron via `on: schedule:` in the consumer workflow)
**Permissions**: `issues: write`, `pull_requests: write`

On each scheduled run the subscriber:

1. Searches open items carrying the configured `label` (default `needs-info`) whose `updated_at` is older than `days_until_close` ago, server-side and oldest first.
2. Skips items carrying any of `exempt_labels`.
3. Posts `close_message` as a comment before closing.
5. Closes the item. Issues are closed with `state_reason: 'not_planned'` (rendered in GitHub's UI as the gray "not planned" close icon). PRs are closed without a state reason.

The activity check uses the item's `updated_at` field, so **any** comment or edit (including from bots) resets the timer. This is the same semantic `stale` uses. Stricter "the author has not responded since the label was added" tracking would require per-item timeline + comments fetches, and is a possible future enhancement.

Add a cron schedule to your `.github/workflows/carson.yml`:

```yaml
on:
  schedule:
    - cron: '0 4 * * *'  # daily at 04:00 UTC
```

### Overlap with `stale`

Both subscribers walk the repo on a schedule and close items. The difference:

- **`stale`** picks items by age (`updated_at` older than `days_until_stale`), adds its own warning label, and closes after a further `days_until_close`. Two-phase.
- **`no-response-closer`** acts on a label that someone else (typically a maintainer) applied. Single-phase: close after `days_until_close` of stale activity.

They are complementary. A repo can enable both, with non-overlapping label scopes (e.g. `stale` ignores `needs-info` via `exempt_labels`, and `no-response-closer` only acts on `needs-info`).

### Settings

| Key | Type | Default |
| --- | --- | --- |
| `label` | string | `needs-info` |
| `days_until_close` | positive integer | `14` |
| `close_message` | string | `Closing this {{type}}: no response for {{days_until_close}} days after information was requested. Comment with the requested details and it can be reopened.` |
| `exempt_labels` | array of strings | `[]` |

### Context (for `close_message`)

| Key | Value |
| --- | --- |
| `{{user}}` | GitHub login of the item's author (left verbatim if the user is a ghost) |
| `{{number}}` | Issue or PR number |
| `{{repo}}` | Repository name |
| `{{title}}` | Item title |
| `{{type}}` | `issue` or `pull request` |
| `{{days_until_close}}` | The configured `days_until_close` value |

### Example

```yaml
version: 1
subscribers:
  - no-response-closer
settings:
  no-response-closer:
    label: needs-info
    days_until_close: 21
    exempt_labels:
      - pinned
      - good-first-issue
    close_message: |
      Closing this {{type}} after {{days_until_close}} days without further
      information, @{{user}}. Feel free to reopen with more details if this
      still matters.
```

---

## pr-title-linter

Validates pull request titles against a configurable set of regex rules and reports the result as a [Check Run](https://docs.github.com/en/rest/checks/runs).

**Triggers**: `pull_request.opened`, `pull_request.edited`
**Permissions**: `checks: write`, `pull_requests: read`

Each event re-evaluates the current PR title against every configured rule and updates a single rolling check (keyed by check name). Rules with a malformed regex are skipped with a warning, so a single bad rule does not silence the whole subscriber.

A rule's `mode` decides what the regex match means: `require` means the title must match the pattern, `forbid` means it must not. Each rule's `level` decides what a failure does to the check conclusion: an `error` rule failing produces `failure` (which blocks merging if the check is required), a `warning` rule failing produces `neutral` (advisory only). If every rule passes the conclusion is `success`. When both error and warning rules fail in the same evaluation, the conclusion is `failure`.

> [!CAUTION]
> Rule patterns are compiled to JavaScript `RegExp` and tested against the title with no runtime timeout. A catastrophically backtracking pattern (ReDoS) in `carson.yml` will hang the action. Since `carson.yml` lives on the default branch only, this is a maintainer footgun rather than a contributor attack surface, but keep patterns simple and test them locally before committing.

### Settings

| Key | Type | Default |
| --- | --- | --- |
| `name` | string | `Carson / pr-title-linter` |
| `rules` | array of rule objects (see below) | `[]` (subscriber bails silently when empty) |

Each rule object:

| Key | Type | Default |
| --- | --- | --- |
| `pattern` | string (compiled as JavaScript `RegExp`) | required |
| `description` | string (shown in check output on failure) | required |
| `mode` | `require` or `forbid` | `require` |
| `level` | `error` or `warning` | `error` |

### Example

```yaml
version: 1
subscribers:
  - pr-title-linter
settings:
  pr-title-linter:
    name: "Carson / pr-title"
    rules:
      - pattern: '^(feat|fix|docs|chore|refactor|test)(\(.+\))?: .+'
        description: 'Follow conventional commits'
        level: error
      - pattern: '^(WIP|TODO|DRAFT)\b'
        description: 'Avoid WIP/TODO/DRAFT prefixes'
        mode: forbid
        level: warning
```

---

## read-only

Closes issues and pull requests the moment they are opened on a read-only repository (a mirror, a subtree split), leaving a comment that points contributors upstream, then locks the thread so the conversation cannot continue in the wrong place.

**Triggers**: `issues.opened`, `pull_request.opened`
**Permissions**: `issues: write`, `pull_requests: write`

Bot senders are not exempt: an automated PR against a mirror is exactly what should be closed. Issues are closed as `not_planned`. Locking is delegated to [lock-old-issues](#lock-old-issues) through Carson's action routing, so that subscriber must also be enabled for `lock` to take effect (its configured `reason` applies, no extra comment is posted). When it is not enabled, the item is still closed and a warning is logged.

### Settings

| Key | Type | Default |
| --- | --- | --- |
| `upstream` | `owner/repo` of the canonical repository | (none) |
| `message` | template string | `This repository is read-only, so this {{type}} has been closed.` |
| `lock` | boolean | `true` |
| `issues` | boolean, guard issues | `true` |
| `pull_requests` | boolean, guard pull requests | `true` |

### Context

| Key | Value |
| --- | --- |
| `{{user}}` | GitHub login of the opener (left verbatim if the user is a ghost) |
| `{{number}}` | Issue or PR number |
| `{{repo}}` | Repository name |
| `{{type}}` | `issue` or `pull request` |
| `{{upstream}}` | Markdown link to the `upstream` repository, e.g. `[acme/monorepo](https://github.com/acme/monorepo)` (left verbatim when unset) |
| `{{upstream_url}}` | Bare URL of the `upstream` repository, for composing your own link (left verbatim when unset) |

### Example

```yaml
version: 1
subscribers:
  - read-only
  - lock-old-issues
settings:
  read-only:
    upstream: acme/monorepo
    message: "This repository is a read-only split of {{upstream}}. Please open this {{type}} there instead."
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
**Permissions**: `issues: write`, `pull_requests: write`

On each scheduled run, the subscriber issues two searches (server-side, oldest first): open items carrying the stale label, and open items without it whose `updated_at` is older than `days_until_stale`. Items with recent activity never come back at all. For each result:

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

## template-enforcer

Comments on and labels issues or pull requests whose description does not match a configured template, and removes the label when the description is updated to comply.

**Triggers**: `issues.opened`, `issues.edited`, `pull_request.opened`, `pull_request.edited`
**Permissions**: `issues: write`, `pull_requests: write`

Issues and pull requests are configured separately under `issues:` and `pull_requests:` subsections because their templates typically differ. Omit a subsection to skip enforcement for that type entirely.

Three rule kinds are supported per type:

- `required_sections`: a list of section strings that must appear somewhere in the body. The match is case-insensitive substring. Consumers who need anchored matching can use a `rules` regex instead.
- `min_length`: a positive integer. The body (trimmed) must be at least this many characters.
- `rules`: a list of regex rules with `pattern`, `description`, and an optional `mode` (`require` or `forbid`, default `require`). Invalid patterns are logged as warnings and skipped, so one malformed rule does not silence the subscriber.

On every event the subscriber computes the current violations and reconciles state:

- **New violation, no prior carson comment**: post a comment listing the violations, add the label.
- **Violation with prior carson comment but label missing**: add the label only (no duplicate comment).
- **Violation with prior carson comment and label present**: no action.
- **No violations, label present**: remove the label. The historical comment is left in place.
- **No violations, label absent**: no action.

The subscriber locates its prior comment via the `<!-- carson:template-enforcer -->` marker, filtered by bot author. The marker is appended last so attacker-controlled body content cannot forge a match.

There is no `close_on_violation` option. Closing on a first offense is hostile to contributors, and a `stale`-style auto-close after a grace period belongs in `stale` rather than here.

### Settings

| Key | Type | Default |
| --- | --- | --- |
| `label` | string | `needs-template` |
| `message` | string (template) | see below |
| `issues` | per-type rule object (see below) | (none, issues are not enforced) |
| `pull_requests` | per-type rule object | (none, PRs are not enforced) |

Per-type object (used in both `issues` and `pull_requests`):

| Key | Type | Default |
| --- | --- | --- |
| `required_sections` | array of strings | `[]` |
| `min_length` | positive integer | (no minimum) |
| `rules` | array of regex rule objects | `[]` |

Default message:

```
Thanks for opening this {{type}}, @{{user}}! The description doesn't match the template:

{{violations}}

Please update the description. The `{{label}}` label will be removed automatically.
```

### Context

| Key | Value |
| --- | --- |
| `{{user}}` | GitHub login of the author |
| `{{type}}` | `issue` or `pull request` |
| `{{number}}` | Issue or PR number |
| `{{title}}` | Issue or PR title |
| `{{label}}` | The configured label name |
| `{{violations}}` | Pre-rendered bulleted list of failed checks |

### Example

```yaml
version: 1
subscribers:
  - template-enforcer
settings:
  template-enforcer:
    label: needs-template
    issues:
      required_sections:
        - "## Steps to reproduce"
        - "## Expected behavior"
      min_length: 50
    pull_requests:
      required_sections:
        - "## Summary"
        - "## Test plan"
      min_length: 30
      rules:
        - pattern: 'fixes #[0-9]+'
          description: 'Reference the issue you fix with `fixes #N`'
        - pattern: 'lorem ipsum'
          description: 'Replace placeholder text in the description'
          mode: forbid
```

---

## thanks

Posts a thank-you comment when a pull request is merged by someone other than its author.

**Triggers**: `pull_request.closed`
**Permissions**: `pull_requests: write`

Carson fires once per merged PR. The subscriber skips four cases:

- The PR was closed without merging.
- The PR author merged the PR themselves (maintainer self-merge). Detected by `pull_request.user.login === pull_request.merged_by.login`.
- The PR author is a bot (e.g. Dependabot, Renovate).
- The PR has no author (a ghost user).

There is no `author_association` filter. The self-merge guard already handles the most common "don't thank me for my own work" case, and the bot guard suppresses automation PRs. If you want finer scoping (e.g. exclude org members), open an issue.

### Settings

| Key | Type | Default |
| --- | --- | --- |
| `message` | string | `Thanks for the contribution, @{{user}}!` |

### Context

| Key | Value |
| --- | --- |
| `{{user}}` | GitHub login of the PR author |
| `{{repo}}` | Repository name |
| `{{number}}` | PR number |
| `{{title}}` | PR title |

### Example

```yaml
version: 1
subscribers:
  - thanks
settings:
  thanks:
    message: "Thanks for landing #{{number}}, @{{user}}! 🎉"
```

---

## triage-labeler

Labels pull requests with their current review state: `needs-review`, `needs-rework`, or `approved`. The three labels are mutually exclusive: applying one removes the others (other labels on the PR are untouched).

**Triggers**: `pull_request.opened`, `pull_request.reopened`, `pull_request.synchronize`, `pull_request.ready_for_review`, `pull_request.converted_to_draft`, `pull_request_review.submitted`
**Permissions**: `issues: write`, `pull_requests: write`

For each event the subscriber paginates `pulls.listReviews`, reduces to the latest review per reviewer, ignores `COMMENTED` reviews and reviews from users without write access, then derives the target state:

- Any qualifying reviewer's latest review is `CHANGES_REQUESTED` → `needs-rework`
- Otherwise any qualifying reviewer's latest review is `APPROVED` → `approved`
- Otherwise → `needs-review`

Draft PRs are never labeled. A PR converted to draft has its triage label removed. A PR moved out of draft via `ready_for_review` is re-evaluated.

A reviewer "qualifies" when their `author_association` is in the configured `qualifying_associations` set. The default and maximum set is `{OWNER, MEMBER, COLLABORATOR}`. The set cannot be widened to include `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `NONE`, or `MANNEQUIN`. Schema validation rejects any value outside the allowed list. This prevents drive-by approvals from external contributors flipping the label.

Labels are auto-created by GitHub on first use with a random color. To control the colors, create the labels manually in the repository's label settings before enabling the subscriber.

If the existing managed label already matches the desired state, no label API calls are made.

### Settings

| Key | Type | Default |
| --- | --- | --- |
| `needs_review_label` | string | `needs-review` |
| `needs_rework_label` | string | `needs-rework` |
| `approved_label` | string | `approved` |
| `qualifying_associations` | array of `OWNER`, `MEMBER`, `COLLABORATOR` | `[OWNER, MEMBER, COLLABORATOR]` |

### Example

```yaml
version: 1
subscribers:
  - triage-labeler
settings:
  triage-labeler:
    needs_review_label: "status: needs review"
    needs_rework_label: "status: changes requested"
    approved_label: "status: ready to merge"
    qualifying_associations: [OWNER, MEMBER]   # tighten to org members and owner only
```

---

## webhook-notifier

POSTs a signed JSON payload to a consumer-configured URL when tracked issues change state. This is the return path for [issue-intake](#issue-intake): an external system files an issue through a `repository_dispatch` and learns from this callback when maintainers close (or reopen) it.

**Triggers**: `issues.closed`, `issues.reopened`
**Permissions**: none (operates on the event payload only)

By default (`require_marker: true`) only issues carrying an [issue-intake](#issue-intake) marker are notified: the issue body must end with `<!-- carson:issue-intake:{event_type}:{ref} -->` **and** the issue author must be a Bot. Without the bot-author check, anyone could paste a marker into their own issue and aim callbacks with a forged ref at the receiver. The marker, not the intake subscriber, is the contract: a consumer creating issues directly (e.g. under the App's installation token from its own backend) opts into callbacks by emitting that exact marker as the final line of a bot-authored issue body.

The HMAC secret never goes in `carson.yml`. The `secret_env` setting names an environment variable that the consumer workflow passes on the Carson step:

```yaml
- uses: NexusPHP/carson@<commit-sha>  # vX.Y.Z
  with:
    app_id: ${{ secrets.CARSON_APP_ID }}
    private_key: ${{ secrets.CARSON_PRIVATE_KEY }}
  env:
    CARSON_WEBHOOK_SECRET: ${{ secrets.SUPPORT_WEBHOOK_SECRET }}
```

A missing or empty variable fails the run. Carson never sends unsigned.

### Delivery

The request is a `POST` with:

| Header | Value |
| --- | --- |
| `content-type` | `application/json` |
| `x-carson-event` | the `event.action` string, e.g. `issues.closed` |
| `x-carson-delivery` | the workflow run id |
| `x-carson-signature-256` | `sha256=` + hex HMAC-SHA256 of the raw request body, keyed by the secret |

The signature scheme mirrors GitHub's own webhook signing, so receivers can reuse existing verification code. The body:

```json
{
  "version": 1,
  "event": "issues.closed",
  "ref": "tkt_8f3a2c",
  "dispatch_event_type": "support-ticket",
  "issue": {
    "number": 42,
    "title": "[bug] Export fails on large TB",
    "state": "closed",
    "state_reason": "completed",
    "html_url": "https://github.com/acme/support/issues/42"
  },
  "repository": "acme/support",
  "delivered_at": "2026-07-11T09:00:00Z"
}
```

`ref` and `dispatch_event_type` are parsed from the marker. When `require_marker` is `false` both are `null` and the `labels` filter should carry the filtering burden. `delivered_at` inside the signed body gives receivers a replay-rejection handle.

Delivery uses a bounded timeout with up to 3 attempts and short backoff on network errors and 5xx responses. A final non-2xx fails the workflow run (other subscribers still complete). The remediation for a missed delivery is re-running the workflow run from the Actions UI: the event payload is preserved, so failed-run visibility is the retry story. Receiver response bodies are never parsed or acted upon.

### Settings

| Key | Type | Default |
| --- | --- | --- |
| `url` | string, `https://` only, no userinfo | required |
| `secret_env` | string, name of the env var holding the HMAC secret | required |
| `events` | array of `issues.closed` / `issues.reopened` | `[issues.closed]` |
| `require_marker` | boolean, only notify for issues carrying a bot-authored issue-intake marker | `true` |
| `labels` | array, additionally require at least one of these labels on the issue | `[]` (no label filter) |

### Example

```yaml
version: 1
subscribers:
  - issue-intake
  - webhook-notifier
settings:
  webhook-notifier:
    url: https://app.example.com/api/support/github-webhook
    secret_env: CARSON_WEBHOOK_SECRET
    events: [issues.closed, issues.reopened]
    labels: [support]
```

The consumer workflow needs `issues` in its triggers:

```yaml
on:
  issues:
    types: [closed, reopened]
```

---

## welcome

Greets contributors on pull requests and issues. First-time and returning contributors are configured independently.

**Triggers**: `pull_request.opened`, `issues.opened`
**Permissions**: `issues: write`, `pull_requests: write`

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
