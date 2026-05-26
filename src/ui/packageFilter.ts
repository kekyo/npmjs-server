// npmjs-server - NPM package registry on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

/**
 * Represents a package version that can be searched by the UI filter.
 */
export interface PackageFilterVersion {
  version: string;
}

/**
 * Describes the package fields searched by the package list filter.
 */
export interface PackageFilterTarget {
  name: string;
  description: string;
  keywords: string[];
  versions: PackageFilterVersion[];
  license?: string;
  homepage?: string;
}

const normalizeFilterTerms = (filterText: string): string[] =>
  filterText
    .split(/[,\s]+/)
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);

const matchesPackageSearchTerm = (
  pkg: PackageFilterTarget,
  term: string
): boolean => {
  if (pkg.name.toLowerCase().includes(term)) {
    return true;
  }

  if (pkg.description.toLowerCase().includes(term)) {
    return true;
  }

  if (pkg.keywords.some((keyword) => keyword.toLowerCase().includes(term))) {
    return true;
  }

  if (
    pkg.versions.some((version) => version.version.toLowerCase().includes(term))
  ) {
    return true;
  }

  if (pkg.license?.toLowerCase().includes(term)) {
    return true;
  }

  if (pkg.homepage?.toLowerCase().includes(term)) {
    return true;
  }

  return false;
};

/**
 * Filters packages using the same multi-term matching rules as the package list UI.
 *
 * @param packages - Packages to filter.
 * @param filterText - User-provided filter text. Terms are split by spaces and commas.
 * @returns Packages whose searchable fields match every normalized term.
 */
export const filterPackages = <T extends PackageFilterTarget>(
  packages: readonly T[],
  filterText: string
): T[] => {
  if (!filterText.trim()) {
    return [...packages];
  }

  const searchTerms = normalizeFilterTerms(filterText);
  if (searchTerms.length === 0) {
    return [...packages];
  }

  return packages.filter((pkg) =>
    searchTerms.every((term) => matchesPackageSearchTerm(pkg, term))
  );
};
