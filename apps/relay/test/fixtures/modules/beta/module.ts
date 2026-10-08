/** A fixture module (B037 relay.modules.test.ts): order 10, registered asynchronously. */
import type { RelayModule } from '../../../../src/index.js';
import { registrations } from '../registrations.js';

const beta: RelayModule = {
  name: 'beta',
  order: 10,
  async register() {
    await Promise.resolve();
    registrations.push('beta');
  },
};
export default beta;
