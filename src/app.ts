import { Carson } from './carson.js';
import { ConflictsNotifierSubscriber } from './subscribers/conflicts-notifier.js';
import { WelcomeSubscriber } from './subscribers/welcome.js';

export const carson = new Carson([
  new ConflictsNotifierSubscriber(),
  new WelcomeSubscriber(),
]);

export default carson.app;
