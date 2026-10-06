// Must fail lint outside the config loader and entrypoints (B004): destructuring process.
const { env } = process;
export const port = env.PORT;
