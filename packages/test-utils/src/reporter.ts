import { RecordingEntry, listAllRecordings, uploadRecording } from "@replayio/replay";
import { add, test as testMetadata, source as sourceMetadata } from "@replayio/replay/metadata";
import { query } from "@replayio/replay/src/graphql";
import { exponentialBackoffRetry } from "@replayio/replay/src/utils";
import type { TestMetadataV1, TestMetadataV2 } from "@replayio/replay/metadata/test";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import dbg from "debug";
const uuid = require("uuid");

import { getMetadataFilePath } from "./metadata";
import { pingTestMetrics } from "./metrics";
import { log, warn } from "./logging";
import { buildTestId, generateOpaqueId } from "./testId";
import { ExternalRecordingEntry } from "@replayio/replay/src/types";

const debug = dbg("replay:test-utils:reporter");

interface TestRunTestInputModel {
  testId: string;
  runnerGroupId: string | null;
  index: number;
  attempt: number;
  scope: string[];
  title: string;
  sourcePath: string;
  result: string;
  error: string | null;
  duration: number;
  recordingIds: string[];
}

export interface TestIdContext {
  title: string;
  scope: string[];
  attempt: number;
}

export interface ReplayReporterConfig {
  runTitle?: string;
  metadata?: Record<string, any> | string;
  upload?: boolean;
  apiKey?: string;
  filter?: (r: RecordingEntry) => boolean;
}

export interface TestRunner {
  name: string;
  version: string;
  plugin: string;
}

type UserActionEvent = ReplayReporter["schemaVersion"] extends "1.0.0"
  ? TestMetadataV1.UserActionEvent
  : TestMetadataV2.UserActionEvent;
type Test = ReplayReporter["schemaVersion"] extends "1.0.0"
  ? TestMetadataV1.Test
  : TestMetadataV2.Test;
type TestResult = ReplayReporter["schemaVersion"] extends "1.0.0"
  ? TestMetadataV1.TestResult
  : TestMetadataV2.TestResult;
type TestError = ReplayReporter["schemaVersion"] extends "1.0.0"
  ? TestMetadataV1.TestError
  : TestMetadataV2.TestError;
type TestRun = ReplayReporter["schemaVersion"] extends "1.0.0"
  ? TestMetadataV1.TestRun
  : TestMetadataV2.TestRun;

type PendingWorkType = "test-run" | "upload" | "test-run-tests" | "post-test";
type PendingWorkError<K extends PendingWorkType> = { type: K; error: Error };
type PendingWorkEntry<K extends PendingWorkType, T = {}> = PendingWorkError<K> | (T & { type: K });
type TestRunPendingWork = PendingWorkEntry<
  "test-run",
  {
    id: string;
    phase: "start" | "complete";
  }
>;
type TestRunTestsPendingWork = PendingWorkEntry<"test-run-tests">;
type UploadPendingWork = PendingWorkEntry<
  "upload",
  {
    recording: RecordingEntry;
  }
>;
type PostTestPendingWork = PendingWorkEntry<
  "post-test",
  {
    recordings: RecordingEntry[];
    testRun: TestRun;
  }
>;
type PendingWork =
  | TestRunPendingWork
  | TestRunTestsPendingWork
  | UploadPendingWork
  | PostTestPendingWork;

function getErrorMessage(e: unknown) {
  return e && typeof e === "object" && "message" in e ? (e.message as string) : "Unknown Error";
}

function logPendingWorkErrors(errors: PendingWorkError<any>[]) {
  return errors.map(e => `   - ${e.error.message}`);
}

function getTestResult(recording: RecordingEntry): TestRun["result"] {
  const test = recording.metadata.test as TestRun | undefined;
  return !test ? "unknown" : test.result;
}

function getTestResultEmoji(recording: RecordingEntry) {
  const result = getTestResult(recording);
  switch (result) {
    case "unknown":
      return "﹖";
    case "failed":
    case "timedOut":
      return "❌";
    case "passed":
      return "✅";
    case "skipped":
      return "🤷";
  }
}

