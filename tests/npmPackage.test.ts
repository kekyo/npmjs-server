import { describe, expect, test } from 'vitest';
import { createFileItem, createTarPacker } from 'tar-vern';
import {
  createTarballFileName,
  decodePackageName,
  extractNpmTarball,
  packageNameToPathSegments,
} from '../src/utils/npmPackage';

const streamToBuffer = async (
  stream: NodeJS.ReadableStream
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const createPackageTarball = async (
  manifest: Record<string, unknown>,
  readme = '# Test package'
): Promise<Buffer> => {
  const items = async function* () {
    yield await createFileItem(
      'package/package.json',
      JSON.stringify(manifest, null, 2)
    );
    yield await createFileItem('package/README.md', readme);
  };
  return streamToBuffer(createTarPacker(items(), 'gzip'));
};

describe('npm package utilities', () => {
  test('should decode scoped package names and build storage paths', () => {
    expect(decodePackageName('@scope%2fpkg')).toBe('@scope/pkg');
    expect(packageNameToPathSegments('@scope/pkg')).toEqual(['@scope', 'pkg']);
    expect(createTarballFileName('@scope/pkg', '1.2.3')).toBe('pkg-1.2.3.tgz');
  });

  test('should extract package.json and README using tar-vern', async () => {
    const tarball = await createPackageTarball(
      {
        name: '@scope/pkg',
        version: '1.0.0',
        description: 'example',
      },
      '# Example'
    );

    const extracted = await extractNpmTarball(tarball);

    expect(extracted.manifest.name).toBe('@scope/pkg');
    expect(extracted.manifest.version).toBe('1.0.0');
    expect(extracted.readme).toBe('# Example');
  });

  test.each([
    'release/candidate',
    'release\\candidate',
    '1.0.0%2Fpreview',
    '1.0.0 ',
    'latest',
    1,
    null,
  ])('should reject invalid manifest version %j', async (version) => {
    const tarball = await createPackageTarball({ name: 'pkg', version });
    await expect(extractNpmTarball(tarball)).rejects.toThrow(/version/i);
  });

  test('should preserve prerelease and build identifiers verbatim', async () => {
    const version = '2.0.0-rc.1+Build.007';
    const tarball = await createPackageTarball({ name: 'pkg', version });
    expect((await extractNpmTarball(tarball)).manifest.version).toBe(version);
  });
});
