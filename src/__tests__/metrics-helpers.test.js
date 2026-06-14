import { describe, it, expect } from 'vitest';
import { formatBytes, seriesAvg, clamp, escapeHtml } from '../lib/metrics-helpers.js';

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(500)).toMatch(/500/);
    expect(formatBytes(1024)).toMatch(/1/);
    expect(formatBytes(1024 * 1024)).toMatch(/1/);
  });

  it('handles zero', () => {
    expect(formatBytes(0)).toBeTruthy();
  });
});

describe('seriesAvg', () => {
  it('computes average', () => {
    expect(seriesAvg([10, 20, 30])).toBe(20);
  });

  it('returns 0 for empty array', () => {
    expect(seriesAvg([])).toBe(0);
  });
});

describe('clamp', () => {
  it('clamps to min', () => expect(clamp(-5, 0, 100)).toBe(0));
  it('clamps to max', () => expect(clamp(200, 0, 100)).toBe(100));
  it('passes through in-range', () => expect(clamp(50, 0, 100)).toBe(50));
});

describe('escapeHtml', () => {
  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('passes clean strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});
