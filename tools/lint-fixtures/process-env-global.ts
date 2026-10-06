// Must fail lint outside the config loader and entrypoints (B004): process via globalThis.
export const port = globalThis.process.env.PORT;
