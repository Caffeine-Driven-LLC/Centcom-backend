// Must fail lint outside the config loader and entrypoints (B004): computed access.
const key = 'env';
export const port = process[key].PORT;
