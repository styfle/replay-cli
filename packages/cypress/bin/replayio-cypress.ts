#!/usr/bin/env node

import cypress from "cypress";

import install from "../src/install";
import { ReplayMode, toDiagnosticLevel, toReplayMode } from "../src/mode";
import run from "../src/run";

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

function parseNumberArg(arg: string | undefined) {
  const num = arg ? Number.parseInt(arg) : NaN;
  if (isNaN(num)) {
    throw new Error("Error: --count must be a number");
  }

  return num;
}

async function commandRun() {
  let modeOpt: string | undefined;
  let levelOpt: string | undefined;
  let retryCount: number | undefined;
  let timeout: number | undefined;

  // TODO [ryanjduffy]: Migrate to commander
  while (args.length) {
    switch (args[0]) {
      case "-m":
      case "--mode":
        args.shift();
        modeOpt = args.shift();

        continue;
      case "-l":
      case "--level":
        args.shift();
        levelOpt = args.shift();

        continue;
      case "-c":
      case "--count":
        args.shift();
        retryCount = parseNumberArg(args.shift());

        continue;
      case "-t":
      case "--timeout":
        args.shift();
        timeout = parseNumberArg(args.shift());

        continue;
    }

    break;
  }

  try {
    const mode = toReplayMode(modeOpt);
    const level = toDiagnosticLevel(levelOpt);

    const options = await cypress.cli.parseRunArguments(["cypress", "run", ...args]);
    const failed = await run({ mode, level, count: retryCount, timeout, ...options });

    process.exit(failed ? 1 : 0);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}

function help() {
  console.log(`
npx @replayio/cypress

Provides utilities to support using Replay (https://replay.io) with Cypress

Available commands:

  - install [all | firefox | chromium]
    Installs all or the specified Replay browser

  - run
    Runs your cypress tests with additional repeat modes
  `);
}

(async () => {
  try {
    switch (cmd) {
      case "install":
        commandInstall();
        break;
      case "run":
        await commandRun();
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
})();
