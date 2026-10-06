// Must fail lint outside the config loader and entrypoints (B004): importing env.
import { env } from 'node:process';
export const port = env.PORT;
