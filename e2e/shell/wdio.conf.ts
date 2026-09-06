export const config: WebdriverIO.Config = {
  specs: ["./test/**/*.spec.ts"],
  maxInstances: 1,
  services: [
    [
      "tauri",
      {
        application: "../../apps/desktop/src-tauri/Cargo.toml",
      },
    ],
  ],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },
};
