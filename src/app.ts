import { Carson } from './carson.js';
import { ConflictsNotifierSubscriber } from './subscribers/conflicts-notifier.js';
import { SignedCommitsSubscriber } from './subscribers/signed-commits.js';
import { WelcomeSubscriber } from './subscribers/welcome.js';

export const carson = new Carson([
  new ConflictsNotifierSubscriber(),
  new SignedCommitsSubscriber(),
  new WelcomeSubscriber(),
]);

export default carson.app;
