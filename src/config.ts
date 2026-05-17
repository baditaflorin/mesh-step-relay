import { createMeshConfig } from "@baditaflorin/mesh-common";

export const config = createMeshConfig({
  appName: "mesh-step-relay",
  description: "Virtual baton; current holder takes N steps in 60s or it drops to the next peer.",
  accentHex: "#4cd964",
  version: __APP_VERSION__,
  commit: __GIT_COMMIT__,
});
