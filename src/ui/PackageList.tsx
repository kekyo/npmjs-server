// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import {
  useEffect,
  useState,
  useImperativeHandle,
  forwardRef,
  useCallback,
  useMemo,
} from 'react';
import {
  Typography,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  CircularProgress,
  Alert,
  Chip,
  Box,
  Button,
  TextField,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PackageIcon from '@mui/icons-material/Inventory';
import DownloadIcon from '@mui/icons-material/Download';
import InfiniteScroll from 'react-infinite-scroll-component';
import { apiFetch } from './utils/apiClient';
import { filterPackages } from './packageFilter';
import { createPackageListViewState } from './packageListViewState';
import { TypedMessage, useTypedMessage } from 'typed-message';
import { messages } from '../generated/messages';

interface PackageSummary {
  name: string;
  description: string;
  keywords: string[];
  license?: string;
  repository?: unknown;
  homepage?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  versions: Array<{
    version: string;
    tarball: string;
  }>;
}

interface PackageListResponse {
  totalHits: number;
  data: PackageSummary[];
}

interface ServerConfig {
  authMode: 'none' | 'publish' | 'full';
  currentUser?: {
    username: string;
    role: string;
    authenticated: boolean;
  } | null;
}

export interface PackageListRef {
  refresh: () => void;
}

interface PackageListProps {
  serverConfig?: ServerConfig | null;
}

const getRepositoryUrl = (repository: unknown): string | undefined => {
  if (typeof repository === 'string') {
    return repository;
  }
  if (
    repository &&
    typeof repository === 'object' &&
    'url' in repository &&
    typeof repository.url === 'string'
  ) {
    return repository.url;
  }
  return undefined;
};

const PackageList = forwardRef<PackageListRef, PackageListProps>(
  ({ serverConfig }, ref) => {
    const getMessage = useTypedMessage();
    const [packages, setPackages] = useState<PackageSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(true);
    const [page, setPage] = useState(0);
    const [totalHits, setTotalHits] = useState(0);
    const [expandedPanels, setExpandedPanels] = useState<Set<string>>(
      new Set()
    );
    const [filterText, setFilterText] = useState('');
    const pageSize = 20;

    const fetchPackages = async (isInitialLoad = true) => {
      if (!serverConfig) {
        setLoading(false);
        return;
      }

      if (
        serverConfig.authMode === 'full' &&
        !serverConfig.currentUser?.authenticated
      ) {
        setLoading(false);
        return;
      }

      if (isInitialLoad) {
        setLoading(true);
        setError(null);
        setPackages([]);
        setPage(0);
        setHasMore(true);
      }

      try {
        const skip = isInitialLoad ? 0 : page * pageSize;
        const response = await apiFetch('api/ui/packages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            skip,
            take: pageSize,
          }),
        });

        if (response.status === 401) {
          setLoading(false);
          return;
        }
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = (await response.json()) as PackageListResponse;
        const sortedPackages = data.data.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        );

        setPackages((prevPackages) =>
          isInitialLoad ? sortedPackages : [...prevPackages, ...sortedPackages]
        );
        setTotalHits(data.totalHits);

        const loadedCount = isInitialLoad
          ? sortedPackages.length
          : packages.length + sortedPackages.length;
        setHasMore(loadedCount < data.totalHits);
        if (!isInitialLoad) {
          setPage((prevPage) => prevPage + 1);
        } else {
          setPage(1);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error occurred');
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    };

    const loadMorePackages = () => {
      if (!loading) {
        fetchPackages(false);
      }
    };

    const filteredPackages = useMemo(
      () => filterPackages(packages, filterText),
      [packages, filterText]
    );
    const packageListViewState = useMemo(
      () =>
        createPackageListViewState({
          filterText,
          filteredPackageCount: filteredPackages.length,
          hasMorePackages: hasMore,
        }),
      [filterText, filteredPackages.length, hasMore]
    );

    const handleAccordionChange = useCallback(
      (packageName: string) =>
        (_event: React.SyntheticEvent, isExpanded: boolean) => {
          setExpandedPanels((prev) => {
            const next = new Set(prev);
            if (isExpanded) {
              next.add(packageName);
            } else {
              next.delete(packageName);
            }
            return next;
          });
        },
      []
    );

    useEffect(() => {
      if (!serverConfig) {
        return;
      }
      fetchPackages();
    }, [serverConfig]);

    useEffect(() => {
      if (!packageListViewState.hasActiveFilter || loading) {
        return;
      }

      if (filteredPackages.length < pageSize / 2 && hasMore) {
        loadMorePackages();
      }
    }, [
      filteredPackages.length,
      packageListViewState.hasActiveFilter,
      loading,
      hasMore,
      pageSize,
    ]);

    useImperativeHandle(ref, () => ({
      refresh: () => fetchPackages(true),
    }));

    if (loading) {
      return (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '200px',
          }}
        >
          <CircularProgress />
        </Box>
      );
    }

    if (
      serverConfig?.authMode === 'full' &&
      !serverConfig?.currentUser?.authenticated
    ) {
      return null;
    }

    if (error) {
      return (
        <Alert severity="error">
          <TypedMessage
            message={messages.ERROR_LOADING_PACKAGES}
            params={{ error }}
          />
        </Alert>
      );
    }

    if (packages.length === 0 && !filterText) {
      return (
        <Alert severity="info">
          <TypedMessage message={messages.NO_PACKAGES_FOUND} />
        </Alert>
      );
    }

    return (
      <Box>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            mb: 2,
          }}
        >
          <Typography
            variant="h4"
            component="h1"
            sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
          >
            <PackageIcon />
            <TypedMessage message={messages.PACKAGES_HEADER} />{' '}
            {packageListViewState.hasActiveFilter ? (
              <>
                ({filteredPackages.length}/
                {totalHits > 0 ? totalHits : packages.length})
              </>
            ) : (
              <>({totalHits > 0 ? totalHits : packages.length})</>
            )}
          </Typography>
          <TextField
            size="small"
            placeholder={getMessage(messages.FILTER_PACKAGES_PLACEHOLDER)}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            sx={{ minWidth: 250 }}
          />
        </Box>

        {packageListViewState.shouldRenderPackageAccordions ? (
          <InfiniteScroll
            dataLength={filteredPackages.length}
            next={loadMorePackages}
            hasMore={packageListViewState.infiniteScrollHasMore}
            loader={
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  p: 2,
                }}
              >
                <CircularProgress size={24} />
                <Typography variant="body2" sx={{ ml: 2 }}>
                  <TypedMessage message={messages.LOADING_MORE_PACKAGES} />
                </Typography>
              </Box>
            }
            endMessage={
              filteredPackages.length > 0 ? (
                <Typography
                  sx={{ textAlign: 'center', p: 2, color: 'text.secondary' }}
                >
                  {packageListViewState.hasActiveFilter
                    ? getMessage(messages.SHOWING_PACKAGES, {
                        current: filteredPackages.length,
                        total: packages.length,
                      })
                    : getMessage(messages.ALL_PACKAGES_LOADED, {
                        count: packages.length,
                      })}
                </Typography>
              ) : null
            }
            scrollThreshold={0.9}
          >
            {filteredPackages.map((pkg) => {
              const repositoryUrl = getRepositoryUrl(pkg.repository);
              return (
                <Accordion
                  key={pkg.name}
                  sx={{
                    mb: 1,
                    bgcolor: (theme) =>
                      theme.palette.mode === 'light' ? 'grey.100' : 'grey.900',
                    '&:before': {
                      display: 'none',
                    },
                  }}
                  expanded={expandedPanels.has(pkg.name)}
                  onChange={handleAccordionChange(pkg.name)}
                  slotProps={{
                    transition: {
                      unmountOnExit: true,
                    },
                  }}
                >
                  <AccordionSummary
                    expandIcon={<ExpandMoreIcon />}
                    aria-controls={`panel-${pkg.name}-content`}
                    id={`panel-${pkg.name}-header`}
                  >
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        width: '100%',
                        gap: 2,
                      }}
                    >
                      <PackageIcon sx={{ color: 'text.secondary' }} />
                      <Typography variant="h6" component="div">
                        {pkg.name}
                      </Typography>
                    </Box>
                  </AccordionSummary>
                  <AccordionDetails>
                    {expandedPanels.has(pkg.name) && (
                      <Box>
                        {pkg.description && (
                          <Box sx={{ mb: 2 }}>
                            <Typography variant="subtitle2" gutterBottom>
                              <TypedMessage
                                message={messages.DESCRIPTION_LABEL}
                              />
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {pkg.description}
                            </Typography>
                          </Box>
                        )}

                        {pkg.keywords.length > 0 && (
                          <Box sx={{ mb: 2 }}>
                            <Typography variant="subtitle2" gutterBottom>
                              <TypedMessage message={messages.TAGS_LABEL} />
                            </Typography>
                            <Box
                              sx={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: 0.5,
                              }}
                            >
                              {pkg.keywords.map((keyword) => (
                                <Chip
                                  key={keyword}
                                  label={keyword}
                                  size="small"
                                  variant="outlined"
                                />
                              ))}
                            </Box>
                          </Box>
                        )}

                        {(repositoryUrl || pkg.homepage || pkg.license) && (
                          <Box sx={{ mb: 2 }}>
                            <Typography variant="subtitle2" gutterBottom>
                              <TypedMessage message={messages.LINKS_LABEL} />
                            </Typography>
                            <Box sx={{ display: 'flex', gap: 1 }}>
                              {pkg.homepage && (
                                <Chip
                                  label={getMessage(messages.PROJECT_LINK)}
                                  component="a"
                                  href={pkg.homepage}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  clickable
                                  size="small"
                                  color="primary"
                                />
                              )}
                              {repositoryUrl && (
                                <Chip
                                  label="Repository"
                                  component="a"
                                  href={repositoryUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  clickable
                                  size="small"
                                  color="primary"
                                />
                              )}
                              {pkg.license && (
                                <Chip
                                  label={`${getMessage(messages.LICENSE)}: ${pkg.license}`}
                                  size="small"
                                  color="secondary"
                                />
                              )}
                            </Box>
                          </Box>
                        )}

                        <Typography variant="subtitle2" gutterBottom>
                          <TypedMessage
                            message={messages.VERSIONS_LABEL}
                            params={{ count: pkg.versions.length }}
                          />
                        </Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                          {pkg.versions.map((version) => (
                            <Button
                              key={version.version}
                              variant="outlined"
                              size="small"
                              startIcon={<DownloadIcon />}
                              onClick={() => {
                                window.open(version.tarball, '_blank');
                              }}
                            >
                              {version.version}
                            </Button>
                          ))}
                        </Box>
                      </Box>
                    )}
                  </AccordionDetails>
                </Accordion>
              );
            })}
          </InfiniteScroll>
        ) : (
          <Alert severity="info">
            <TypedMessage message={messages.NO_PACKAGES_MATCH_FILTER} />
          </Alert>
        )}
      </Box>
    );
  }
);

PackageList.displayName = 'PackageList';

export default PackageList;
