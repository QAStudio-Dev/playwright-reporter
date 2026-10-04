import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  FullResult,
} from '@playwright/test/reporter';
import { QAStudioAPIClient } from './api-client';
import type {
  QAStudioReporterOptions,
  ReporterState,
  UploadFailure,
  PendingUpload,
  PendingResult,
  UploadResult,
} from './types';
import {
  convertTestResult,
  extractAttachmentsAsBuffers,
  formatDuration,
  generateTestRunName,
  validateOptions,
  sanitizeUrl,
  sanitizeString,
} from './utils';

/**
 * QAStudio.dev Reporter for Playwright
 *
 * Sends test results to QAStudio.dev test management platform
 *
 * @example
 * ```typescript
 * // playwright.config.ts
 * export default defineConfig({
 *   reporter: [
 *     ['@qastudio-dev/playwright', {
 *       apiUrl: 'https://qastudio.dev/api',
 *       apiKey: process.env.QA_STUDIO_API_KEY,
 *       projectId: 'abc123',
 *       environment: 'CI',
 *     }]
 *   ],
 * });
 * ```
 */
export default class QAStudioReporter implements Reporter {
  private options: QAStudioReporterOptions & {
    environment: string;
    createTestRun: boolean;
    verbose: boolean;
    uploadScreenshots: boolean;
    uploadVideos: boolean;
    includeErrorSnippet: boolean;
    includeErrorLocation: boolean;
    includeTestSteps: boolean;
    includePassingTestSteps: boolean;
    includeConsoleOutput: boolean;
    batchSize: number;
    maxRetries: number;
    timeout: number;
    silent: boolean;
    testRunName: string;
  };
  private apiClient: QAStudioAPIClient;
  private state: ReporterState;
  private totalTests = 0;
  private passedTests = 0;
  private failedTests = 0;
  private skippedTests = 0;
  private flushPromises: PendingUpload[] = [];
  private resultBuffer: PendingResult[] = [];
  private inFlightFlushes = 0;
  private flushWaiters: Array<() => void> = [];
  private readonly maxConcurrentFlushes = 4;
  private readonly maxConcurrentAttachments = 4;
  private uploadFailures: UploadFailure[] = [];
  private testRunReadyPromise: Promise<void>;
  private testRunReadyResolve: (() => void) | null = null;
  private testRunCreationError: Error | null = null;

  // Constants
  private readonly TEST_RUN_CREATION_ERROR_PREFIX = 'Test run creation failed:';

  constructor(options: QAStudioReporterOptions) {
    // Validate options
    validateOptions(options);

    // Sanitize all string options to remove ANSI codes
    const sanitizedOptions = {
      ...options,
      apiUrl: sanitizeUrl(options.apiUrl),
      apiKey: sanitizeString(options.apiKey) || '',
      projectId: sanitizeString(options.projectId) || '',
      environment: sanitizeString(options.environment) || undefined,
      testRunId: sanitizeString(options.testRunId) || undefined,
      testRunName: sanitizeString(options.testRunName) || undefined,
      testRunDescription: sanitizeString(options.testRunDescription) || undefined,
      milestoneId: sanitizeString(options.milestoneId) || undefined,
    };

    // Set defaults
    this.options = {
      ...sanitizedOptions,
      environment: sanitizedOptions.environment ?? 'default',
      createTestRun: sanitizedOptions.createTestRun ?? true,
      verbose: sanitizedOptions.verbose ?? false,
      uploadScreenshots: sanitizedOptions.uploadScreenshots ?? true,
      uploadVideos: sanitizedOptions.uploadVideos ?? true,
      includeErrorSnippet: sanitizedOptions.includeErrorSnippet ?? true,
      includeErrorLocation: sanitizedOptions.includeErrorLocation ?? true,
      includeTestSteps: sanitizedOptions.includeTestSteps ?? true,
      includePassingTestSteps: sanitizedOptions.includePassingTestSteps ?? false,
      filterFixtureSteps: sanitizedOptions.filterFixtureSteps ?? true,
      includeConsoleOutput: sanitizedOptions.includeConsoleOutput ?? false,
      batchSize: sanitizedOptions.batchSize ?? 10,
      maxRetries: sanitizedOptions.maxRetries ?? 3,
      timeout: sanitizedOptions.timeout ?? 30000,
      silent: sanitizedOptions.silent ?? true,
      testRunName: sanitizedOptions.testRunName ?? generateTestRunName(),
    };

    // Initialize promise that resolves when test run is ready
    // IMPORTANT: This must be done before creating apiClient to prevent race conditions
    this.testRunReadyPromise = new Promise<void>((resolve) => {
      this.testRunReadyResolve = resolve;
    });

    this.apiClient = new QAStudioAPIClient(this.options);

    this.state = {
      tests: new Map(),
    };

    this.log('QAStudio.dev Reporter initialized with options:', {
      ...this.options,
      apiKey: '***hidden***',
    });
  }

