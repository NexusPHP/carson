# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `conflicts-notifier` applies a configurable `label` while a PR conflicts and removes it once the PR is clean.
- `auto-labeler` owns the `label` and `unlabel` actions, so `conflicts-notifier` and `commands` label through it.

### Changed

- `/label` and `/unlabel` in `commands` now require `auto-labeler` to be enabled.

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
