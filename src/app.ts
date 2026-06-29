import { AutoLabelerSubscriber } from './subscribers/auto-labeler.js';
import { Carson } from './carson.js';
import { ConflictsNotifierSubscriber } from './subscribers/conflicts-notifier.js';
import { LockOldIssuesSubscriber } from './subscribers/lock-old-issues.js';
import { NoResponseCloserSubscriber } from './subscribers/no-response-closer.js';
import { PrTitleLinterSubscriber } from './subscribers/pr-title-linter.js';
import { SignedCommitsSubscriber } from './subscribers/signed-commits.js';
import { StaleSubscriber } from './subscribers/stale.js';
import { TemplateEnforcerSubscriber } from './subscribers/template-enforcer.js';
import { ThanksSubscriber } from './subscribers/thanks.js';
import { TriageLabelerSubscriber } from './subscribers/triage-labeler.js';
import { WelcomeSubscriber } from './subscribers/welcome.js';

export const carson = new Carson([
  new AutoLabelerSubscriber(),
  new ConflictsNotifierSubscriber(),
  new LockOldIssuesSubscriber(),
  new NoResponseCloserSubscriber(),
  new PrTitleLinterSubscriber(),
  new SignedCommitsSubscriber(),
  new StaleSubscriber(),
  new TemplateEnforcerSubscriber(),
  new ThanksSubscriber(),
  new TriageLabelerSubscriber(),
  new WelcomeSubscriber(),
]);

export default carson.app;
