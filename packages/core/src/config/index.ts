/**
 * Configuration (B004): one typed, validated loader for every service. Lanes declare their own
 * keys with `defineConfig` in their own module; nothing outside this module and the entrypoints
 * reads `process.env` (enforced by lint).
 */
export { z } from 'zod';
export {
  baseConfig,
  baseEnvSchema,
  baseSchema,
  LOG_LEVELS,
  NODE_ENVS,
  type BaseConfig,
  type LogLevel,
  type NodeEnv,
} from './base.js';
export {
  ConfigError,
  deepFreeze,
  defineConfig,
  envBool,
  envInt,
  envUrl,
  MAX_SECRET_FILE_BYTES,
  type ConfigIssue,
  type ConfigWarning,
  type DeepReadonly,
  type DefineConfigOptions,
  type Env,
  type SecretFiles,
} from './define.js';
export { REDACTED, Secret, secretString } from './secret.js';
