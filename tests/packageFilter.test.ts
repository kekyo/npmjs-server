import { describe, expect, test } from 'vitest';
import { filterPackages } from '../src/ui/packageFilter';
import { createPackageListViewState } from '../src/ui/packageListViewState';

const packages = [
  {
    name: 'cat-doubler',
    description: 'Universal scaffolder generator',
    keywords: ['template', 'generator'],
    license: 'MIT',
    homepage: 'https://example.test/cat-doubler',
    versions: [{ version: '0.11.0' }, { version: '0.10.0' }],
  },
  {
    name: '@scope/worker',
    description: 'Queue worker',
    keywords: ['queue'],
    license: 'Apache-2.0',
    homepage: 'https://example.test/worker',
    versions: [{ version: '1.0.0' }],
  },
];

describe('package list filtering', () => {
  test('should filter npm packages locally by package metadata', () => {
    expect(filterPackages(packages, 'cat').map((pkg) => pkg.name)).toEqual([
      'cat-doubler',
    ]);
    expect(
      filterPackages(packages, 'queue 1.0').map((pkg) => pkg.name)
    ).toEqual(['@scope/worker']);
    expect(
      filterPackages(packages, 'mit generator').map((pkg) => pkg.name)
    ).toEqual(['cat-doubler']);
  });

  test('should keep infinite scroll disabled while a filter is active', () => {
    expect(
      createPackageListViewState({
        filterText: 'cat',
        filteredPackageCount: 1,
        hasMorePackages: true,
      }).infiniteScrollHasMore
    ).toBe(false);
  });
});
