import { describe, expect, test } from 'vitest';
import { isFastifyDevRequest } from '../src/plugins/vite-plugin-fastify';

describe('vite fastify development request routing', () => {
  test('should leave Vite internal module requests to Vite', () => {
    expect(isFastifyDevRequest('/@vite/client')).toBe(false);
    expect(isFastifyDevRequest('/@react-refresh')).toBe(false);
    expect(
      isFastifyDevRequest('/@fs/home/app/node_modules/react/index.js')
    ).toBe(false);
    expect(isFastifyDevRequest('/@id/react')).toBe(false);
  });

  test('should forward npm registry and UI API requests to Fastify', () => {
    expect(isFastifyDevRequest('/api/ui/config')).toBe(true);
    expect(isFastifyDevRequest('/-/whoami')).toBe(true);
    expect(isFastifyDevRequest('/npm-login/test-flow')).toBe(true);
    expect(isFastifyDevRequest('/@scope/pkg')).toBe(true);
    expect(isFastifyDevRequest('/@scope/pkg?write=true')).toBe(true);
    expect(isFastifyDevRequest('/health')).toBe(true);
  });
});