  /**
   * Called once before running tests
   */
  async onBegin(_config: FullConfig, _suite: Suite): Promise<void> {
    this.state.startTime = new Date();
    this.log('Test run starting...');

    try {
      // Create test run if needed
      if (this.options.createTestRun && !this.options.testRunId) {
        const response = await this.apiClient.createTestRun({
          projectId: this.options.projectId,
          name: this.options.testRunName,
          description: this.options.testRunDescription,
          environment: this.options.environment,
          milestoneId: this.options.milestoneId,
        });

        this.state.testRunId = response.id;
        this.log(`Created test run with ID: ${this.state.testRunId}`);
      } else {
        this.state.testRunId = this.options.testRunId;
        this.log(`Using existing test run ID: ${this.state.testRunId}`);
      }
    } catch (error) {
      // Store the error for later propagation
      this.testRunCreationError = error instanceof Error ? error : new Error(String(error));
      this.handleError('Failed to create test run', error);
    } finally {
      // Signal that test run is ready (or failed, but either way we're done)
      this.testRunReadyResolve?.();
      this.log('Test run ready signal sent');
    }
  }

  /**
   * Called when a test begins
   */
  onTestBegin(test: TestCase, result: TestResult): void {
    const testId = this.getTestId(test);
    this.state.tests.set(testId, {
      test,
      result,
      startTime: new Date(),
    });

    this.log(`Test started: ${test.title}`);
  }

  /**
   * Called when a test ends
   */
  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    const testId = this.getTestId(test);
    const testData = this.state.tests.get(testId);

    if (!testData) {
      this.log(`Warning: Test data not found for ${test.title}`);
      return;
    }

    // Update test data
    testData.result = result;
    testData.endTime = new Date();

    // Update counters (only count final result, not retries)
    if (result.retry === test.retries) {
      this.totalTests++;
      this.log(
        `[onTestEnd] Final retry for test #${this.totalTests}: ${test.title} (retry ${result.retry}/${test.retries})`
      );

      switch (result.status) {
        case 'passed':
          this.passedTests++;
          break;
        case 'failed':
        case 'timedOut':
          this.failedTests++;
          break;
        case 'skipped':
        case 'interrupted':
          this.skippedTests++;
          break;
      }

      // Convert result without reading attachments as base64
      this.log(`[onTestEnd] Preparing to send test #${this.totalTests}: ${test.title}`);
      const qaResult = convertTestResult(test, result, testData.startTime, this.options);
      const attachmentBuffers = extractAttachmentsAsBuffers(result);
      const filteredAttachments = attachmentBuffers.filter((att) => {
        if (att.type === 'screenshot' && !this.options.uploadScreenshots) {
          return false;
        }
        if (att.type === 'video' && !this.options.uploadVideos) {
          return false;
        }
        return true;
      });

      delete qaResult.attachments;
      this.state.tests.delete(testId);

      this.enqueueResult({
        result: qaResult,
        attachments: filteredAttachments,
        testTitle: test.title,
        status: this.normalizeTestStatus(result.status),
      });
    } else {
      this.log(`[onTestEnd] Skipping retry ${result.retry}/${test.retries} for: ${test.title}`);
    }

