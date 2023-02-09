#!/usr/bin/env node

import install from "../src/install";
import { getDiagnosticRetryCount } from "../src/mode";

let [, , cmd, ...args] = process.argv;

let firstRun = false;
if (cmd === "first-run" && !process.env.REPLAY_SKIP_BROWSER_DOWNLOAD) {
  args = [];
  cmd = "install";
  firstRun = true;
}

function commandInstall() {
  console.log("Installing Replay browsers for cypress");

  let browser = args[0] || "all";
  install(browser).then(() => {
    console.log("Done");
  });
}

function help() {
  console.log(`
npx @replayio/cypress

Provides utilities to support using Replay (https://replay.io) with Cypress

Available commands:

  - install [all | firefox | chromium]
    Installs all or the specified Replay browser
  `);
}

try {
  switch (cmd) {
    case "install":
      commandInstall();
      break;
    case "diagnostics-retry-count":
      console.log(getDiagnosticRetryCount());
      break;
    case "help":
    default:
      help();
      break;
  }
} catch (e) {
  if (firstRun) {
    // Log install errors during first-run but don't fail package install
    console.error(e);
  } else {
    throw e;
  }
}
