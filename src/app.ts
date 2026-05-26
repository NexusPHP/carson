import { Carson } from './carson.js';
import { ConflictsNotifierSubscriber } from './subscribers/conflicts-notifier.js';
import { LockOldIssuesSubscriber } from './subscribers/lock-old-issues.js';
import { SignedCommitsSubscriber } from './subscribers/signed-commits.js';
import { WelcomeSubscriber } from './subscribers/welcome.js';

export const carson = new Carson([
  new ConflictsNotifierSubscriber(),
  new LockOldIssuesSubscriber(),
  new SignedCommitsSubscriber(),
  new WelcomeSubscriber(),
]);

export default carson.app;
