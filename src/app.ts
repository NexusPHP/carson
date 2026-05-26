import { Carson } from './carson.js';
import { WelcomeSubscriber } from './subscribers/welcome.js';

export const carson = new Carson([
  new WelcomeSubscriber(),
]);

export default carson.app;
