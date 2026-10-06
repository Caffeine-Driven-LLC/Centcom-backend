// Must fail lint outside the config loader and entrypoints (B004): aliasing process.
const p = process;
export const port = p.env.PORT;
