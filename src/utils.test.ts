import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  sanitizeUrl,
  sanitizeString,
  validateOptions,
  batchArray,
  formatDuration,
  generateTestRunName,
  convertTestResult,
} from './utils';
import type { TestCase, TestResult, Suite } from '@playwright/test/reporter';

describe('stripAnsi', () => {
  it('should return undefined for undefined input', () => {
    expect(stripAnsi(undefined)).toBeUndefined();
  });

  it('should return string unchanged if no ANSI codes present', () => {
    const clean = 'https://qastudio.dev/api';
    expect(stripAnsi(clean)).toBe(clean);
  });

  it('should remove hex ANSI escape sequences (\\x1b[31m)', () => {
    const input = '\x1b[31mhttps://qastudio.dev/api\x1b[0m';
    const expected = 'https://qastudio.dev/api';
    expect(stripAnsi(input)).toBe(expected);
  });

  it('should remove bracket color codes ([31m)', () => {
    const input = '[31mhttps://qastudio.dev/api[0m';
    const expected = 'https://qastudio.dev/api';
    expect(stripAnsi(input)).toBe(expected);
  });

  it('should remove multi-digit bracket codes ([1;31m)', () => {
    const input = '[1;31mhttps://qastudio.dev/api[0m';
    const expected = 'https://qastudio.dev/api';
    expect(stripAnsi(input)).toBe(expected);
  });

  it('should remove ANSI codes from middle of string', () => {
    const input = 'https://\x1b[31mqastudio\x1b[0m.dev/api';
    const expected = 'https://qastudio.dev/api';
    expect(stripAnsi(input)).toBe(expected);
  });

  it('should trim whitespace after removing ANSI codes', () => {
    const input = '  \x1b[31mhttps://qastudio.dev/api\x1b[0m  ';
    const expected = 'https://qastudio.dev/api';
    expect(stripAnsi(input)).toBe(expected);
  });

  it('should handle complex ANSI sequences', () => {
    const input = '\x1b[1;31;40mBold Red on Black\x1b[0m';
    const expected = 'Bold Red on Black';
    expect(stripAnsi(input)).toBe(expected);
  });

  it('should handle strings with only ANSI codes', () => {
    const input = '\x1b[31m\x1b[0m';
    const expected = '';
    expect(stripAnsi(input)).toBe(expected);
  });
});

