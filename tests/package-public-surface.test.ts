import { describe, expect, test } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

interface PackageManifest {
  readonly bin?: Record<string, string>;
  readonly main?: unknown;
  readonly module?: unknown;
  readonly types?: unknown;
  readonly exports?: unknown;
}

const projectRoot = process.cwd();

const readPackageManifest = async (): Promise<PackageManifest> => {
  const packageJson = await fs.readFile(
    path.join(projectRoot, 'package.json'),
    'utf-8'
  );
  return JSON.parse(packageJson) as PackageManifest;
};

describe('package public surface', () => {
  test('should expose only the CLI executable from package metadata', async () => {
    const manifest = await readPackageManifest();

    expect(manifest.bin).toEqual({
      'npmjs-server': './dist/cli.mjs',
    });
    expect(manifest).not.toHaveProperty('main');
    expect(manifest).not.toHaveProperty('module');
    expect(manifest).not.toHaveProperty('types');
    expect(manifest).not.toHaveProperty('exports');
  });
});
