import * as fs from 'fs';
import type { TestCase, TestResult, Suite, TestStep } from '@playwright/test/reporter';
import type {
  QAStudioTestResult,
  QAStudioAttachment,
  QAStudioReporterOptions,
  QAStudioTestStep,
} from './types';

/**
 * Convert Playwright test result to QAStudio.dev format
 */
export function convertTestResult(
  test: TestCase,
  result: TestResult,
  startTime: Date,
  options?: QAStudioReporterOptions
): QAStudioTestResult {
  const endTime = new Date(startTime.getTime() + result.duration);

  // Set defaults for options
  const includeErrorSnippet = options?.includeErrorSnippet !== false; // default true
  const includeErrorLocation = options?.includeErrorLocation !== false; // default true
  const includeTestSteps = options?.includeTestSteps !== false; // default true
  const includeConsoleOutput = options?.includeConsoleOutput === true; // default false

  const testResult: QAStudioTestResult = {
    testCaseId: extractTestCaseId(test),
    title: test.title,
    fullTitle: getFullTitle(test),
    status: mapTestStatus(result.status),
    duration: result.duration,
    error: result.error?.message,
    stackTrace: result.error?.stack,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    retry: result.retry,
    attachments: extractAttachments(result),
    projectName: test.parent?.project()?.name,
    metadata: extractMetadata(test),
  };

  // Add error snippet if available and enabled
  if (includeErrorSnippet && result.error?.snippet) {
    testResult.errorSnippet = result.error.snippet;
  }

  // Add error location if available and enabled
  if (includeErrorLocation && result.error?.location) {
    testResult.errorLocation = {
      file: result.error.location.file,
      line: result.error.location.line,
      column: result.error.location.column,
    };
  }

  // Add test steps if enabled
  if (includeTestSteps && result.steps && result.steps.length > 0) {
    const filterFixtures = options?.filterFixtureSteps !== false; // default true
    testResult.steps = result.steps
      .map((step) => convertTestStep(step, filterFixtures))
      .filter((step) => step !== null) as QAStudioTestStep[];
  }

  // Add console output if enabled
  if (includeConsoleOutput) {
    const stdout = extractConsoleOutput(result.stdout);
    const stderr = extractConsoleOutput(result.stderr);

    if (stdout || stderr) {
      testResult.consoleOutput = {
        stdout,
        stderr,
      };
    }
  }

  return testResult;
}

/**
 * Convert Playwright test step to QAStudio.dev format (recursive for nested steps)
 * Returns null if step should be filtered out
 */
export function convertTestStep(step: TestStep, filterFixtures = true): QAStudioTestStep | null {
  // Filter out fixture steps if enabled
  if (filterFixtures && step.category === 'fixture') {
    return null;
  }

  // Map Playwright step status to our format
  let status: 'passed' | 'failed' | 'skipped' | 'timedout';
  if (step.error) {
    status = 'failed';
  } else if (step.duration === -1) {
    status = 'skipped';
  } else {
    status = 'passed';
  }

  const qaStep: QAStudioTestStep = {
    title: step.title,
    category: step.category,
    startTime: step.startTime.toISOString(),
    duration: step.duration,
    status,
  };

  // Add error details if present
  if (step.error) {
    qaStep.error = step.error.message;
    qaStep.stackTrace = step.error.stack;
  }

  // Add location if present
  if (step.location) {
    qaStep.location = {
      file: step.location.file,
      line: step.location.line,
      column: step.location.column,
    };
  }

  // Recursively convert nested steps
  if (step.steps && step.steps.length > 0) {
    qaStep.steps = step.steps
      .map((nestedStep) => convertTestStep(nestedStep, filterFixtures))
      .filter((s) => s !== null) as QAStudioTestStep[];
  }

  return qaStep;
}

/**
 * Extract test case ID from test annotations or title
 */
export function extractTestCaseId(test: TestCase): string | undefined {
  // Look for @testCaseId annotation
  const annotation = test.annotations.find((a) => a.type === 'testCaseId');
  if (annotation?.description) {
    return annotation.description;
  }

  // Look for QAStudio.dev ID in title (e.g., "[QA-123] Test title")
  const match = test.title.match(/^\[([A-Z]+-\d+)\]/);
  if (match) {
    return match[1];
  }

  return undefined;
}

/**
 * Get full test title including suite hierarchy
 */
export function getFullTitle(test: TestCase): string {
  const titles: string[] = [];
  let current: TestCase | Suite | undefined = test;

  while (current) {
    if (current.title) {
      titles.unshift(current.title);
    }
    current = current.parent;
  }

  return titles.join(' > ');
}

/**
 * Map Playwright test status to QAStudio.dev status
 */
export function mapTestStatus(status: string): 'passed' | 'failed' | 'skipped' | 'timedout' {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'timedOut':
      return 'timedout';
    case 'skipped':
    case 'interrupted':
      return 'skipped';
    default:
      return 'failed';
  }
}

/**
 * Extract attachments from test result
 */
export function extractAttachments(result: TestResult): QAStudioAttachment[] {
  const attachments: QAStudioAttachment[] = [];

  for (const attachment of result.attachments) {
    const type = determineAttachmentType(attachment.name, attachment.contentType);

    // Get attachment body - if it's a path, read the file synchronously
    let body: string | Buffer = '';
    if (attachment.body) {
      body = attachment.body;
    } else if (attachment.path) {
      // Read file from disk and convert to base64
      try {
        const fileBuffer = fs.readFileSync(attachment.path);
        body = fileBuffer.toString('base64');
      } catch (error) {
        console.warn(
          `[QAStudio.dev Reporter] Failed to read attachment file: ${attachment.path}`,
          error
        );
        continue; // Skip this attachment if we can't read it
      }
    }

    attachments.push({
      name: attachment.name,
      contentType: attachment.contentType,
      body,
      type,
    });
  }

  return attachments;
}

