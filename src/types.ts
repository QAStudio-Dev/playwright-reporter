import type { TestCase, TestResult } from '@playwright/test/reporter';

/**
 * Configuration options for the QAStudio.dev reporter
 */
export interface QAStudioReporterOptions {
  /**
   * QAStudio.dev API base URL
   * @example 'https://qastudio.com/api'
   */
  apiUrl: string;

  /**
   * API key for authentication
   */
  apiKey: string;

  /**
   * QAStudio.dev project ID
   */
  projectId: string;

  /**
   * Test run ID (optional - will create new if not provided)
   */
  testRunId?: string;

  /**
   * Environment name (e.g., 'CI', 'staging', 'production')
   * @default 'default'
   */
  environment?: string;

  /**
   * Milestone ID for associating test runs
   */
  milestoneId?: string;

  /**
   * Automatically create a new test run if testRunId is not provided
   * @default true
   */
  createTestRun?: boolean;

  /**
   * Test run name (used when creating new test run)
   */
  testRunName?: string;

  /**
   * Test run description (used when creating new test run)
   */
  testRunDescription?: string;

  /**
   * Enable verbose logging for debugging
   * @default false
   */
  verbose?: boolean;

  /**
   * Batch size for sending test results
   * @default 50
   */
  batchSize?: number;

  /**
   * Upload screenshots for failed tests
   * @default true
   */
  uploadScreenshots?: boolean;

  /**
   * Upload videos for failed tests
   * @default true
   */
  uploadVideos?: boolean;

  /**
   * Include code snippet showing where the error occurred
   * @default true
   */
  includeErrorSnippet?: boolean;

  /**
   * Include precise error location (file, line, column)
   * @default true
   */
  includeErrorLocation?: boolean;

  /**
   * Include test execution steps for failed tests
   * @default true
   */
  includeTestSteps?: boolean;

  /**
   * Filter out Playwright internal fixture setup/teardown steps
   * @default true
   */
  filterFixtureSteps?: boolean;

  /**
   * Include console output (stdout/stderr) for failed tests
   * @default false
   */
  includeConsoleOutput?: boolean;

  /**
   * Maximum number of retry attempts for API requests
   * @default 3
   */
  maxRetries?: number;

  /**
   * Timeout for API requests in milliseconds
   * @default 30000
   */
  timeout?: number;

  /**
   * Fail silently if API is unavailable (don't throw errors)
   * @default true
   */
  silent?: boolean;
}

/**
 * Test execution step (hierarchical structure)
 */
export interface QAStudioTestStep {
  /**
   * Step title
   */
  title: string;

  /**
   * Step category (e.g., 'hook', 'test.step', 'expect', 'pw:api')
   */
  category: string;

  /**
   * Step start time (ISO 8601)
   */
  startTime: string;

  /**
   * Step duration in milliseconds
   */
  duration: number;

  /**
   * Step status
   */
  status: 'passed' | 'failed' | 'skipped' | 'timedout';

  /**
   * Error message (if step failed)
   */
  error?: string;

  /**
   * Stack trace (if step failed)
   */
  stackTrace?: string;

  /**
   * Location in source code where step was defined
   */
  location?: {
    file: string;
    line: number;
    column: number;
  };

  /**
   * Nested steps (for hierarchical test structure)
   */
  steps?: QAStudioTestStep[];
}

/**
 * Test result data to send to QAStudio.dev API
 */
export interface QAStudioTestResult {
  /**
   * Test case ID in QAStudio.dev (extracted from test metadata)
   */
  testCaseId?: string;

  /**
   * Test case title
   */
  title: string;

  /**
   * Full test path (suite hierarchy)
   */
  fullTitle: string;

  /**
   * Test status
   */
  status: 'passed' | 'failed' | 'skipped' | 'timedout';

  /**
   * Duration in milliseconds
   */
  duration: number;

  /**
   * Error message (if failed)
   */
  error?: string;

  /**
   * Stack trace (if failed)
   */
  stackTrace?: string;

  /**
   * Code snippet showing where the error occurred (if failed)
   */
  errorSnippet?: string;

  /**
   * Precise error location (if different from test location)
   */
  errorLocation?: {
    file: string;
    line: number;
    column: number;
  };

  /**
   * Test execution steps (hierarchical structure)
   */
  steps?: QAStudioTestStep[];

  /**
   * Console output from the test
   */
  consoleOutput?: {
    stdout?: string;
    stderr?: string;
  };

  /**
   * Start time (ISO 8601)
   */
  startTime: string;

  /**
   * End time (ISO 8601)
   */
  endTime: string;

  /**
   * Retry number (0 for first attempt)
   */
  retry: number;

  /**
   * Attachments (screenshots, videos, etc.)
   */
  attachments?: QAStudioAttachment[];

  /**
   * Browser/project name
   */
  projectName?: string;

  /**
   * Additional metadata
   */
  metadata?: Record<string, unknown>;
}

/**
 * Attachment data
 */
export interface QAStudioAttachment {
  /**
   * Attachment name
   */
  name: string;

  /**
   * Content type (e.g., 'image/png', 'video/webm')
   */
  contentType: string;

  /**
   * Base64 encoded file content or Buffer
   * When string, it should be base64 encoded binary data
   */
  body: string | Buffer;

  /**
   * Attachment type
   */
  type: 'screenshot' | 'video' | 'trace' | 'other';
}

/**
 * API request to create a test run
 */
export interface CreateTestRunRequest {
  projectId: string;
  name: string;
  description?: string;
  environment?: string;
  milestoneId?: string;
}

/**
 * API response for test run creation
 */
export interface CreateTestRunResponse {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  status: 'active' | 'completed';
}

/**
 * API request to submit test results
 */
export interface SubmitTestResultsRequest {
  testRunId: string;
  results: QAStudioTestResult[];
}

/**
 * API response for test result submission
 */
export interface SubmitTestResultsResponse {
  success: boolean;
  testRunId: string;
  processedCount: number;
  results?: Array<{
    testResultId: string;
    testCaseId?: string;
    title: string;
  }>;
  errors?: Array<{
    testTitle: string;
    error: string;
  }>;
}

/**
 * API request to complete a test run
 */
export interface CompleteTestRunRequest {
  testRunId: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
  };
}

/**
 * API response for test run completion
 */
export interface CompleteTestRunResponse {
  success: boolean;
  testRunId: string;
  status: 'completed';
}

/**
 * Internal test data storage
 */
export interface InternalTestData {
  test: TestCase;
  result: TestResult;
  startTime: Date;
  endTime?: Date;
}

/**
 * Pending attachment upload
 */
export interface PendingAttachment {
  testResultId: string;
  name: string;
  contentType: string;
  data: Buffer;
  type: 'screenshot' | 'video' | 'trace' | 'other';
}

/**
 * Upload failure tracking
 */
export interface UploadFailure {
  testTitle: string;
  error: string;
}

/**
 * Pending test result upload with metadata
 */
export interface PendingUpload {
  promise: Promise<{ success: true } | { success: false; error: string }>;
  testTitle: string;
}

/**
 * Reporter state
 */
export interface ReporterState {
  testRunId?: string;
  tests: Map<string, InternalTestData>;
  startTime?: Date;
  endTime?: Date;
}
