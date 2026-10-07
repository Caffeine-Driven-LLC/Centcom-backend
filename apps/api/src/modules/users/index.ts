/**
 * Users module (B013): the user service over B008's users table, and the profile field rules.
 * The HTTP endpoints (`/v1/me`, B022) and the login methods (B014, B015) build on it.
 */
export { personalSlug, UserService, type SignInResult, type UserServiceDeps } from './service.js';
export {
  checkAvatarSlot,
  checkDisplayName,
  checkEmail,
  checkLocale,
  DEFAULT_LOCALE,
  defaultDisplayName,
  MAX_AVATAR_LENGTH,
  MAX_LOCALE_LENGTH,
  validateDisplayName,
  validateEmail,
  validateLocale,
  validateProfilePatch,
} from './validation.js';
export type { NewUser, ProfilePatch, User, UserRepo } from '@centcom/db';
