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
  PendingAttachment,
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
    batchSize: number;
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
  private resultQueue: Array<{ result: QAStudioTestResult; attachments: PendingAttachment[] }> = [];
  private flushPromises: Promise<void>[] = [];

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
      batchSize: sanitizedOptions.batchSize ?? 50,
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
      this.handleError('Failed to create test run', error);
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

      // Stream results: convert and queue result immediately
      if (this.state.testRunId) {
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

        // Queue result with attachments for later upload
        this.resultQueue.push({
          result: qaResult,
          attachments: filteredAttachments.map((att) => ({
            testResultId: '', // Will be filled after result submission
            name: att.name,
            contentType: att.contentType,
            data: att.data,
            type: att.type,
          })),
        });

        // Flush when batch size is reached
        if (this.resultQueue.length >= this.options.batchSize) {
          await this.flushResults();
        }
      }
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

      // Complete the test run
      if (this.state.testRunId) {
        await this.apiClient.completeTestRun({
          testRunId: this.state.testRunId,
          summary: {
            total: this.totalTests,
            passed: this.passedTests,
            failed: this.failedTests,
            skipped: this.skippedTests,
            duration,
          },
        });

        this.log('Test run completed successfully');

        // Extract base URL from API URL (remove /api suffix)
        const baseUrl = this.options.apiUrl.replace(/\/api\/?$/, '');
        const testRunUrl = `${baseUrl}/projects/${this.options.projectId}/runs/${this.state.testRunId}`;

        // Always output the URL (not just in verbose mode)
        console.log(`\n[QAStudio.dev Reporter] View test run: ${testRunUrl}\n`);
      }
    } catch (error) {
      this.handleError('Failed to send test results', error);
    }
  }

  /**
   * Send test results to QAStudio.dev in batches
   */
  private async sendTestResults(): Promise<void> {
    if (!this.state.testRunId) {
      this.log('No test run ID available, skipping result submission');
      return;
    }

    // Flush any remaining queued results
    if (this.resultQueue.length > 0) {
      await this.flushResults();
    }

    // Wait for all pending flushes to complete
    if (this.flushPromises.length > 0) {
      this.log(`Waiting for ${this.flushPromises.length} pending batch submissions...`);
      await Promise.allSettled(this.flushPromises);
      this.flushPromises = [];
    }

    this.log('All test results sent successfully');
  }

  /**
   * Flush queued results to API
   */
  private async flushResults(): Promise<void> {
    if (this.resultQueue.length === 0 || !this.state.testRunId) {
      return;
    }

    // Get batch to send (but DON'T clear queue yet - only after success)
    const batch = [...this.resultQueue];

    this.log(`Flushing batch of ${batch.length} results`);

    // Extract just the results (without attachments) for submission
    const results = batch.map((item) => item.result);

    // Send batch asynchronously (don't block test execution)
    const flushPromise = this.apiClient
      .submitTestResults({
        testRunId: this.state.testRunId,
        results,
      })
      .then(async (response) => {
        this.log(`Batch submitted successfully: ${response.processedCount} results processed`);

        // Only remove successfully processed results from queue
        // The API returns which results were processed (including duplicates)
        if (response.results && response.results.length > 0) {
          // Create a set of processed test titles for efficient lookup
          const processedTitles = new Set(response.results.map((r) => r.title));

          // Remove processed items from queue
          this.resultQueue = this.resultQueue.filter(
            (item) => !processedTitles.has(item.result.title)
          );

          this.log(
            `Removed ${processedTitles.size} processed results from queue, ${this.resultQueue.length} remaining`
          );
        }

        if (response.errors && response.errors.length > 0) {
          this.log(`Batch had ${response.errors.length} errors:`);
          response.errors.forEach((err) => {
            this.log(`  - ${err.testTitle}: ${err.error}`);
          });
        }

        // Upload attachments in parallel if we have result IDs
        if (response.results && response.results.length > 0) {
          await this.uploadBatchAttachments(batch, response.results);
        }
      })
      .catch((error) => {
        this.handleError('Failed to send batch', error);
        // Don't clear queue on failure - results will be retried in next flush
        this.log(`Batch failed, ${this.resultQueue.length} results remain in queue for retry`);
      });

    // Track the promise so we can wait for it in onEnd
    this.flushPromises.push(flushPromise);
  }

  /**
   * Upload attachments for a batch of results in parallel
   */
  private async uploadBatchAttachments(
    batch: Array<{ result: QAStudioTestResult; attachments: PendingAttachment[] }>,
    resultIds: Array<{ testResultId: string; testCaseId?: string; title: string }>
  ): Promise<void> {
    // Create a map of title to testResultId for quick lookup
    const titleToResultId = new Map<string, string>();
    for (const resultId of resultIds) {
      titleToResultId.set(resultId.title, resultId.testResultId);
    }

    // Collect all attachments with their test result IDs
    const allAttachments: PendingAttachment[] = [];
    for (const item of batch) {
      const testResultId = titleToResultId.get(item.result.title);
      if (testResultId && item.attachments.length > 0) {
        // Update each attachment with the test result ID
        for (const attachment of item.attachments) {
          attachment.testResultId = testResultId;
          allAttachments.push(attachment);
        }
      }
    }

    if (allAttachments.length === 0) {
      return;
    }

    this.log(`Uploading ${allAttachments.length} attachments in parallel`);

    // Upload attachments in parallel (up to 10 concurrent uploads via HTTP agent maxSockets)
    const uploadPromises = allAttachments.map((attachment) =>
      this.apiClient
        .uploadAttachment(
          attachment.testResultId,
          attachment.name,
          attachment.contentType,
          attachment.data,
          attachment.type
        )
        .then((result) => {
          this.log(`Uploaded attachment: ${attachment.name} (${attachment.data.length} bytes)`);
          return result;
        })
        .catch((error) => {
          this.log(`Failed to upload attachment ${attachment.name}:`, error);
          // Don't throw - continue with other attachments
        })
    );

    await Promise.allSettled(uploadPromises);
    this.log(`Finished uploading ${allAttachments.length} attachments`);
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