const resultOrder = ["failed", "timedOut", "passed", "skipped", "unknown"];

function sortRecordingsByResult(recordings: RecordingEntry[]) {
  return [...recordings].sort((a, b) => {
    return (
      resultOrder.indexOf(getTestResult(a)) - resultOrder.indexOf(getTestResult(b)) ||
      ((a.metadata.title as string) || "").localeCompare((b.metadata.title as string) || "")
    );
  });
}

function parseRuntime(runtime?: string) {
  return ["chromium", "gecko", "node"].find(r => runtime?.includes(r));
}

function throwGraphqlErrors(operation: string, errors: any) {
  errors.forEach((e: any) => debug("Error from GraphQL operation %s: %o", operation, e));
  throw new Error(
    `GraphQL request for ${operation} failed (${errors.map(getErrorMessage).join(", ")})`
  );
}

export class ReporterError extends Error {
  code: number;
  detail: any;

  constructor(code: number, message: string, detail: any = null) {
    super();

    this.name = "ReporterError";
    this.code = code;
    this.message = message;
    this.detail = !detail || typeof detail === "string" ? detail : JSON.stringify(detail);
  }

  valueOf() {
    return {
      code: this.code,
      name: this.name,
      message: this.message,
      detail: this.detail,
    };
  }
}

class ReplayReporter {
  baseId = sourceMetadata.getTestRunIdFromEnvironment(process.env) || uuid.v4();
  testRunShardId: string | null = null;
  baseMetadata: Record<string, any> | null = null;
  schemaVersion: string;
  runTitle?: string;
  runner: TestRunner;
  errors: ReporterError[] = [];
  apiKey?: string;
  pendingWork: Promise<PendingWork>[] = [];
  upload = false;
  filter?: (r: RecordingEntry) => boolean;
  recordingsToUpload: ExternalRecordingEntry[] = [];

  constructor(runner: TestRunner, schemaVersion: string) {
    this.runner = runner;
    this.schemaVersion = schemaVersion;
  }

  setApiKey(apiKey: string) {
    this.apiKey = apiKey;
  }

  getResultFromResultCounts(resultCounts: TestRun["resultCounts"]): TestResult {
    const { failed, passed, skipped, timedOut } = resultCounts;

    if (failed > 0) {
      return "failed";
    } else if (timedOut > 0) {
      return "timedOut";
    } else if (passed > 0) {
      return "passed";
    } else if (skipped > 0) {
      return "skipped";
    } else {
      return "unknown";
    }
  }

  summarizeResults(tests: Test[]) {
    let approximateDuration = 0;
    let resultCounts: TestRun["resultCounts"] = {
      failed: 0,
      passed: 0,
      skipped: 0,
      timedOut: 0,
      unknown: 0,
    };

    const testsById: Record<number, Test> = {};
    tests.forEach(test => {
      if (!testsById[test.id] || test.attempt > testsById[test.id].attempt) {
        testsById[test.id] = test;
      }
    });

    Object.values(testsById).forEach(t => {
      approximateDuration += t.approximateDuration || 0;
      switch (t.result) {
        case "failed":
          resultCounts.failed++;
          break;
        case "passed":
          resultCounts.passed++;
          break;
        case "skipped":
          resultCounts.skipped++;
          break;
        case "timedOut":
          resultCounts.timedOut++;
          break;
        default:
          resultCounts.unknown++;
      }
    });

    return { approximateDuration, resultCounts };
  }

  getTestId(source?: TestIdContext) {
    if (!source) {
      return this.baseId;
    }

    return `${this.baseId}-${[...source.scope, source.title].join("-")}-${source.attempt}`;
  }

