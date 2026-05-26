// npmjs-server - NPM package registry on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { promises as fs } from 'fs';
import { join } from 'path';
import { ReaderWriterLock } from 'async-primitives';
import { Logger } from '../../../types';
import { UserService } from '../../../services/userService';
import { SessionService } from '../../../services/sessionService';
import { AuthService } from '../../../services/authService';
import { MetadataService } from '../../../services/metadataService';
import { AuthenticatedFastifyRequest } from '../../../middleware/fastifyAuth';
import {
  name as packageName,
  version,
} from '../../../generated/packageMetadata';
import { streamFile } from '../../../utils/fileStreaming';

/**
 * Configuration for UI routes
 */
export interface UiRoutesConfig {
  userService: UserService;
  sessionService: SessionService;
  authService: AuthService;
  packagesRoot: string;
  logger: Logger;
  realm: string;
  serverUrl: {
    baseUrl?: string;
    port: number;
    isHttps: boolean;
  };
  metadataService: MetadataService;
}

/**
 * POST /api/ui/config request body (empty object)
 */
export interface ConfigRequest {
  // Empty object for consistency
}

/**
 * POST /api/ui/config response
 */
export interface ConfigResponse {
  realm: string;
  name: string;
  version: string;
  git_commit_hash: string;
  serverUrl: {
    baseUrl?: string;
    port: number;
    isHttps: boolean;
  };
  authMode: string;
  authEnabled: {
    general: boolean;
    publish: boolean;
    admin: boolean;
  };
  currentUser: {
    username: string;
    role: string;
    authenticated: boolean;
  } | null;
}

/**
 * POST /api/ui/users request body for user management
 */
export interface UserManagementRequest {
  action: 'list' | 'create' | 'delete' | 'update';
  username?: string;
  password?: string;
  role?: 'admin' | 'publish' | 'read';
}

/**
 * User list response
 */