    this.log(
      `Test ended: ${test.title} - ${result.status} (${result.duration}ms) [retry: ${result.retry}/${test.retries}]`
    );
  }

  /**
   * Called after all tests have finished
   */
  async onEnd(_result: FullResult): Promise<void> {
    this.state.endTime = new Date();
    const duration = this.state.endTime.getTime() - (this.state.startTime?.getTime() ?? 0);

    this.log('Test run completed');
    this.log(
      `Total: ${this.totalTests}, Passed: ${this.passedTests}, Failed: ${this.failedTests}, Skipped: ${this.skippedTests}`
    );
    this.log(`Duration: ${formatDuration(duration)}`);

    try {
      // Send test results to QAStudio.dev
      await this.sendTestResults();

      // Report upload failures if any
      if (this.uploadFailures.length > 0) {
        // Check if all failures are due to test run creation failure
        const testRunCreationFailureMsg = this.getTestRunCreationErrorMessage();

        const allFailuresDueToTestRunCreation =
          testRunCreationFailureMsg &&
          this.uploadFailures.every((f) => f.error === testRunCreationFailureMsg);

        if (allFailuresDueToTestRunCreation) {
          // Deduplicated message for test run creation failure
          console.warn(
            `\n[QAStudio.dev Reporter] WARNING: Test run creation failed, no results were uploaded.\n`
          );
          console.warn(`  Error: ${this.testRunCreationError!.message}\n`);
          console.warn(
            `[QAStudio.dev Reporter] ${this.totalTests} test(s) ran locally but could not be uploaded.\n`
          );
        } else {
          // Individual failure messages
          console.warn(
            `\n[QAStudio.dev Reporter] WARNING: ${this.uploadFailures.length} test result(s) failed to upload:\n`
          );
          this.uploadFailures.forEach((failure) => {
            console.warn(`  - ${failure.testTitle}`);
            console.warn(`    Error: ${failure.error}\n`);
          });
          console.warn(
            `[QAStudio.dev Reporter] Test run may be incomplete. Expected ${this.totalTests} tests, but ${this.uploadFailures.length} failed to upload.\n`
          );
        }
      }

      // Complete the test run
      if (this.state.testRunId) {
        // Calculate actual uploaded counts (excluding failures)
        const actualUploaded = this.calculateUploadedCounts();

        await this.apiClient.completeTestRun({
          testRunId: this.state.testRunId,
          summary: {
            total: actualUploaded.total,
            passed: actualUploaded.passed,
            failed: actualUploaded.failed,
            skipped: actualUploaded.skipped,
            duration,
          },
        });

        this.log('Test run completed successfully');

        // Extract base URL from API URL (remove /api suffix)
        const baseUrl = this.options.apiUrl.replace(/\/api\/?$/, '');
        const testRunUrl = `${baseUrl}/projects/${this.options.projectId}/runs/${this.state.testRunId}`;

        // Always output the URL (not just in verbose mode)
        console.log(`\n[QAStudio.dev Reporter] View test run: ${testRunUrl}`);

        if (this.uploadFailures.length > 0) {
          console.log(
            `[QAStudio.dev Reporter] ${this.totalTests - this.uploadFailures.length}/${this.totalTests} tests uploaded successfully\n`
          );
        } else {
          console.log(
            `[QAStudio.dev Reporter] All ${this.totalTests} tests uploaded successfully\n`
          );
        }
      }
    } catch (error) {
      this.handleError('Failed to send test results', error);
    }
  }

  /**
   * Wait for all pending result submissions to complete and collect failures
   */
  private async sendTestResults(): Promise<void> {
    this.flushResultBuffer();

    if (this.flushPromises.length > 0) {
      const totalPending = this.flushPromises.length;
      this.log(`Waiting for ${totalPending} pending result submissions...`);

      const results = await Promise.all(this.flushPromises.map((item) => item.promise));

      results.forEach((result, index) => {
        if (!result.success) {
          const item = this.flushPromises[index];

          this.uploadFailures.push({
            testTitle: item.testTitle,
            error: result.error,
            status: item.status,
          });

          if (this.options.verbose) {
            this.log(`Failed to upload result for ${item.testTitle}:`, result.error);
          }
        }
      });

      const successCount = totalPending - this.uploadFailures.length;
      this.log(
        `Test result processing complete: ${successCount}/${totalPending} uploaded successfully`
      );

      this.flushPromises = [];
    }
  }

  /**
   * Buffer a converted result and flush when the batch is full
   */
  private enqueueResult(item: PendingResult): void {
    this.resultBuffer.push(item);
    this.log(
      `[onTestEnd] Buffered ${item.testTitle} (${this.resultBuffer.length}/${this.options.batchSize})`
    );

    if (this.resultBuffer.length >= this.options.batchSize) {
      this.flushResultBuffer();
    }
  }

  /**
   * Flush the current result buffer as one or more API batches
   */
  private flushResultBuffer(): void {
    while (this.resultBuffer.length > 0) {
      const batch = this.resultBuffer.splice(0, this.options.batchSize);
      this.startBatchUpload(batch);
    }
  }

  /**
   * Upload a batch without blocking the Playwright worker
   */
  private startBatchUpload(batch: PendingResult[]): void {
    const batchPromise: Promise<UploadResult[]> = this.testRunReadyPromise.then(async () => {
      await this.acquireFlushSlot();
      try {
        if (!this.state.testRunId) {
          const errorMessage =
            this.getTestRunCreationErrorMessage() || 'Test run was not created successfully';
          throw new Error(errorMessage);
        }
        return await this.sendResultBatch(batch);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (this.options.verbose) {
          this.log(`Batch upload failed: ${errorMessage}`);
        }
        return batch.map(() => ({ success: false as const, error: errorMessage }));
      } finally {
        this.releaseFlushSlot();
      }
    });

    batch.forEach((item, index) => {
      this.flushPromises.push({
        promise: batchPromise.then((results) => results[index]),
        testTitle: item.testTitle,
        status: item.status,
      });
    });

    this.log(
      `Queued batch of ${batch.length} result(s) (total tracked: ${this.flushPromises.length})`
    );
  }

  private async acquireFlushSlot(): Promise<void> {
    while (this.inFlightFlushes >= this.maxConcurrentFlushes) {
      await new Promise<void>((resolve) => this.flushWaiters.push(resolve));
    }
    this.inFlightFlushes++;
  }

  private releaseFlushSlot(): void {
    this.inFlightFlushes--;
    const next = this.flushWaiters.shift();
    next?.();
  }

  /**
   * Send a batch of test results and upload their attachments
   */
  private async sendResultBatch(batch: PendingResult[]): Promise<UploadResult[]> {
    if (!this.state.testRunId) {
      return batch.map(() => ({
        success: false as const,
        error: 'Test run was not created successfully',
      }));
    }

    this.log(`Sending batch of ${batch.length} result(s)`);

    const response = await this.apiClient.submitTestResults({
      testRunId: this.state.testRunId,
      results: batch.map((item) => item.result),
    });

    this.log(`Batch submitted (${response.processedCount} processed)`);

    const failedTitles = new Set((response.errors ?? []).map((err) => err.testTitle));
    if (response.errors && response.errors.length > 0) {
      response.errors.forEach((err) => {
        this.log(`  Error: ${err.error}`);
      });
    }

    const outcomes: UploadResult[] = batch.map((item) => {
      if (failedTitles.has(item.testTitle)) {
        const match = response.errors?.find((err) => err.testTitle === item.testTitle);
        return { success: false as const, error: match?.error || 'Result rejected by API' };
      }
      return { success: true as const };
    });

    const usedResultIndexes = new Set<number>();
    const attachmentJobs: Array<{
      testResultId: string;
      attachments: PendingResult['attachments'];
    }> = [];

    for (const item of batch) {
      if (failedTitles.has(item.testTitle) || item.attachments.length === 0) {
        continue;
      }

      const matchIndex = response.results?.findIndex(
        (result, index) => !usedResultIndexes.has(index) && result.title === item.result.title
      );

      if (matchIndex === undefined || matchIndex < 0 || !response.results) {
        continue;
      }

      usedResultIndexes.add(matchIndex);
      attachmentJobs.push({
        testResultId: response.results[matchIndex].testResultId,
        attachments: item.attachments,
      });
    }

    await Promise.all(
      attachmentJobs.map((job) => this.uploadAttachments(job.testResultId, job.attachments))
    );

    return outcomes;
  }

  /**
   * Upload attachments for a test result in parallel
   */
  private async uploadAttachments(
    testResultId: string,
    attachments: Array<{
      name: string;
      contentType: string;
      data: Buffer;
      type: 'screenshot' | 'video' | 'trace' | 'other';
    }>
  ): Promise<void> {
    if (attachments.length === 0) {
      return;
    }

    this.log(`Uploading ${attachments.length} attachments for result ${testResultId}`);

    for (let i = 0; i < attachments.length; i += this.maxConcurrentAttachments) {
      const slice = attachments.slice(i, i + this.maxConcurrentAttachments);
      await Promise.allSettled(
        slice.map((attachment) =>
          this.apiClient
            .uploadAttachment(
              testResultId,
              attachment.name,
              attachment.contentType,
              attachment.data,
              attachment.type
            )
            .then(() => {
              this.log(`Uploaded: ${attachment.name} (${attachment.data.length} bytes)`);
            })
            .catch((error) => {
              this.log(`Failed to upload ${attachment.name}:`, error);
            })
        )
      );
    }

    this.log(`Finished uploading ${attachments.length} attachments`);
  }

  /**
   * Get formatted test run creation error message, or null if no error
   */
  private getTestRunCreationErrorMessage(): string | null {
    return this.testRunCreationError
      ? `${this.TEST_RUN_CREATION_ERROR_PREFIX} ${this.testRunCreationError.message}`
      : null;
  }

  /**
   * Normalize Playwright test status to one of three categories for reporting
   */
  private normalizeTestStatus(status: TestResult['status']): 'passed' | 'failed' | 'skipped' {
    if (status === 'passed') {
      return 'passed';
    }
    if (status === 'failed' || status === 'timedOut') {
      return 'failed';
    }
    // 'skipped' or 'interrupted'
    return 'skipped';
  }

  /**
   * Calculate actual uploaded test counts by subtracting upload failures
   *
   * This ensures that the summary sent to the API accurately reflects only the tests
   * that were successfully uploaded. Each status counter is reduced by the number of
   * failed uploads for that status, ensuring total = passed + failed + skipped.
   */
  private calculateUploadedCounts(): {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  } {
    // Count failures by status
    const failuresByStatus = this.uploadFailures.reduce(
      (acc, failure) => {
        acc[failure.status]++;
        return acc;
      },
      { passed: 0, failed: 0, skipped: 0 }
    );

    // Subtract failures from each status counter
    return {
      total: this.totalTests - this.uploadFailures.length,
      passed: this.passedTests - failuresByStatus.passed,
      failed: this.failedTests - failuresByStatus.failed,
      skipped: this.skippedTests - failuresByStatus.skipped,
    };
  }

  /**
   * Get unique test ID
   */
  private getTestId(test: TestCase): string {
    return `${test.titlePath().join(' > ')}`;
  }

  /**
   * Log message if verbose mode is enabled
   */
  private log(message: string, ...args: unknown[]): void {
    if (this.options.verbose) {
      console.log(`[QAStudio.dev Reporter] ${message}`, ...args);
    }
  }

  /**
   * Handle errors based on silent mode
   */
  private handleError(message: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const fullMessage = `${message}: ${errorMessage}`;

    if (this.options.silent) {
      console.error(`[QAStudio.dev Reporter] ${fullMessage}`);
    } else {
      throw new Error(fullMessage);
    }
  }

  /**
   * Print summary to console
   */
  printsToStdio(): boolean {
    return this.options.verbose;
  }
}

// Export types for users
export type { QAStudioReporterOptions } from './types';