  parseConfig(config: ReplayReporterConfig = {}, metadataKey?: string) {
    // always favor environment variables over config so the config can be
    // overwritten at runtime
    this.runTitle =
      process.env.REPLAY_METADATA_TEST_RUN_TITLE ||
      process.env.RECORD_REPLAY_TEST_RUN_TITLE ||
      process.env.RECORD_REPLAY_METADATA_TEST_RUN_TITLE ||
      config.runTitle;

    this.apiKey = process.env.REPLAY_API_KEY || process.env.RECORD_REPLAY_API_KEY || config.apiKey;
    this.upload = !!process.env.REPLAY_UPLOAD || !!config.upload;
    this.filter = config.filter;

    // RECORD_REPLAY_METADATA is our "standard" metadata environment variable.
    // We suppress it for the browser process so we can use
    // RECORD_REPLAY_METADATA_FILE but can still use the metadata here which
    // runs in the test runner process. However, test runners may have a
    // convention for reporter-specific environment configuration which should
    // supersede this.
    if (metadataKey && process.env[metadataKey] && process.env.RECORD_REPLAY_METADATA) {
      console.warn(
        `Cannot set metadata via both RECORD_REPLAY_METADATA and ${metadataKey}. Using ${metadataKey}.`
      );
    }

    const baseMetadata =
      (metadataKey && process.env[metadataKey]) ||
      process.env.RECORD_REPLAY_METADATA ||
      config.metadata ||
      null;
    if (baseMetadata) {
      // Since we support either a string in an environment variable or an
      // object in the cfg, we need to parse out the string value. Technically,
      // you could use a string in the config file too but that'd be unexpected.
      // Nonetheless, it'll be handled correctly here if you're into that sort
      // of thing.
      if (typeof baseMetadata === "string") {
        try {
          this.baseMetadata = JSON.parse(baseMetadata);
        } catch {
          console.warn("Failed to parse Replay metadata");
        }
      } else {
        this.baseMetadata = baseMetadata;
      }
    }
  }

  addError(err: Error | ReporterError) {
    if (err.name === "ReporterError") {
      this.errors.push(err as ReporterError);
    } else {
      this.errors.push(new ReporterError(-1, "Unexpected error", err));
    }
  }

  setDiagnosticMetadata(metadata: Record<string, unknown>) {
    this.baseMetadata = {
      ...this.baseMetadata,
      "x-replay-diagnostics": metadata,
    };
  }

  onTestSuiteBegin(config?: ReplayReporterConfig, metadataKey?: string) {
    this.parseConfig(config, metadataKey);

    debug("onTestSuiteBegin: Reporter Configuration: %o", {
      baseId: this.baseId,
      runTitle: this.runTitle,
      runner: this.runner,
      baseMetadata: this.baseMetadata,
      upload: this.upload,
      hasApiKey: !!this.apiKey,
      hasFilter: !!this.filter,
    });

    if (!this.testRunShardId) {
      if (this.apiKey) {
        this.pendingWork.push(this.startTestRunShard());
      } else {
        debug("Skipping starting test run: API Key not set");
      }
    }
  }

