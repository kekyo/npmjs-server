// npmjs-server - NPM package registry on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { FastifyRequest, FastifyReply } from 'fastify';
import { Strategy as LocalStrategy } from 'passport-local';
import { Logger } from '../types';
import { UserService } from '../services/userService';
import { SessionService } from '../services/sessionService';
import { AuthFailureTracker } from '../services/authFailureTracker';

/**
 * Fastify authentication middleware configuration
 */
export interface FastifyAuthConfig {
  realm?: string;
  userService: UserService;
  sessionService: SessionService;
  authFailureTracker?: AuthFailureTracker;
  logger: Logger;
}

/**
 * Extended Fastify request interface with user information
 */
export interface AuthenticatedFastifyRequest extends FastifyRequest {
  user?: {
    username: string;
    role: string;
  };
}

/**
 * Creates Passport.js Local Strategy for UI authentication
 * @param config - Authentication configuration
 * @returns Local strategy instance
 */
export const createLocalStrategy = (
  config: FastifyAuthConfig
): LocalStrategy => {
  const { userService, logger } = config;

  return new LocalStrategy(
    {
      usernameField: 'username',
      passwordField: 'password',
    },
    async (username: string, password: string, done) => {
      try {
        logger.debug(`Local strategy authenticating user: ${username}`);

        const user = await userService.validateCredentials(username, password);
        if (!user) {
          logger.warn(`Local authentication failed for user: ${username}`);
          return done(null, false, { message: 'Invalid credentials' });
        }

        logger.debug(`Local authentication successful for user: ${username}`);
        return done(null, {
          id: user.id,
          username: user.username,
          role: user.role,
        });
      } catch (error) {
        logger.error(`Local strategy error: ${error}`);
        return done(error);
      }
    }
  );
};

/**
 * Creates hybrid authentication middleware for npm registry APIs.
 * Supports UI sessions and npm Bearer tokens.
 * @param config - Authentication configuration
 * @returns Fastify hook function
 */
export const createNpmHybridAuthMiddleware = (config: FastifyAuthConfig) => {
  const { userService, sessionService, authFailureTracker, logger } = config;

  return async (request: AuthenticatedFastifyRequest, reply: FastifyReply) => {
    logger.debug(`npm auth check for ${request.method} ${request.url}`);

    try {
      const sessionToken = request.cookies?.sessionToken;
      if (sessionToken) {
        const session = await sessionService.validateSession(sessionToken);
        if (session) {
          request.user = {
            username: session.username,
            role: session.role,
          };
          return;
        }
      }

      const authHeader = request.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring('Bearer '.length).trim();
        const user = await userService.validateNpmToken(token);
        if (user) {
          if (authFailureTracker) {
            authFailureTracker.clearFailures(request, user.username);
          }
          request.user = {
            username: user.username,
            role: user.role,
          };
          return;
        }

        if (authFailureTracker) {
          authFailureTracker.recordFailure(request);
          await authFailureTracker.applyDelay(request);
        }
      }

      return reply.status(401).send({
        error: 'Authentication required',
        reason: 'Bearer token is required',
      });
    } catch (error) {
      logger.error(`npm auth error: ${error}`);
      return reply.status(500).send({
        error: 'Authentication error',
        message: 'Internal server error during authentication',
      });
    }
  };
};

/**
 * Creates Session-only authentication middleware (for UI APIs)
 * @param config - Authentication configuration
 * @returns Fastify hook function
 */
export const createSessionOnlyAuthMiddleware = (config: FastifyAuthConfig) => {
  const { sessionService, logger } = config;

  return async (request: AuthenticatedFastifyRequest, reply: FastifyReply) => {
    logger.debug(
      `Session-only auth check for ${request.method} ${request.url}`
    );

    try {
      // Check session authentication only
      const sessionToken = request.cookies?.sessionToken;
      if (!sessionToken) {
        logger.debug('No session token found');
        return reply.status(401).send({
          error: 'Session authentication required',
          message: 'Please log in to access this resource',
        });
      }

      const session = await sessionService.validateSession(sessionToken);
      if (!session) {
        logger.debug('Invalid or expired session token');
        // Clear invalid session cookie
        reply.clearCookie('sessionToken', {
          httpOnly: true,
          secure: request.protocol === 'https',
          sameSite: 'strict' as const,
          path: '/',
        });

        return reply.status(401).send({
          error: 'Invalid or expired session',
          message: 'Please log in again',
        });
      }

      logger.debug(`Session auth successful for user: ${session.username}`);
      request.user = {
        username: session.username,
        role: session.role,
      };
    } catch (error) {
      logger.error(`Session auth error: ${error}`);
      return reply.status(500).send({
        error: 'Authentication error',
        message: 'Internal server error during authentication',
      });
    }
  };
};

/**
 * Creates a role-based authorization middleware
 * @param requiredRoles - Array of required roles (user must have at least one)
 * @param logger - Logger instance
 * @returns Fastify hook function
 */
export const createRoleAuthorizationMiddleware = (
  requiredRoles: string[],
  logger: Logger
) => {
  return async (request: AuthenticatedFastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      logger.warn(`Authorization failed - no user information in request`);
      return reply.status(401).send({
        error: 'Authentication required',
        message: 'User must be authenticated',
      });
    }

    const userRole = request.user.role;
    const hasRequiredRole =
      requiredRoles.includes(userRole) ||
      (requiredRoles.includes('read') &&
        ['publish', 'admin'].includes(userRole)) ||
      (requiredRoles.includes('publish') && userRole === 'admin');

    if (!hasRequiredRole) {
      logger.warn(
        `Authorization failed for user: ${request.user.username} (role: ${userRole}, required: ${requiredRoles.join(', ')})`
      );
      return reply.status(403).send({
        error: 'Insufficient permissions',
        message: `Required role: ${requiredRoles.join(' or ')}`,
      });
    }

    logger.debug(
      `Authorization successful for user: ${request.user.username} (role: ${userRole})`
    );
  };
};

/**
 * Helper function to check if user has required role
 * @param request - Authenticated Fastify request
 * @param roles - Required roles
 * @returns True if user has required role
 */
export const requireRole = (
  request: AuthenticatedFastifyRequest,
  roles: string[]
): boolean => {
  if (!request.user) {
    return false;
  }

  const userRole = request.user.role;
  return (
    roles.includes(userRole) ||
    (roles.includes('read') && ['publish', 'admin'].includes(userRole)) ||
    (roles.includes('publish') && userRole === 'admin')
  );
};