export interface UserListResponse {
  users: Array<{
    id: string;
    username: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

/**
 * User creation response
 */
export interface UserCreateResponse {
  user: {
    id: string;
    username: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  };
}

/**
 * User deletion response
 */
export interface UserDeleteResponse {
  success: boolean;
  message: string;
}

/**
 * Password change request
 */
export interface PasswordChangeRequest {
  currentPassword?: string; // Required for self password change
  newPassword: string;
  username?: string; // For admin changing other user's password
}

/**
 * Password change response
 */
export interface PasswordChangeResponse {
  success: boolean;
  message: string;
}

/**
 * POST /api/ui/packages response.
 */
export interface PackageListResponse {
  totalHits: number;
  data: Array<{
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
  }>;
}

/**
 * Session-only authentication middleware
 */
const createSessionOnlyAuthMiddleware = (
  sessionService: SessionService,
  logger: Logger
) => {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionToken = request.cookies?.sessionToken;

    if (!sessionToken) {
      return reply
        .status(401)
        .send({ error: 'Session authentication required' });
    }

    const session = await sessionService.validateSession(sessionToken);
    if (!session) {
      return reply.status(401).send({ error: 'Invalid or expired session' });
    }

    // Add user info to request
    (request as any).user = {
      id: session.userId,
      username: session.username,
      role: session.role,
    };

    logger.info(
      `Session auth successful: ${session.username} (${session.role})`
    );
  };
};

/**
 * Role-based authorization helper
 */
const requireRole = (
  request: AuthenticatedFastifyRequest,
  reply: FastifyReply,
  roles: string[]
) => {
  if (!request.user || !roles.includes(request.user.role)) {
    return reply.status(403).send({ error: 'Insufficient permissions' });
  }
  return undefined;
};

/**
 * Registers UI Backend API routes with Fastify instance
 */
export const registerUiRoutes = async (
  fastify: FastifyInstance,
  config: UiRoutesConfig,
  locker: ReaderWriterLock
) => {
  const {
    userService,
    sessionService,
    authService,
    packagesRoot,
    logger,
    realm,
    serverUrl,
    metadataService,
  } = config;

  // Create session-only auth middleware
  const sessionOnlyAuth = createSessionOnlyAuthMiddleware(
    sessionService,
    logger
  );

  // POST /api/ui/config - Application configuration (public endpoint)
  fastify.post(
    '/config',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        let currentUser = null;

        try {
          // Check session authentication first (Cookie-based)
          const sessionToken = request.cookies?.sessionToken;
          if (sessionToken) {
            const session = await sessionService.validateSession(sessionToken);
            if (session) {
              currentUser = {
                username: session.username,
                role: session.role,
                authenticated: true,
              };
            }
          }
        } catch (error) {
          logger.error(
            `Error checking authentication for /api/ui/config: ${error}`
          );
        }

        const response: ConfigResponse = {
          realm: realm,
          name: packageName,
          version: version,
          git_commit_hash: 'unknown',
          serverUrl: serverUrl,
          authMode: authService.getAuthMode(),
          authEnabled: {
            general: authService.isAuthRequired('general'),
            publish: authService.isAuthRequired('publish'),
            admin: authService.isAuthRequired('admin'),
          },
          currentUser: currentUser,
        };

        return reply.send(response);
      } catch (error) {
        logger.error(`Error in /api/ui/config: ${error}`);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // POST /api/ui/users - User management (admin permission required)
  fastify.post(
    '/users',
    {
      preHandler: [sessionOnlyAuth],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedFastifyRequest;
      try {
        // All user management operations require admin role
        const roleCheck = requireRole(authRequest, reply, ['admin']);
        if (roleCheck) return roleCheck;

        const body = request.body as UserManagementRequest;

        switch (body.action) {
          case 'list': {
            const users = await userService.getAllUsers();

            const response: UserListResponse = {
              users: users.map((user) => ({
                id: user.id,
                username: user.username,
                role: user.role,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
              })),
            };

            return reply.send(response);
          }

          case 'create': {
            if (!body.username || !body.password || !body.role) {
              return reply
                .status(400)
                .send({ error: 'Username, password, and role are required' });
            }

            logger.info(
              `Creating new user: ${body.username} with role: ${body.role}`
            );

            const user = await userService.createUser({
              username: body.username,
              password: body.password,
              role: body.role,
            });

            logger.info(`User ${body.username} created successfully`);

            const response: UserCreateResponse = {
              user: {
                id: user.id,
                username: user.username,
                role: user.role,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
              },
            };

            return reply.status(201).send(response);
          }

          case 'delete': {
            if (!body.username) {
              return reply.status(400).send({ error: 'Username is required' });
            }

            logger.info(`Deleting user: ${body.username}`);

            const deleted = await userService.deleteUser(body.username);
            if (!deleted) {
              return reply.status(404).send({ error: 'User not found' });
            }

            logger.info(`User ${body.username} deleted successfully`);

            const response: UserDeleteResponse = {
              success: true,
              message: 'User deleted successfully',
            };

            return reply.send(response);
          }

          case 'update': {
            if (!body.username || !body.password) {
              return reply
                .status(400)
                .send({ error: 'Username and password are required' });
            }

            // Prevent users from changing their own password via this endpoint
            // Users should use the separate password change endpoint
            if (
              authRequest.user &&
              authRequest.user.username === body.username
            ) {
              return reply.status(403).send({
                error: 'Cannot change your own password via this endpoint',
              });
            }

            logger.info(`Updating password for user: ${body.username}`);

            const updatedUser = await userService.updateUser(body.username, {
              password: body.password,
            });
            if (!updatedUser) {
              return reply.status(404).send({ error: 'User not found' });
            }

            logger.info(`Password updated for user: ${body.username}`);

            const response = {
              success: true,
              message: 'Password updated successfully',
            };

            return reply.send(response);
          }

          default:
            return reply
              .status(400)
              .send({ error: `Unknown action: ${body.action}` });
        }
      } catch (error: any) {
        if (error.statusCode) {
          throw error; // Re-throw HTTP errors
        }
        logger.error(`Error in /api/ui/users: ${error}`);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // POST /api/ui/tokens - List and revoke npm tokens (session auth required)
  fastify.post(
    '/tokens',
    {
      preHandler: [sessionOnlyAuth],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedFastifyRequest;
      try {
        const body = request.body as {
          action: 'list' | 'delete';
          key?: string;
        };
        const username = authRequest.user?.username;
        if (!username) {
          return reply.status(401).send({ error: 'User not authenticated' });
        }

        switch (body.action) {
          case 'list': {
            const result = await userService.listNpmTokens(username);
            if (!result) {
              return reply.status(404).send({ error: 'User not found' });
            }
            return reply.send(result);
          }

          case 'delete': {
            if (!body.key) {
              return reply.status(400).send({ error: 'Token key is required' });
            }
            const result = await userService.deleteNpmToken(username, body.key);
            if (!result.success) {
              return reply.status(404).send({ error: result.message });
            }
            return reply.send(result);
          }

          default:
            return reply
              .status(400)
              .send({ error: `Unknown action: ${body.action}` });
        }
      } catch (error: any) {
        if (error.statusCode) {
          throw error;
        }
        logger.error(`Error in /api/ui/tokens: ${error}`);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // POST /api/ui/password - Change password (session auth required)
  fastify.post(
    '/password',
    {
      preHandler: [sessionOnlyAuth],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedFastifyRequest;
      try {
        const body = request.body as PasswordChangeRequest;

        if (!body.newPassword) {
          return reply.status(400).send({ error: 'New password is required' });
        }

        if (body.username) {
          // Admin changing another user's password
          const roleCheck = requireRole(authRequest, reply, ['admin']);
          if (roleCheck) return roleCheck;

          logger.info(
            `Admin ${authRequest.user?.username} changing password for user: ${body.username}`
          );

          const updated = await userService.updateUser(body.username, {
            password: body.newPassword,
          });
          if (!updated) {
            return reply.status(404).send({ error: 'User not found' });
          }

          logger.info(
            `Password changed successfully for user: ${body.username}`
          );
        } else {
          // User changing their own password
          if (!body.currentPassword) {
            return reply.status(400).send({
              error: 'Current password is required for self password change',
            });
          }

          // Validate current password
          const user = await userService.validateCredentials(
            authRequest.user?.username || '',
            body.currentPassword
          );
          if (!user) {
            return reply
              .status(401)
              .send({ error: 'Current password is incorrect' });
          }

          logger.info(
            `User ${authRequest.user?.username} changing their own password`
          );

          const updated = await userService.updateUser(
            authRequest.user?.username || '',
            {
              password: body.newPassword,
            }
          );
          if (!updated) {
            return reply.status(404).send({ error: 'User not found' });
          }

          logger.info(
            `Password changed successfully for user: ${authRequest.user?.username}`
          );
        }

        const response: PasswordChangeResponse = {
          success: true,
          message: 'Password updated successfully',
        };

        return reply.send(response);
      } catch (error: any) {
        if (error.statusCode) {
          throw error; // Re-throw HTTP errors
        }
        logger.error(`Error in /api/ui/password: ${error}`);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // POST /api/ui/packages - npm package list for the UI
  fastify.post(
    '/packages',
    {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        if (authService.getAuthMode() === 'full') {
          return sessionOnlyAuth(request, reply);
        }
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = (request.body ?? {}) as {
          q?: string;
          skip?: number;
          take?: number;
        };
        const q = String(body.q ?? '').toLowerCase();
        const skip = Number.isFinite(body.skip) ? Number(body.skip) : 0;
        const take = Number.isFinite(body.take) ? Number(body.take) : 20;

        const allPackages = metadataService
          .getAllPackageIds()
          .map((packageName) => {
            const versions = metadataService.getPackageMetadata(packageName);
            const latest = versions[0];
            if (!latest) {
              return undefined;
            }
            return { latest, versions };
          })
          .filter(
            (
              entry
            ): entry is {
              latest: ReturnType<
                typeof metadataService.getPackageMetadata
              >[number];
              versions: ReturnType<typeof metadataService.getPackageMetadata>;
            } => entry !== undefined
          )
          .filter(({ latest }) => {
            if (!q) {
              return true;
            }
            return (
              latest.name.toLowerCase().includes(q) ||
              String(latest.manifest.description ?? '')
                .toLowerCase()
                .includes(q) ||
              (latest.manifest.keywords ?? []).some((keyword) =>
                keyword.toLowerCase().includes(q)
              )
            );
          })
          .sort((a, b) =>
            a.latest.name.localeCompare(b.latest.name, undefined, {
              sensitivity: 'base',
            })
          );

        const response: PackageListResponse = {
          totalHits: allPackages.length,
          data: allPackages
            .slice(skip, skip + take)
            .map(({ latest, versions }) => ({
              name: latest.name,
              description: latest.manifest.description ?? '',
              keywords: latest.manifest.keywords ?? [],
              license:
                typeof latest.manifest.license === 'string'
                  ? latest.manifest.license
                  : undefined,
              repository: latest.manifest.repository,
              homepage: latest.manifest.homepage,
              dependencies: latest.manifest.dependencies ?? {},
              devDependencies: latest.manifest.devDependencies ?? {},
              peerDependencies: latest.manifest.peerDependencies ?? {},
              versions: versions.map((version) => ({
                version: version.version,
                tarball: version.tarballUrl,
              })),
            })),
        };

        return reply.send(response);
      } catch (error) {
        logger.error(`Error in /api/ui/packages: ${error}`);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // GET /api/ui/icon/{id}/{version} - Package icon (auth requirements based on authMode)
  fastify.get(
    '/icon/:id/:version',
    {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        const authMode = authService.getAuthMode();
        if (authMode === 'full') {
          // For full auth mode, require session authentication
          return sessionOnlyAuth(request, reply);
        }
        // For 'none' and 'publish' modes, no authentication required
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id: packageId, version } = request.params as {
        id: string;
        version: string;
      };

      try {
        logger.info(`Serving icon for package: ${packageId} ${version}`);

        // Try to get icon from package metadata or storage
        const lowerVersion = version.toLowerCase();

        // Look for icon file in package directory (preserve original packageId case)
        const packageDir = join(packagesRoot, packageId, lowerVersion);
        const iconExtensions = ['png', 'jpg', 'jpeg', 'gif', 'svg'];

        for (const ext of iconExtensions) {
          try {
            const iconPath = join(packageDir, `icon.${ext}`);
            await fs.access(iconPath); // Check if file exists

            // Use streamFile with appropriate content type and cache control
            const contentType =
              ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
            logger.info(`Icon served successfully: ${packageId} ${version}`);

            await streamFile(
              logger,
              locker,
              iconPath,
              reply,
              {
                contentType,
                cacheControl: 'public, max-age=3600',
              },
              request.abortSignal
            );
            return;
          } catch (error: any) {
            // Continue to next extension
          }
        }

        // Icon not found in specified version, try latest version as fallback
        logger.info(
          `Icon not found in version ${version}, trying latest version for package: ${packageId}`
        );

        const latestEntry = metadataService.getLatestPackageEntry(packageId);
        if (latestEntry && latestEntry.metadata.version !== version) {
          logger.info(
            `Trying fallback to latest version: ${latestEntry.metadata.version}`
          );

          const latestPackageDir = join(
            packagesRoot,
            ...latestEntry.storage.packagePathSegments,
            latestEntry.metadata.version
          );

          for (const ext of iconExtensions) {
            try {
              const iconPath = join(latestPackageDir, `icon.${ext}`);
              await fs.access(iconPath); // Check if file exists

              // Use streamFile with appropriate content type and cache control
              const contentType =
                ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
              logger.info(
                `Icon served from latest version: ${packageId} ${latestEntry.metadata.version} (requested: ${version})`
              );

              await streamFile(
                logger,
                locker,
                iconPath,
                reply,
                {
                  contentType,
                  cacheControl: 'public, max-age=3600',
                },
                request.abortSignal
              );
              return;
            } catch (error: any) {
              // Continue to next extension
            }
          }
        }

        // Icon not found in both specified version and latest version
        logger.warn(
          `Icon not found for package: ${packageId} ${version} (also checked latest version)`
        );
        return reply.status(404).send({ error: 'Icon not found' });
      } catch (error) {
        logger.error(
          `Error serving icon for ${packageId} ${version}: ${error}`
        );
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  logger.info('UI Backend API routes registered successfully');
};