  async startTestRunShard(): Promise<TestRunPendingWork> {
    let metadata: any = {};
    try {
      metadata = await sourceMetadata.init();
    } catch (e) {
      debug(
        "Failed to initialize source metadata to create test run shard: %s",
        e instanceof Error ? e.message : e
      );
    }

    const { REPLAY_METADATA_TEST_RUN_MODE, RECORD_REPLAY_METADATA_TEST_RUN_MODE } = process.env;

    const testRun = {
      runnerName: this.runner.name,
      runnerVersion: this.runner.version,
      repository: metadata.source?.repository ?? null,
      title: this.runTitle ?? null,
      mode: REPLAY_METADATA_TEST_RUN_MODE ?? RECORD_REPLAY_METADATA_TEST_RUN_MODE ?? null,
      branch: metadata.source?.branch ?? null,
      pullRequestId: metadata.source?.merge?.id ?? null,
      pullRequestTitle: metadata.source?.merge?.title ?? null,
      commitId: metadata.source?.commit?.id ?? null,
      commitTitle: metadata.source?.commit?.title ?? null,
      commitUser: metadata.source?.commit?.user ?? null,
      triggerUrl: metadata.source?.trigger?.url ?? null,
      triggerUser: metadata.source?.trigger?.user ?? null,
      triggerReason: metadata.source?.trigger?.workflow ?? null,
    };

    debug("Creating test run shard for user-key %s", this.baseId);

    try {
      await exponentialBackoffRetry(async () => {
        const resp = await query(
          "CreateTestRunShard",
          `
          mutation CreateTestRunShard($clientKey: String!, $testRun: TestRunShardInput!) {
            startTestRunShard(input: {
              clientKey: $clientKey,
              testRun: $testRun
            }) {
              success
              testRunShardId
            }
          }
        `,
          {
            clientKey: this.baseId,
            testRun,
          },
          this.apiKey
        );

        if (resp.errors) {
          throwGraphqlErrors("CreateTestRunShard", resp.errors);
        }

        this.testRunShardId = resp.data.startTestRunShard.testRunShardId;

        if (!this.testRunShardId) {
          return {
            type: "test-run",
            error: new Error("Unexpected error retrieving test run shard id"),
          };
        }
      });

      debug("Created test run shard %s for user key %s", this.testRunShardId, this.baseId);

      return {
        type: "test-run",
        id: this.testRunShardId!,
        phase: "start",
      };
    } catch (e) {
      debug("start test run error: %s", e);
      return {
        type: "test-run",
        error: new Error(`Unexpected error starting test run shard: ${getErrorMessage(e)}`),
      };
    }
  }

  async addTestsToShard(tests: TestRunTestInputModel[]): Promise<TestRunTestsPendingWork> {
    if (!this.testRunShardId) {
      return {
        type: "test-run-tests",
        error: new Error("Unable to add tests to test run: ID not set"),
      };
    }

    debug("Adding %d tests to shard %s", tests.length, this.testRunShardId);

    try {
      await exponentialBackoffRetry(async () => {
        const resp = await query(
          "AddTestsToShard",
          `
          mutation AddTestsToShard($testRunShardId: String!, $tests: [TestRunTestInputType!]!) {
            addTestsToShard(input: {
              testRunShardId: $testRunShardId,
              tests: $tests
            }) {
              success
            }
          }
        `,
          {
            testRunShardId: this.testRunShardId,
            tests,
          },
          this.apiKey
        );

        if (resp.errors) {
          throwGraphqlErrors("AddTestsToShard", resp.errors);
        }
      });

      debug("Successfully added tests to shard %s", this.testRunShardId);

      return {
        type: "test-run-tests",
      };
    } catch (e) {
      debug("Add tests to run error: %s", e);
      return {
        type: "test-run-tests",
        error: new Error(`Unexpected error adding tests to run: ${getErrorMessage(e)}`),
      };
    }
  }

  async completeTestRunShard(): Promise<TestRunPendingWork> {
    if (!this.testRunShardId) {
      return {
        type: "test-run",
        error: new Error("Unable to complete test run: ID not set"),
      };
    }

    debug("Marking test run shard %s complete", this.testRunShardId);

    try {
      await exponentialBackoffRetry(async () => {
        const resp = await query(
          "CompleteTestRunShard",
          `
        mutation CompleteTestRunShard($testRunShardId: String!) {
          completeTestRunShard(input: {
            testRunShardId: $testRunShardId
          }) {
            success
          }
        }
      `,
          {
            testRunShardId: this.testRunShardId,
          },
          this.apiKey
        );

        if (resp.errors) {
          throwGraphqlErrors("CompleteTestRunShard", resp.errors);
        }
      });

      debug("Successfully marked test run shard %s complete", this.testRunShardId);

      return {
        type: "test-run",
        id: this.testRunShardId,
        phase: "complete",
      };
    } catch (e) {
      debug("complete test run shard error: %s", e);
      return {
        type: "test-run",
        error: new Error(`Unexpected error completing test run shard: ${getErrorMessage(e)}`),
      };
    }
  }

