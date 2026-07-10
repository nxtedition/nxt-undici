// @nxtedition/undici@11.1.9 declares a missing index.d.ts in its package
// metadata. Model the runtime exports used by this package so lib/index.d.ts
// can still be checked without suppressing declaration-file errors globally.
declare module '@nxtedition/undici' {
  export const Client: typeof import('undici-types').Client
  export const Pool: typeof import('undici-types').Pool
  export const Agent: typeof import('undici-types').Agent
  export const getGlobalDispatcher: typeof import('undici-types').getGlobalDispatcher
  export const setGlobalDispatcher: typeof import('undici-types').setGlobalDispatcher
}
