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
  QAStudioTestResult,
  UploadFailure,
  PendingUpload,
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
    includeConsoleOutput: boolean;
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
  private uploadFailures: UploadFailure[] = [];
  private testRunReadyPromise: Promise<void>;
  private testRunReadyResolve: (() => void) | null = null;
  private testRunCreationError: Error | null = null;

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
      filterFixtureSteps: sanitizedOptions.filterFixtureSteps ?? true,
      includeConsoleOutput: sanitizedOptions.includeConsoleOutput ?? false,
      maxRetries: sanitizedOptions.maxRetries ?? 3,
      timeout: sanitizedOptions.timeout ?? 30000,
      silent: sanitizedOptions.silent ?? true,
      testRunName: sanitizedOptions.testRunName ?? generateTestRunName(),
    };

    this.apiClient = new QAStudioAPIClient(this.options);

    this.state = {
      tests: new Map(),
    };

    // Initialize promise that resolves when test run is ready
    this.testRunReadyPromise = new Promise<void>((resolve) => {
      this.testRunReadyResolve = resolve;
    });

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

      // Wait for test run to be ready before sending results
      this.log(`[onTestEnd] Preparing to send test #${this.totalTests}: ${test.title}`);
      const qaResult = convertTestResult(test, result, testData.startTime, this.options);

      // Extract attachments separately for multipart upload
      const attachmentBuffers = extractAttachmentsAsBuffers(result);

      // Filter attachments based on options
      const filteredAttachments = attachmentBuffers.filter((att) => {
        if (att.type === 'screenshot' && !this.options.uploadScreenshots) {
          return false;
        }
        if (att.type === 'video' && !this.options.uploadVideos) {
          return false;
        }
        return true;
      });

      // Remove attachments from result (will upload separately)
      delete qaResult.attachments;

      // Send result immediately (fire-and-forget, don't block test execution)
      // Wait for test run to be ready, then send result
      // Convert to a promise that always fulfills (never rejects) to avoid unhandled rejections
      const sendPromise = this.testRunReadyPromise
        .then(() => {
          if (!this.state.testRunId) {
            // Provide detailed error with root cause if available
            if (this.testRunCreationError) {
              throw new Error(`Test run creation failed: ${this.testRunCreationError.message}`);
            }
            throw new Error('Test run was not created successfully');
          }
          return this.sendTestResult(qaResult, filteredAttachments);
        })
        .then(() => ({ success: true as const }))
        .catch((error: unknown) => ({
          success: false as const,
          error: error instanceof Error ? error.message : String(error),
        }));

      // Track the promise with metadata so we can collect failures in onEnd
      this.flushPromises.push({
        promise: sendPromise,
        testTitle: test.title,
      });
      this.log(
        `[onTestEnd] Promise tracked for test #${this.totalTests}: ${test.title} (total tracked: ${this.flushPromises.length})`
      );
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
        const testRunCreationFailureMsg = this.testRunCreationError
          ? `Test run creation failed: ${this.testRunCreationError.message}`
          : null;

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
    if (!this.state.testRunId) {
      this.log('No test run ID available, skipping result submission');
      return;
    }

    // Wait for all pending submissions to complete
    if (this.flushPromises.length > 0) {
      const totalPending = this.flushPromises.length;
      this.log(`Waiting for ${totalPending} pending result submissions...`);

      // Wait for all promises (all will fulfill, none will reject)
      const results = await Promise.all(this.flushPromises.map((item) => item.promise));

      // Collect failures from unsuccessful results
      results.forEach((result, index) => {
        if (!result.success) {
          const item = this.flushPromises[index];

          this.uploadFailures.push({
            testTitle: item.testTitle,
            error: result.error,
          });

          // Log in verbose mode
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
   * Send a single test result to the API
   */
  private async sendTestResult(
    result: QAStudioTestResult,
    attachments: Array<{
      name: string;
      contentType: string;
      data: Buffer;
      type: 'screenshot' | 'video' | 'trace' | 'other';
    }>
  ): Promise<void> {
    if (!this.state.testRunId) {
      return;
    }

    this.log(`Sending result: ${result.title}`);

    // Send single result to API
    const response = await this.apiClient.submitTestResults({
      testRunId: this.state.testRunId,
      results: [result],
    });

    this.log(`Result submitted: ${result.title} (${response.processedCount} processed)`);

    // Check for errors
    if (response.errors && response.errors.length > 0) {
      response.errors.forEach((err) => {
        this.log(`  Error: ${err.error}`);
      });
    }

    // Upload attachments if we have result IDs
    if (response.results && response.results.length > 0 && attachments.length > 0) {
      const testResultId = response.results[0].testResultId;
      await this.uploadAttachments(testResultId, attachments);
    }
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

    // Upload attachments in parallel
    const uploadPromises = attachments.map((attachment) =>
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
          // Don't throw - continue with other attachments
        })
    );

    await Promise.allSettled(uploadPromises);
    this.log(`Finished uploading ${attachments.length} attachments`);
  }

  /**
   * Calculate actual uploaded test counts by subtracting upload failures
   *
   * Note: We report the total number of successfully uploaded tests.
   * The status breakdown (passed/failed/skipped) reflects the test execution results,
   * not upload success. If some tests fail to upload, the total will be less than
   * the sum of passed + failed + skipped.
   */
  private calculateUploadedCounts(): {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  } {
    // Return counts: total reflects successful uploads, status breakdown reflects execution
    return {
      total: this.totalTests - this.uploadFailures.length,
      passed: this.passedTests,
      failed: this.failedTests,
      skipped: this.skippedTests,
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