  onTestBegin(
    testIdContext?: TestIdContext,
    metadataFilePath = getMetadataFilePath("REPLAY_TEST", 0)
  ) {
    debug("onTestBegin: %o", testIdContext);

    const id = this.getTestId(testIdContext);
    this.errors = [];
    const metadata = {
      ...(this.baseMetadata || {}),
      "x-replay-test": {
        id,
      },
    };

    debug("onTestBegin: Writing metadata to %s: %o", metadataFilePath, metadata);

    try {
      mkdirSync(dirname(metadataFilePath), { recursive: true });
      writeFileSync(metadataFilePath, JSON.stringify(metadata, undefined, 2), {});
    } catch (e) {
      warn("Failed to initialize Replay metadata", e);
    }

    this.enqueueUpload();
  }

  onTestEnd({
    tests,
    specFile,
    replayTitle,
    extraMetadata,
    runnerGroupKey,
  }: {
    tests: Test[];
    specFile: string;
    replayTitle?: string;
    extraMetadata?: Record<string, unknown>;
    runnerGroupKey?: string;
  }) {
    debug("onTestEnd: %s", specFile);

    // if we bailed building test metadata because of a crash or because no
    // tests ran, we can bail here too
    if (tests.length === 0) {
      debug("onTestEnd: No tests found");
      return;
    }

    this.pendingWork.push(
      this.enqueuePostTestWork(tests, specFile, runnerGroupKey, replayTitle, extraMetadata)
    );
  }

  async uploadRecording(recording: RecordingEntry): Promise<UploadPendingWork> {
    debug("Starting upload of %s", recording.id);

    try {
      const result = await uploadRecording(recording.id, {
        apiKey: this.apiKey,
      });

      if (result === null) {
        return {
          type: "upload",
          error: new Error("Upload failed"),
        };
      }

      debug("Successfully uploaded %s", recording.id);

      const recordings = listAllRecordings({ filter: r => r.id === recording.id, all: true });

      return {
        type: "upload",
        recording: recordings[0],
      };
    } catch (e) {
      debug("upload error: %s", e);
      return {
        type: "upload",
        error: new Error(`Failed to upload recording: ${getErrorMessage(e)}`),
      };
    }
  }

  getRecordingsForTest(tests: Test[], includeUploaded: boolean) {
    const filter = `function($v) { $v.metadata.\`x-replay-test\`.id in ${JSON.stringify([
      ...tests.map(test =>
        this.getTestId({
          ...test.source,
          attempt: test.attempt,
        })
      ),
      this.getTestId(),
    ])} and $not($exists($v.metadata.test)) }`;

    const recordings = listAllRecordings({
      all: includeUploaded,
      filter,
    });

    debug("Found %d recs with filter %s", recordings.length, filter);

    return recordings;
  }

  buildTestMetadata(tests: Test[], specFile: string) {
    const test = tests[0];
    const { approximateDuration, resultCounts } = this.summarizeResults(tests);
    const result = this.getResultFromResultCounts(resultCounts);
    const source = {
      path: specFile,
      title: test.source.title,
    };

    const metadata: TestRun = {
      approximateDuration,
      source,
      result,
      resultCounts,
      run: {
        id: this.baseId,
        title: this.runTitle,
      },
      tests,
      environment: {
        errors: this.errors.map(e => e.valueOf()),
        pluginVersion: this.runner.plugin,
        testRunner: {
          name: this.runner.name,
          version: this.runner.version,
        },
      },
      schemaVersion: this.schemaVersion,
    };

    return metadata;
  }

