import * as NodeURL from "node:url";

/** Absolute path of the runner process entrypoint, for the host to spawn with `node`. */
export const FX_RUNNER_ENTRYPOINT = NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url));
