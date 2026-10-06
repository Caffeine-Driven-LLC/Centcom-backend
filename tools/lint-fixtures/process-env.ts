// Must fail lint outside the config loader and entrypoints (B004): reading process.env.
export const port = process.env.PORT;