  async setRecordingMetadata(
    recordings: RecordingEntry[],
    testRun: TestRun,
    replayTitle?: string,
    extraMetadata?: Record<string, unknown>
  ) {
    debug(
      "setRecordingMetadata: Adding test metadata to %o",
      recordings.map(r => r.id)
    );
    debug("setRecordingMetadata: Includes %s errors", this.errors.length);

    const validatedTestMetadata = testMetadata.init(testRun) as { test: TestMetadataV2.TestRun };

    let mergedMetadata = {
      title: replayTitle || testRun.source.title,
      ...extraMetadata,
      ...validatedTestMetadata,
    };

    try {
      const validatedSourceMetadata = await sourceMetadata.init();
      mergedMetadata = {
        ...mergedMetadata,
        ...validatedSourceMetadata,
      };
    } catch (e) {
      debug("Failed to generate source metadata: %s", e instanceof Error ? e.message : e);
    }

    recordings.forEach(rec => add(rec.id, mergedMetadata));

    // Re-fetch recordings so we have the most recent metadata
    const allRecordings = listAllRecordings({ all: true });
    return allRecordings.filter(recordingWithMetadata =>
      recordings.some(r => r.id === recordingWithMetadata.id)
    );
  }

  async enqueuePostTestWork(
    tests: Test[],
    specFile: string,
    runnerGroupKey?: string,
    replayTitle?: string,
    extraMetadata?: Record<string, unknown>
  ): Promise<PendingWork> {
    try {
      const runnerGroupId = runnerGroupKey ? await generateOpaqueId(runnerGroupKey) : null;
      const recordings = this.getRecordingsForTest(tests, false);

      if (this.testRunShardId) {
        const recordingIds = recordings.map(r => r.id);
        const testInputs = await Promise.all(
          tests.map<Promise<TestRunTestInputModel>>(async t => {
            const testId = await buildTestId(specFile, t);
            if (!testId) {
              throw new Error("Failed to generate test id for test");
            }

            return {
              testId,
              runnerGroupId: runnerGroupId,
              index: t.id,
              attempt: t.attempt,
              scope: t.source.scope,
              title: t.source.title,
              sourcePath: specFile,
              result: t.result,
              error: t.error ? t.error.message : null,
              duration: t.approximateDuration,
              recordingIds,
            };
          })
        );

        this.pendingWork.push(this.addTestsToShard(testInputs));
      } else {
        debug("Skipping adding tests to test run: test run shard ID not found");
      }

      const testRun = this.buildTestMetadata(tests, specFile);

      if (recordings.length > 0) {
        const recordingsWithMetadata = await this.setRecordingMetadata(
          recordings,
          testRun,
          replayTitle,
          extraMetadata
        );

        if (this.upload) {
          this.recordingsToUpload.push(...recordingsWithMetadata);
        }
      }

      const firstRecording: RecordingEntry | undefined = recordings[0];
      pingTestMetrics(
        firstRecording?.id,
        this.baseId,
        {
          id: testRun.source.path + "#" + testRun.source.title,
          source: testRun.source,
          approximateDuration: testRun.approximateDuration,
          recorded: true,
          runtime: parseRuntime(firstRecording?.runtime),
          runner: this.runner.name,
          result: testRun.result,
        },
        this.apiKey
      );

      return {
        type: "post-test",
        recordings,
        testRun,
      };
    } catch (e) {
      debug("post-test error: %s", e);
      return {
        type: "post-test",
        error: new Error(`Error setting metadata and uploading replays: ${getErrorMessage(e)}`),
      };
    }
  }

  async enqueueUpload() {
    if (this.recordingsToUpload.length) {
      const recordings = [...this.recordingsToUpload];
      this.recordingsToUpload = [];

      this.pendingWork.push(
        ...recordings
          .filter(r => (this.filter ? this.filter(r) : true))
          .map(r => this.uploadRecording(r))
      );
    }
  }

