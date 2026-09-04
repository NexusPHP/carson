import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import { subscriberSettings } from '../configuration/schema.js';
import { z } from 'zod';

const COMMANDS = ['label', 'unlabel', 'close', 'reopen', 'lock', 'assign', 'unassign'] as const;
const ROLES = ['admin', 'maintain', 'write', 'triage', 'read'] as const;
const MAX_COMMANDS_PER_COMMENT = 10;
const MAX_LABEL_LENGTH = 50;
const LOGIN_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const COMMAND_LINE_REGEX = /^\/([a-z]+)(?:[ \t]+(.*))?$/;
const FENCE_REGEX = /^(?:```|~~~)/;

const Settings = z.object({
  commands: z.array(z.enum(COMMANDS)).default([...COMMANDS]),
  roles: z.array(z.enum(ROLES)).default(['admin', 'maintain', 'write', 'triage']),
  allowed_labels: z.array(z.string().min(1)).optional(),
  react: z.boolean().default(true),
});

type CommandName = (typeof COMMANDS)[number];
type CommandContext = Context<'issue_comment.created'>;

interface Command {
  name: CommandName;
  args: string[];
}

const isCommandName = (value: string): value is CommandName =>
  (COMMANDS as readonly string[]).includes(value);

// Only a line starting at column 0 with "/" counts, and fenced code blocks
// are skipped, so quoted, indented, or code-formatted text never triggers.
const parseCommands = (body: string): Command[] => {
  const commands: Command[] = [];
  let inFence = false;

  for (const line of body.split(/\r?\n/)) {
    if (FENCE_REGEX.test(line)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    const match = COMMAND_LINE_REGEX.exec(line);

    if (match === null) {
      continue;
    }

    const [, name, rawArgs] = match;

    if (!isCommandName(name)) {
      continue;
    }

    const args = (rawArgs ?? '')
      .split(',')
      .map((arg) => arg.trim())
      .filter((arg) => arg.length > 0);

    commands.push({ name, args });

    if (commands.length >= MAX_COMMANDS_PER_COMMENT) {
      break;
    }
  }

  return commands;
};

const asLogins = (args: readonly string[], fallback: string): string[] => {
  const logins = args.length === 0 ? [fallback] : args;

  return logins
    .flatMap((arg) => arg.split(/\s+/))
    .map((login) => login.replace(/^@/, ''))
    .filter((login) => LOGIN_REGEX.test(login));
};

export class CommandsSubscriber extends Subscriber {
  public readonly id = 'commands';
  public readonly description = 'Runs slash commands (/label, /close, /lock, ...) posted in comments by repository collaborators.';
  public readonly requiredPermissions: RequiredPermissions = { issues: 'write', pull_requests: 'write' };

  public override register(probot: Probot): void {
    probot.on('issue_comment.created', async (context: CommandContext): Promise<void> => {
      await this.#handle(context);
    });
  }

  async #handle(context: CommandContext): Promise<void> {
    const log = this.log(context);
    const { comment, issue } = context.payload;

    if (context.isBot || comment.user === null) {
      return;
    }

    const commands = parseCommands(comment.body);

    if (commands.length === 0) {
      return;
    }

    const config = await this.loadEnabledConfig(context);

    if (config === null) {
      return;
    }

    const settings = subscriberSettings(config, this.id, Settings, log) ?? Settings.parse({});
    const { owner, repo } = context.repo();
    const login = comment.user.login;
    const role = await this.#roleOf(context, owner, repo, login);

    if (!(settings.roles as readonly string[]).includes(role)) {
      log.debug(`#${issue.number}: "${login}" has role "${role}", commands ignored`);
      return;
    }

    let succeeded = 0;

    for (const command of commands) {
      if (!settings.commands.includes(command.name)) {
        log.debug(`#${issue.number}: /${command.name} not enabled, skipping`);
        continue;
      }

      try {
        await this.#execute(context, command, settings, login);
        succeeded += 1;
        log.info(`#${issue.number}: /${command.name} by ${login}`);
      } catch (error) {
        log.warn({ err: error }, `#${issue.number}: /${command.name} failed`);
      }
    }

    if (succeeded > 0 && settings.react) {
      await context.octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: comment.id,
        content: '+1',
      });
    }
  }

  // Anyone can comment, so the gate is the commenter's actual repository
  // role, not the self-reported author_association.
  async #roleOf(context: CommandContext, owner: string, repo: string, username: string): Promise<string> {
    try {
      const { data } = await context.octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });

      return data.role_name;
    } catch {
      return 'none';
    }
  }

  async #execute(
    context: CommandContext,
    command: Command,
    settings: z.infer<typeof Settings>,
    login: string,
  ): Promise<void> {
    const { owner, repo } = context.repo();
    const issue = context.payload.issue;
    const target = { owner, repo, issue_number: issue.number };

    switch (command.name) {
      case 'label': {
        const labels = command.args
          .filter((label) => label.length <= MAX_LABEL_LENGTH)
          .filter((label) => settings.allowed_labels === undefined || settings.allowed_labels.includes(label));

        if (labels.length === 0) {
          throw new Error('no allowed labels given');
        }

        await context.octokit.rest.issues.addLabels({ ...target, labels });
        break;
      }
      case 'unlabel': {
        if (command.args.length === 0) {
          throw new Error('no labels given');
        }

        for (const name of command.args) {
          await context.octokit.rest.issues.removeLabel({ ...target, name });
        }
        break;
      }
      case 'close': {
        const reason = command.args[0];
        const stateReason = reason === 'not_planned' ? 'not_planned' : 'completed';

        await context.octokit.rest.issues.update({
          ...target,
          state: 'closed',
          ...(issue.pull_request === undefined ? { state_reason: stateReason } : {}),
        });
        break;
      }
      case 'reopen':
        await context.octokit.rest.issues.update({ ...target, state: 'open' });
        break;
      case 'lock':
        if (!(await this.dispatch('lock', context, { number: issue.number }))) {
          throw new Error('no enabled subscriber handles lock');
        }
        break;
      case 'assign': {
        const assignees = asLogins(command.args, login);

        if (assignees.length === 0) {
          throw new Error('no valid logins given');
        }

        await context.octokit.rest.issues.addAssignees({ ...target, assignees });
        break;
      }
      case 'unassign': {
        const assignees = asLogins(command.args, login);

        if (assignees.length === 0) {
          throw new Error('no valid logins given');
        }

        await context.octokit.rest.issues.removeAssignees({ ...target, assignees });
        break;
      }
    }
  }
}
