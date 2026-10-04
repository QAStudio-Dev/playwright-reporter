import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  TestCase,
  TestResult,
  FullConfig,
  Suite,
  FullResult,
} from '@playwright/test/reporter';

const mocks = vi.hoisted(() => ({
  createTestRun: vi.fn(),
  submitTestResults: vi.fn(),
  completeTestRun: vi.fn(),
  uploadAttachment: vi.fn(),
}));

vi.mock('./api-client', () => ({
  QAStudioAPIClient: class {
    createTestRun = mocks.createTestRun;
    submitTestResults = mocks.submitTestResults;
    completeTestRun = mocks.completeTestRun;
    uploadAttachment = mocks.uploadAttachment;
  },
}));

import QAStudioReporter from './index';

function makeTest(title: string): TestCase {
  const project = { name: 'chromium' };
  const suite = {
    title: 'suite',
    parent: { title: '', parent: undefined, project: () => project },
    project: () => project,
  } as unknown as Suite;

  return {
    title,
    annotations: [],
    retries: 0,
    parent: suite,
    location: { file: 'a.spec.ts', line: 1, column: 1 },
    titlePath: () => ['suite', title],
  } as unknown as TestCase;
}

function makeResult(): TestResult {
  return {
    status: 'passed',
    duration: 5,
    retry: 0,
    startTime: new Date(),
    attachments: [],
    stdout: [],
    stderr: [],
    steps: [],
  } as unknown as TestResult;
}

describe('QAStudioReporter batching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTestRun.mockResolvedValue({ id: 'run-1' });
    mocks.submitTestResults.mockImplementation(
      async (request: { results: Array<{ title: string }> }) => ({
        processedCount: request.results.length,
        results: request.results.map((result, index) => ({
          testResultId: `tr-${index}`,
          title: result.title,
        })),
      })
    );
    mocks.completeTestRun.mockResolvedValue({ success: true });
    mocks.uploadAttachment.mockResolvedValue({});
  });

  it('submits results in batches of batchSize', async () => {
    const reporter = new QAStudioReporter({
      apiUrl: 'https://example.test/api',
      apiKey: 'key',
      projectId: 'proj',
      batchSize: 10,
      silent: true,
    });

    await reporter.onBegin({} as FullConfig, {} as Suite);

    for (let i = 0; i < 25; i++) {
      const test = makeTest(`test ${i}`);
      const result = makeResult();
      reporter.onTestBegin(test, result);
      await reporter.onTestEnd(test, result);
    }

    await reporter.onEnd({} as FullResult);

    expect(mocks.submitTestResults).toHaveBeenCalledTimes(3);
    expect(mocks.submitTestResults.mock.calls[0][0].results).toHaveLength(10);
    expect(mocks.submitTestResults.mock.calls[1][0].results).toHaveLength(10);
    expect(mocks.submitTestResults.mock.calls[2][0].results).toHaveLength(5);
    expect(mocks.completeTestRun).toHaveBeenCalledTimes(1);
  });
});
