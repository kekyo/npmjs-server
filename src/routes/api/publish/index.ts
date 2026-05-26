// npmjs-server - NPM package registry server on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Logger, DuplicatePackagePolicy } from '../../../types';
import { AuthService } from '../../../services/authService';
import { MetadataService } from '../../../services/metadataService';
import { publishNpmTarball } from '../../../services/npmPublishService';
import {
  createNpmHybridAuthMiddleware,
  FastifyAuthConfig,
  AuthenticatedFastifyRequest,
} from '../../../middleware/fastifyAuth';
import { createUrlResolver } from '../../../utils/urlResolver';

/**
 * Configuration for UI package publish routes.
 */
export interface PublishRoutesConfig {
  packagesRoot: string;
  metadataService: MetadataService;
  authService: AuthService;
  authConfig: FastifyAuthConfig;
  logger: Logger;
  urlResolver: ReturnType<typeof createUrlResolver>;
  duplicatePackagePolicy?: DuplicatePackagePolicy;
}

/**
 * Publish response interface.
 */
export interface PublishResponse {
  message: string;
  id: string;
  version: string;
}

/**
 * Registers package publish API routes with Fastify instance.
 */
export const registerPublishRoutes = async (
  fastify: FastifyInstance,
  config: PublishRoutesConfig
) => {
  const {
    packagesRoot,
    metadataService,
    authService,
    authConfig,
    logger,
    urlResolver,
    duplicatePackagePolicy = 'error',
  } = config;

  const authHandler =
    authService.getAuthMode() === 'none'
      ? undefined
      : createNpmHybridAuthMiddleware(authConfig);

  fastify.post(
    '/publish',
    {
      preHandler: (authHandler
        ? [
            authHandler,
            async (request: FastifyRequest, reply: FastifyReply) => {
              const authRequest = request as AuthenticatedFastifyRequest;
              if (
                !authRequest.user ||
                !['publish', 'admin'].includes(authRequest.user.role)
              ) {
                return reply
                  .status(403)
                  .send({ error: 'Publish permission required' });
              }
            },
          ]
        : []) as any,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const packageData = request.body as Buffer;
        if (!packageData || packageData.length === 0) {
          return reply.status(400).send({ error: 'No package data received' });
        }

        const baseUrl = urlResolver.resolveUrl(request).baseUrl;
        const result = await publishNpmTarball({
          packagesRoot,
          metadataService,
          tarball: packageData,
          baseUrl,
          logger,
          policy: duplicatePackagePolicy,
          signal: request.abortSignal,
        });

        if (result.action === 'error') {
          return reply.status(409).send({ error: result.message });
        }
        if (result.action === 'ignored') {
          return reply.status(200).send({
            message: result.message,
            id: result.name,
            version: result.version,
          } satisfies PublishResponse);
        }

        return reply.status(201).send({
          message: result.message,
          id: result.name,
          version: result.version,
        } satisfies PublishResponse);
      } catch (error) {
        logger.error(`Package upload error: ${error}`);
        return reply.status(400).send({
          error: error instanceof Error ? error.message : 'Invalid package',
        });
      }
    }
  );

  logger.info('npm package publish API routes registered successfully');
};
