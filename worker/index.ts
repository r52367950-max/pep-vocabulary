/// <reference types="vite/client" />
/** Cloudflare Worker entry point. Static images are served by ASSETS. */
import handler from "vinext/server/app-router-entry";
import { createSecureHandler } from "./security";

// Security headers wrap every response this Worker renders (built Worker,
// `vinext start`, Miniflare smoke). `vite` dev serves requests without this
// entry; the flag keeps the nonce CSP off anywhere Vite's unnonced dev client runs.
export default createSecureHandler(handler, { enforceContentSecurityPolicy: !import.meta.env.DEV });
