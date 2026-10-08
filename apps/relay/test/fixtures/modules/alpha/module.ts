/** A fixture module (B037 relay.modules.test.ts): order 30, records its registration. */
import type { RelayModule } from '../../../../src/index.js';
import { registrations } from '../registrations.js';

const alpha: RelayModule = {
  name: 'alpha',
  order: 30,
  register() {
    registrations.push('alpha');
    return undefined;
  },
};
export default alpha;
