# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- `template-enforcer` resolves its comment when the description is fixed, alongside removing the label. If the item breaks again, it posts a fresh comment listing the current violations instead of only re-adding the label.

## [v1.7.0](https://github.com/NexusPHP/carson/compare/v1.6.0...v1.7.0) - 2026-09-21

### Added

- `no-response-closer` gains `unlabel_on_response`: when the item's author comments, pushes to the pull request, or replies in a review thread, the rule's label is removed, so an answered item is no longer closed for lack of a response. Off by default, set per rule or at the top level. Needs `auto-labeler` enabled.
- `triage-labeler` gains `sweep`: when enabled, every open pull request is reconciled on the scheduled run, so a label missed by a cancelled run or by a review on a fork pull request is corrected within a day. It writes only where the label is wrong. Off by default.
- An [Actions](SUBSCRIBERS.md#actions) section in SUBSCRIBERS.md lists each cross-subscriber action, its owner, who requests it, and which subscribers label directly.

### Fixed

- Review events on a pull request from a fork no longer produce a failed run. GitHub passes no secrets to `pull_request_review` and `pull_request_review_comment` there, so Carson could not authenticate and failed on the missing `app_id`. It now ends the run successfully with a notice. Empty credentials in any other situation still fail. The README and the `no-response-closer`, `stale`, and `triage-labeler` sections say what this means for fork pull requests.
- `stale`, `template-enforcer`, `triage-labeler`, and `auto-labeler`'s sync no longer fail the run when the label they are removing is already gone, for example removed by a maintainer in the same moment.

## [v1.6.0](https://github.com/NexusPHP/carson/compare/v1.5.0...v1.6.0) - 2026-09-19

### Added

- `no-response-closer` gains `rules`: several labels, each with its own `days_until_close`, `close_message`, `exempt_labels`, and an `only` scope for issues or pull requests. The top-level keys act as defaults, and a configuration without `rules` behaves as before.
- `no-response-closer` exposes `{{label}}` to `close_message`.
- `welcome` accepts `false` for `pull_request` and `issue` in either bucket to switch that greeting off, and `false` for a whole bucket. An empty message, which used to post an empty comment, now does the same.
- `welcome` gains `exempt_roles`: authors whose repository role is listed are never greeted.

### Changed

- `welcome` decides first time or returning by counting the author's earlier pull requests or issues in the repository, instead of reading `author_association`. GitHub reports the first-time associations on pull requests only, so issue authors without commits were never greeted, and it hides private organization members from an App. A leftover `author_association` list is ignored with a warning, except that an empty list still switches its bucket off.
- `welcome` no longer greets a pull request opened as a draft. The greeting is posted on `pull_request.ready_for_review` instead, once.
- Log lines name the item type wherever it is known, `PR #8` or `issue #8`, instead of a bare `#8`. The `label`, `unlabel`, and `lock` action handlers still log the bare number, since they receive only that.
- `auto-labeler` names the labels it added or removed on request, and the implied labels it added. Every label list it logs is quoted: `"bug", "needs review"`.
- The startup log line reads `Received push event` instead of `Received push`.
- A run ends with `Finished in 2.4s`, or `Finished with failures in 2.4s` when a subscriber or the dispatch failed.

### Fixed

- Scheduled searches in `draft-policy`, `lock-old-issues`, `no-response-closer`, and `stale` sent their cutoff as `+00:00`, which reaches GitHub as a space followed by the search term `00:00`. Only items whose text contained `00:00` matched, a small fraction of the real candidates. The cutoff is now sent in the `Z` form.

## [v1.5.0](https://github.com/NexusPHP/carson/compare/v1.4.3...v1.5.0) - 2026-09-18

### Added

- [cache-pruner](SUBSCRIBERS.md#cache-pruner) subscriber: deletes Actions caches of closed pull requests and deleted branches, and sweeps caches of since-closed pull requests and aged branch caches on schedule. Needs `actions: write` on the App.
- `auto-labeler` gains `sync_exempt`: labels listed there are still added by rules but never removed by `sync_labels`.
- `template-enforcer` gains `exempt_roles`: authors whose repository role is listed skip the template check, and a leftover label is removed on their next edit.

### Changed

- `conflicts-notifier` logs at `info` when it skips a pull request whose mergeable state GitHub has not computed yet.
- Re-running a workflow with debug logging enabled raises Carson's log level to `debug`, whatever `log_level` is set to.

## [v1.4.3](https://github.com/NexusPHP/carson/compare/v1.4.2...v1.4.3) - 2026-09-13

### Changed

- `auto-labeler` adds a rule label only from a field the event changed, so a label a maintainer removed no longer comes back from an unrelated edit or push.

## [v1.4.2](https://github.com/NexusPHP/carson/compare/v1.4.1...v1.4.2) - 2026-09-12

### Fixed

- `pr-title-linter` runs on `pull_request.synchronize` and `pull_request.reopened` too, so a push no longer leaves the new head without a check.
- `conflicts-notifier` and `no-merge-commits` re-run when a pull request is retargeted (`pull_request.edited` with a base change).
- `draft-policy` posts a fresh notice when a draft is reopened, so a draft closed by the sweep and reopened is not closed again on the next run.
- `read-only` closes reopened issues and pull requests as well as new ones.
- `stale` un-stales on `issues.reopened`, `pull_request.reopened`, and `pull_request_review_comment.created`.
- `triage-labeler` recomputes the label on `pull_request_review.dismissed`.

## [v1.4.1](https://github.com/NexusPHP/carson/compare/v1.4.0...v1.4.1) - 2026-09-12

### Changed

- `pr-title-linter` and `signed-commits` success titles read `Title passes 1 rule` and `1 commit signed` instead of `Title passes all 1 rule` and `All 1 commit signed`.
- Subscriber log lines no longer carry the webhook delivery id, which is the run id under the action.

## [v1.4.0](https://github.com/NexusPHP/carson/compare/v1.3.0...v1.4.0) - 2026-09-08

### Added

- `auto-labeler` gains `implied_labels`: applying a mapped label adds the labels it implies, on issues and pull requests.
- [draft-policy](SUBSCRIBERS.md#draft-policy) subscriber: comments on draft pull requests and closes those still in draft after a grace period.
- [maintainer-edits](SUBSCRIBERS.md#maintainer-edits) subscriber: comments on fork pull requests that do not allow edits from maintainers.
- [milestone](SUBSCRIBERS.md#milestone) subscriber: assigns a milestone to pull requests from rules on the base branch and labels, with a `next-open` sentinel for the earliest open milestone.
- [no-merge-commits](SUBSCRIBERS.md#no-merge-commits) subscriber: posts a check that fails when a pull request contains merge commits, with label, author, and branch-rule exemptions.
- `triage-labeler` gains `reset_on_push`: a change request made against an earlier head commit no longer counts, so a push returns the PR to `needs-review`.
- [unsupported-branch](SUBSCRIBERS.md#unsupported-branch) subscriber: comments on pull requests that target a branch outside the maintained set and minimizes the notice once retargeted.

### Changed

- When two or more subscribers comment on the same issue or pull request during one event, the notices are posted as a single digest comment. A subscriber resolving its notice collapses its own section.

## [v1.3.0](https://github.com/NexusPHP/carson/compare/v1.2.0...v1.3.0) - 2026-09-06

### Changed

- `triage-labeler` qualifies reviewers by repository role (`qualifying_roles`, default `[admin, maintain, write]`) instead of `author_association`, which hid private organization members from the App. A leftover `qualifying_associations` setting is ignored with a warning.

### Fixed

- `triage-labeler` now labels pull requests opened or updated by bots such as Dependabot.
- `auto-labeler`, `conflicts-notifier`, `pr-title-linter`, and `signed-commits` now run for bot senders, so bot-opened pull requests get labels, conflict notices, and check runs.

## [v1.2.0](https://github.com/NexusPHP/carson/compare/v1.1.0...v1.2.0) - 2026-09-05

### Added

- `conflicts-notifier` applies a configurable `label` while a PR conflicts and removes it once the PR is clean.
- `auto-labeler` owns the `label` and `unlabel` actions, so `conflicts-notifier` and `commands` label through it.

### Changed

- `/label` and `/unlabel` in `commands` now require `auto-labeler` to be enabled.
- Counted nouns in log lines and check-run titles are inflected (`1 unsigned commit`, `2 of 2 rules failed`) instead of using `(s)`.
- The App installer page presents the App ID, private key, workflow, and configuration as numbered setup steps.

## [v1.1.0](https://github.com/NexusPHP/carson/compare/v1.0.0...v1.1.0) - 2026-09-04

### Added

- Cross-subscriber action routing. `lock-old-issues` owns the `lock` action, so other subscribers request locks through it instead of locking themselves.
- [read-only](SUBSCRIBERS.md#read-only) subscriber: closes issues and pull requests opened on a read-only mirror and requests a lock from `lock-old-issues`.
- `auto-labeler` labels issues too, via `issue_rules` (title and body regex).
- `lock-old-issues` locks an issue immediately when a label listed in `lock_on_labels` is applied.
- [commands](SUBSCRIBERS.md#commands) subscriber: slash commands in comments (`/label`, `/unlabel`, `/close`, `/reopen`, `/lock`, `/assign`, `/unassign`), gated on the commenter's repository role.

### Changed

- `lock-old-issues` now posts a default comment before locking when `comment` is not configured, matching `stale`'s behavior.
- `no-response-closer` now posts a default comment before closing when `close_message` is not configured.

## [v1.0.0](https://github.com/NexusPHP/carson/releases/tag/v1.0.0) - 2026-08-28

Initial release.

### Added

- Carson as a GitHub App distributed as a GitHub Action: each consumer registers their own App, supplies `app_id` / `private_key` as action inputs, and the action handles one workflow event per run through an in-process [Probot](https://probot.github.io).
- Thirteen bundled subscribers, opted into per repository via `.github/carson.yml` on the default branch:
  - [auto-labeler](SUBSCRIBERS.md#auto-labeler): labels PRs by path globs, title/body regex, or branch patterns, with optional sync mode.
  - [conflicts-notifier](SUBSCRIBERS.md#conflicts-notifier): comments on PRs with merge conflicts and resolves the comment when fixed.
  - [issue-intake](SUBSCRIBERS.md#issue-intake): turns `repository_dispatch` events from an external system into labeled issues carrying a correlation marker.
  - [lock-old-issues](SUBSCRIBERS.md#lock-old-issues): locks closed issues inactive past a configurable age.
  - [no-response-closer](SUBSCRIBERS.md#no-response-closer): closes labeled items whose activity has gone stale past a threshold.
  - [pr-title-linter](SUBSCRIBERS.md#pr-title-linter): validates PR titles against configurable regex rules as a check run.
  - [signed-commits](SUBSCRIBERS.md#signed-commits): posts a check requiring every commit in a PR to be signed and verified.
  - [stale](SUBSCRIBERS.md#stale): marks inactive items stale, then closes them after a grace period.
  - [template-enforcer](SUBSCRIBERS.md#template-enforcer): flags issues and PRs whose description does not match the configured template.
  - [thanks](SUBSCRIBERS.md#thanks): thanks contributors when someone else merges their PR.
  - [triage-labeler](SUBSCRIBERS.md#triage-labeler): labels PRs with their review state.
  - [webhook-notifier](SUBSCRIBERS.md#webhook-notifier): POSTs a signed JSON callback to a configured URL when tracked issues close or reopen.
  - [welcome](SUBSCRIBERS.md#welcome): greets first-time and returning contributors on PRs and issues.
- Scheduled (cron) dispatch for maintenance subscribers, with scans narrowed server-side through the GitHub search API.
- `repository_dispatch` support for events pushed from outside GitHub.
- Preflight permission check that fails the run with per-subscriber remediation when the consumer's App is under-permissioned, before any subscriber can 403.
- Registration filtering: only subscribers listed in `carson.yml` are attached at all.
- `{{placeholder}}` template interpolation for consumer-configured messages, including the universal `{{app_name}}` / `{{app_slug}}` / `{{app_login}}` context.
- Hardening for `pull_request_target` consumers: comment-marker forgery defenses and markdown escaping of attacker-controlled text.
- Click-through App installer at <https://nexusphp.github.io/carson/>.
- Action inputs: `app_id`, `private_key`, `webhook_secret`, `log_level`.