  async onEnd(): Promise<PendingWork[]> {
    debug("onEnd");

    if (this.upload) {
      let timeout = 2000;
      if (process.env.REPLAY_UPLOAD_DELAY) {
        const userTimeout = Number.parseInt(process.env.REPLAY_UPLOAD_DELAY);
        if (!isNaN(userTimeout)) {
          timeout = userTimeout;
        }
        debug("REPLAY_UPLOAD_DELAY value %d using %d", userTimeout, timeout);
      }

      await new Promise(resolve => setTimeout(resolve, timeout));
      this.enqueueUpload();
    }

    if (this.pendingWork.length === 0) {
      return [];
    }

    log("🕑 Completing some outstanding work ...");
    debug("Outstanding tasks: %d", this.pendingWork.length);

    const output: string[] = [];
    const completedWork = await Promise.allSettled(this.pendingWork);

    if (this.apiKey) {
      if (this.testRunShardId) {
        // In the rare case that a test suite has no tests (or very brief
        // tests?), onEnd will likely be called before the request to create the
        // shard completes so we have to wait on all the pending work before we
        // can complete the shard. This is also probably better from a UX
        // standpoint because the shard won't be completed until uploading
        // completes so we will report a more accurate status to the user. In
        // order to handle the result of this command like the rest, we use
        // `allSettled` and push the results onto the completedWork array so all
        // responses are handled together.
        const postSettledWork = await Promise.allSettled([this.completeTestRunShard()]);
        completedWork.push(...postSettledWork);
      } else {
        debug("Skipping completing test run: test run shard ID not found");
      }
    } else {
      debug("Skipping completing test run: API Key not set");
    }

    const failures = completedWork.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );

    if (failures.length > 0) {
      output.push("Encountered unexpected errors while processing replays");
      failures.forEach(f => output.push(`  ${f.reason}`));
    }

    const results = completedWork
      .filter((r): r is PromiseFulfilledResult<PendingWork> => r.status === "fulfilled")
      .map(r => r.value);

    const errors = {
      "post-test": [] as PendingWorkError<"post-test">[],
      "test-run": [] as PendingWorkError<"test-run">[],
      "test-run-tests": [] as PendingWorkError<"test-run-tests">[],
      upload: [] as PendingWorkError<"upload">[],
    };
    let uploads: RecordingEntry[] = [];
    for (const r of results) {
      if ("error" in r) {
        errors[r.type].push(r as any);
      } else {
        if (r.type === "upload") {
          uploads.push(r.recording);
        }
      }
    }

    if (errors["post-test"].length > 0 || errors["upload"].length > 0) {
      output.push(
        `\n❌ We encountered some unexpected errors processing your recordings and ${
          uploads.length > 0 ? "some were not uploaded.`" : "was unable to upload them."
        }`
      );
      output.push(...logPendingWorkErrors(errors["post-test"]));
      output.push(...logPendingWorkErrors(errors["upload"]));
    }

    if (errors["test-run-tests"].length > 0 || errors["test-run"].length > 0) {
      output.push("\n❌ We encountered some unexpected errors creating your tests on replay.io");
      output.push(...logPendingWorkErrors(errors["test-run-tests"]));
      output.push(...logPendingWorkErrors(errors["test-run"]));
    }

    if (uploads.length > 0) {
      output.push(`\n🚀 Successfully uploaded ${uploads.length} recordings:\n`);
      const sortedUploads = sortRecordingsByResult(uploads);
      sortedUploads.forEach(r => {
        output.push(
          `   ${getTestResultEmoji(r)} ${(r.metadata.title as string | undefined) || "Unknown"}`
        );
        output.push(
          `      ${process.env.REPLAY_VIEW_HOST || "https://app.replay.io"}/recording/${r.id}\n`
        );
      });
    }

    log(output.join("\n"));

    return results;
  }
}

export default ReplayReporter;
export type { UserActionEvent, Test, TestResult, TestError, TestMetadataV1, TestMetadataV2 };
