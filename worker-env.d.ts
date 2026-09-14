// Import only binding types: global Worker DOM declarations conflict with React's browser DOM.
declare module "cloudflare:workers" {
  export const env: {
    DB?: import("@cloudflare/workers-types").D1Database;
    ASSETS?: { fetch: typeof fetch };
  };
}