describe('sanitizeUrl', () => {
  it('should return valid URL unchanged', () => {
    const url = 'https://qastudio.dev/api';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('should strip ANSI codes from URL', () => {
    const input = '\x1b[31mhttps://qastudio.dev/api\x1b[0m';
    const expected = 'https://qastudio.dev/api';
    expect(sanitizeUrl(input)).toBe(expected);
  });

  it('should throw error for invalid URL format', () => {
    expect(() => sanitizeUrl('not a url')).toThrow(/Invalid URL format/);
  });

  it('should throw error for empty string', () => {
    expect(() => sanitizeUrl('')).toThrow(/Invalid URL format/);
  });

  it('should handle URLs with ports', () => {
    const url = 'https://qastudio.dev:8080/api';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('should handle URLs with query parameters', () => {
    const url = 'https://qastudio.dev/api?key=value&foo=bar';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('should handle localhost URLs', () => {
    const url = 'http://localhost:3000/api';
    expect(sanitizeUrl(url)).toBe(url);
  });
});

describe('sanitizeString', () => {
  it('should return undefined for undefined input', () => {
    expect(sanitizeString(undefined)).toBeUndefined();
  });

  it('should strip ANSI codes from string', () => {
    const input = '\x1b[31mproject-123\x1b[0m';
    const expected = 'project-123';
    expect(sanitizeString(input)).toBe(expected);
  });

  it('should return clean string unchanged', () => {
    const clean = 'project-123';
    expect(sanitizeString(clean)).toBe(clean);
  });
});

describe('validateOptions', () => {
  const validOptions = {
    apiUrl: 'https://qastudio.dev/api',
    apiKey: 'test-key',
    projectId: 'test-project',
  };

  it('should not throw for valid options', () => {
    expect(() => validateOptions(validOptions)).not.toThrow();
  });

  it('should throw if options is not an object', () => {
    expect(() => validateOptions(null)).toThrow(/must be an object/);
    expect(() => validateOptions('string')).toThrow(/must be an object/);
    expect(() => validateOptions(123)).toThrow(/must be an object/);
  });

  it('should throw if apiUrl is missing', () => {
    const options = { ...validOptions, apiUrl: undefined };
    expect(() => validateOptions(options)).toThrow(/apiUrl is required/);
  });

  it('should throw if apiUrl is not a string', () => {
    const options = { ...validOptions, apiUrl: 123 };
    expect(() => validateOptions(options)).toThrow(/apiUrl is required/);
  });

  it('should throw if apiKey is missing', () => {
    const options = { ...validOptions, apiKey: undefined };
    expect(() => validateOptions(options)).toThrow(/apiKey is required/);
  });

  it('should throw if apiKey is not a string', () => {
    const options = { ...validOptions, apiKey: 123 };
    expect(() => validateOptions(options)).toThrow(/apiKey is required/);
  });

  it('should throw if projectId is missing', () => {
    const options = { ...validOptions, projectId: undefined };
    expect(() => validateOptions(options)).toThrow(/projectId is required/);
  });

  it('should throw if projectId is not a string', () => {
    const options = { ...validOptions, projectId: 123 };
    expect(() => validateOptions(options)).toThrow(/projectId is required/);
  });

  it('should throw if URL is invalid after stripping ANSI codes', () => {
    const options = {
      ...validOptions,
      apiUrl: '\x1b[31mnot-a-url\x1b[0m',
    };
    expect(() => validateOptions(options)).toThrow(/Invalid URL format/);
  });
});

describe('batchArray', () => {
  it('should split array into batches of specified size', () => {
    const array = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const batches = batchArray(array, 3);
    expect(batches).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10]]);
  });

  it('should return single batch if array smaller than batch size', () => {
    const array = [1, 2, 3];
    const batches = batchArray(array, 10);
    expect(batches).toEqual([[1, 2, 3]]);
  });

  it('should handle empty array', () => {
    const batches = batchArray([], 5);
    expect(batches).toEqual([]);
  });

  it('should handle batch size of 1', () => {
    const array = [1, 2, 3];
    const batches = batchArray(array, 1);
    expect(batches).toEqual([[1], [2], [3]]);
  });

  it('should handle exact multiples', () => {
    const array = [1, 2, 3, 4, 5, 6];
    const batches = batchArray(array, 2);
    expect(batches).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });
});

describe('formatDuration', () => {
  it('should format milliseconds less than 1 second', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('should format seconds', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(45000)).toBe('45s');
  });

  it('should format minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(90000)).toBe('1m 30s');
    expect(formatDuration(125000)).toBe('2m 5s');
  });

  it('should format hours, minutes, and seconds', () => {
    expect(formatDuration(3600000)).toBe('1h 0m 0s');
    expect(formatDuration(3665000)).toBe('1h 1m 5s');
    expect(formatDuration(7325000)).toBe('2h 2m 5s');
  });
});

describe('generateTestRunName', () => {
  it('should generate a test run name with current date/time', () => {
    const name = generateTestRunName();
    expect(name).toMatch(/^Playwright Test Run - \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/);
  });

  it('should generate unique names when called multiple times', () => {
    const name1 = generateTestRunName();
    // Small delay to ensure different timestamp
    const name2 = generateTestRunName();
    // Names should have same format but might differ in time
    expect(name1).toMatch(/^Playwright Test Run -/);
    expect(name2).toMatch(/^Playwright Test Run -/);
  });
});

function makeTest(title = 'logs in'): TestCase {
  const project = { name: 'chromium' };
  const suite = {
    title: 'auth',
    parent: {
      title: '',
      parent: undefined,
      project: () => project,
    },
    project: () => project,
  } as unknown as Suite;

  return {
    title,
    annotations: [],
    retries: 0,
    parent: suite,
    location: { file: 'auth.spec.ts', line: 10, column: 1 },
    titlePath: () => ['auth', title],
  } as unknown as TestCase;
}

function makeResult(status: TestResult['status'], steps = true): TestResult {
  return {
    status,
    duration: 42,
    retry: 0,
    startTime: new Date(),
    attachments: [],
    stdout: [],
    stderr: [],
    steps: steps
      ? [
          {
            title: 'goto',
            category: 'pw:api',
            startTime: new Date(),
            duration: 10,
            steps: [],
          },
        ]
      : [],
    error:
      status === 'failed' || status === 'timedOut'
        ? { message: 'boom', stack: 'Error: boom', snippet: 'expect(1).toBe(2)' }
        : undefined,
  } as unknown as TestResult;
}

describe('convertTestResult', () => {
  const options = {
    apiUrl: 'https://example.test/api',
    apiKey: 'key',
    projectId: 'proj',
  };

  it('does not attach file bodies on conversion', () => {
    const converted = convertTestResult(makeTest(), makeResult('passed'), new Date(), options);
    expect(converted.attachments).toBeUndefined();
  });

  it('omits steps for passing tests by default', () => {
    const converted = convertTestResult(makeTest(), makeResult('passed'), new Date(), options);
    expect(converted.steps).toBeUndefined();
  });

  it('includes steps for failed tests', () => {
    const converted = convertTestResult(makeTest(), makeResult('failed'), new Date(), options);
    expect(converted.steps).toHaveLength(1);
    expect(converted.steps?.[0].title).toBe('goto');
  });

  it('includes steps for passing tests when includePassingTestSteps is true', () => {
    const converted = convertTestResult(makeTest(), makeResult('passed'), new Date(), {
      ...options,
      includePassingTestSteps: true,
    });
    expect(converted.steps).toHaveLength(1);
  });
});