/**
 * Extract attachments as buffers for multipart upload
 */
export function extractAttachmentsAsBuffers(result: TestResult): Array<{
  name: string;
  contentType: string;
  data: Buffer;
  type: 'screenshot' | 'video' | 'trace' | 'other';
}> {
  const attachments: Array<{
    name: string;
    contentType: string;
    data: Buffer;
    type: 'screenshot' | 'video' | 'trace' | 'other';
  }> = [];

  for (const attachment of result.attachments) {
    const type = determineAttachmentType(attachment.name, attachment.contentType);

    // Get attachment as Buffer
    let data: Buffer;
    if (attachment.body) {
      // If body is already a Buffer, use it; if string (base64), convert it
      data =
        typeof attachment.body === 'string'
          ? Buffer.from(attachment.body, 'base64')
          : attachment.body;
    } else if (attachment.path) {
      // Read file from disk as Buffer
      try {
        data = fs.readFileSync(attachment.path);
      } catch (error) {
        console.warn(
          `[QAStudio.dev Reporter] Failed to read attachment file: ${attachment.path}`,
          error
        );
        continue; // Skip this attachment if we can't read it
      }
    } else {
      continue; // Skip if no body or path
    }

    attachments.push({
      name: attachment.name,
      contentType: attachment.contentType,
      data,
      type,
    });
  }

  return attachments;
}

/**
 * Determine attachment type from name and content type
 */
export function determineAttachmentType(
  name: string,
  contentType: string
): 'screenshot' | 'video' | 'trace' | 'other' {
  if (contentType.startsWith('image/') || name.toLowerCase().includes('screenshot')) {
    return 'screenshot';
  }
  if (contentType.startsWith('video/') || name.toLowerCase().includes('video')) {
    return 'video';
  }
  if (name.toLowerCase().includes('trace')) {
    return 'trace';
  }
  return 'other';
}

/**
 * Extract console output from test result
 */
export function extractConsoleOutput(output: (string | Buffer)[] | undefined): string | undefined {
  if (!output || output.length === 0) {
    return undefined;
  }

  const combined = output
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      return item.toString('utf-8');
    })
    .join('\n');

  return combined.trim() || undefined;
}

/**
 * Extract custom metadata from test
 */
export function extractMetadata(test: TestCase): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  // Add tags from annotations
  const tags = test.annotations.filter((a) => a.type === 'tag').map((a) => a.description);
  if (tags.length > 0) {
    metadata.tags = tags;
  }

  // Add location info
  if (test.location) {
    metadata.location = {
      file: test.location.file,
      line: test.location.line,
      column: test.location.column,
    };
  }

  // Add custom annotations
  for (const annotation of test.annotations) {
    if (annotation.type !== 'tag' && annotation.type !== 'testCaseId') {
      metadata[annotation.type] = annotation.description;
    }
  }

  return metadata;
}

/**
 * Read file as buffer
 */
export async function readFileAsBuffer(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

/**
 * Batch array into chunks
 */
export function batchArray<T>(array: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    batches.push(array.slice(i, i + size));
  }
  return batches;
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Generate default test run name
 */
export function generateTestRunName(): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  return `Playwright Test Run - ${dateStr} ${timeStr}`;
}

/**
 * Strip ANSI escape codes from a string
 * Removes color codes and other terminal formatting that can interfere with API calls
 */
export function stripAnsi(str: string | undefined): string | undefined {
  if (!str) return str;

  const cleaned = str
    // Remove ANSI escape sequences (e.g., \x1b[31m, \x1b[0m)
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // Remove bracket codes (e.g., [31m, [0m)
    .replace(/\[\d+m/g, '')
    // Remove multi-digit bracket codes (e.g., [1;31m)
    .replace(/\[\d+;\d+m/g, '')
    // Trim any whitespace that may have been left
    .trim();

  // Log warning if ANSI codes were detected and removed
  if (cleaned !== str.trim()) {
    console.warn(
      '[QAStudio.dev Reporter] Warning: ANSI escape codes detected and removed from configuration value'
    );
  }

  return cleaned;
}

/**
 * Sanitize and validate a URL string
 */
export function sanitizeUrl(url: string): string {
  const cleaned = stripAnsi(url) || '';

  // Validate URL format
  try {
    new URL(cleaned);
    return cleaned;
  } catch (error) {
    throw new Error(
      `Invalid URL format: "${cleaned}". Please ensure apiUrl is a valid URL (e.g., https://qastudio.dev/api)`
    );
  }
}

/**
 * Sanitize a string field by removing ANSI codes
 */
export function sanitizeString(str: string | undefined): string | undefined {
  return stripAnsi(str);
}

/**
 * Validate reporter options
 */
export function validateOptions(options: unknown): void {
  if (!options || typeof options !== 'object') {
    throw new Error('QAStudio.dev reporter options must be an object');
  }

  const opts = options as Record<string, unknown>;

  if (!opts.apiUrl || typeof opts.apiUrl !== 'string') {
    throw new Error('QAStudio.dev reporter: apiUrl is required and must be a string');
  }

  if (!opts.apiKey || typeof opts.apiKey !== 'string') {
    throw new Error('QAStudio.dev reporter: apiKey is required and must be a string');
  }

  if (!opts.projectId || typeof opts.projectId !== 'string') {
    throw new Error('QAStudio.dev reporter: projectId is required and must be a string');
  }

  // Validate URL format after stripping ANSI codes
  sanitizeUrl(opts.apiUrl);
}
