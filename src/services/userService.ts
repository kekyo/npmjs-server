// npmjs-server - NPM package registry on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { constants } from 'fs';
import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { createReaderWriterLock } from 'async-primitives';
import { Logger, ServerConfig } from '../types';
import { writePrivateFile } from '../utils/atomicFile';
import {
  generateSalt,
  hashPassword,
  verifyPassword,
  generateNpmToken,
  generateNpmTokenKey,
  generateUserId,
} from '../utils/crypto';
import {
  checkPasswordStrength,
  getMinPasswordScore,
} from '../utils/passwordStrength';

/**
 * npm bearer token data structure.
 */
export interface NpmToken {
  key: string;
  label: string;
  tokenHash: string;
  salt: string;
  createdAt: string;
  lastUsedAt?: string;
}

/**
 * User data structure
 */
export interface User {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  npmTokens?: NpmToken[];
  role: 'read' | 'publish' | 'admin';
  createdAt: string;
  updatedAt: string;
  /** Revision used to invalidate sessions and pending authentication. */
  authVersion?: number;
  /** Confirmed second factor; omitted until registration is complete. */
  totp?: TotpCredentials;
}

/** Persisted credentials for an enrolled TOTP authenticator. */
export interface TotpCredentials {
  /** AES-256-GCM envelope containing the authenticator secret. */
  encryptedSecret: string;
  /** Most recently accepted time step, including enrollment confirmation. */
  lastUsedStep: number;
  /** SHA-256 hashes of unused, high-entropy recovery codes. */
  recoveryCodeHashes: string[];
  /** ISO timestamp of the latest enrollment. */
  enabledAt: string;
}

/**
 * User creation request
 */
export interface CreateUserRequest {
  username: string;
  password: string;
  role: 'read' | 'publish' | 'admin';
}

/**
 * npm token list response.
 */
export interface NpmTokenListResponse {
  npmTokens: Array<{
    key: string;
    label: string;
    createdAt: string;
    lastUsedAt?: string;
  }>;
}

/**
 * npm token add response.
 */
export interface NpmTokenAddResponse {
  key: string;
  label: string;
  token: string;
  createdAt: string;
}

/**
 * npm token delete response.
 */
export interface NpmTokenDeleteResponse {
  success: boolean;
  message: string;
}

/**
 * User service configuration
 */
export interface UserServiceConfig {
  configDir: string;
  usersFile?: string; // Optional custom path to users.json file
  logger: Logger;
  serverConfig?: ServerConfig;
}

/**
 * User service interface for managing JSON-based user data
 */
export interface UserService {
  /**
   * Updates second-factor state under the account writer lock.
   * @param username Account to update.
   * @param authVersion Expected credential revision.
   * @param mutation Pure synchronous update; throwing leaves storage unchanged.
   * @param invalidateSessions Whether to advance the credential revision.
   * @returns Updated account, or undefined if the account/revision changed.
   */
  readonly mutateTotp: (
    username: string,
    authVersion: number,
    mutation: (
      credentials: TotpCredentials | undefined
    ) => TotpCredentials | undefined,
    invalidateSessions: boolean
  ) => Promise<User | undefined>;
  readonly initialize: () => Promise<void>;
  readonly destroy: () => void;
  readonly createUser: (request: CreateUserRequest) => Promise<User>;
  readonly getUser: (username: string) => Promise<User | undefined>;
  readonly getAllUsers: () => Promise<User[]>;
  readonly updateUser: (
    username: string,
    updates: Partial<Pick<User, 'role'>> | { password: string }
  ) => Promise<User | undefined>;
  readonly deleteUser: (username: string) => Promise<boolean>;
  readonly validateCredentials: (
    username: string,
    password: string
  ) => Promise<User | undefined>;
  readonly getUserCount: () => Promise<number>;
  readonly isReady: () => boolean;
  readonly listNpmTokens: (
    username: string
  ) => Promise<NpmTokenListResponse | undefined>;
  readonly addNpmToken: (
    username: string,
    label: string
  ) => Promise<NpmTokenAddResponse | undefined>;
  readonly deleteNpmToken: (
    username: string,
    key: string
  ) => Promise<NpmTokenDeleteResponse>;
  readonly validateNpmToken: (token: string) => Promise<User | undefined>;
}

/**
 * Creates a user service instance for managing JSON-based user data
 * @param config - User service configuration
 * @returns User service instance
 */
export const createUserService = (config: UserServiceConfig): UserService => {
  const { configDir, usersFile, logger, serverConfig } = config;
  // Use custom users file path if provided, otherwise default to configDir/users.json
  const usersFilePath = usersFile || join(configDir, 'users.json');
  let users: Map<string, User> = new Map();
  let isInitialized = false;
  const fileLock = createReaderWriterLock();

  /**
   * Loads users from the JSON file with exclusive lock
   */
  const loadUsers = async (): Promise<void> => {
    const handle = await fileLock.readLock();
    try {
      // Check if file exists
      await access(usersFilePath, constants.R_OK);

      // Read and parse file
      const content = await readFile(usersFilePath, 'utf-8');
      const usersArray: User[] = JSON.parse(content);

      users.clear();
      for (const user of usersArray) {
        users.set(user.username, user);
      }

      logger.info(`Loaded ${usersArray.length} users from ${usersFilePath}`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        logger.info(
          `${usersFilePath} not found - starting with empty user database`
        );
        users.clear();
      } else {
        logger.error(`Failed to load ${usersFilePath}: ${error.message}`);
        throw error;
      }
    } finally {
      handle.release();
    }
  };

  /**
   * Internal save function (called from within lock)
   */
  const saveUsersInternal = async (): Promise<void> => {
    try {
      const usersArray = Array.from(users.values());
      const content = JSON.stringify(usersArray, null, 2);
      await writePrivateFile(usersFilePath, content);
      logger.debug(`Saved ${usersArray.length} users to ${usersFilePath}`);
    } catch (error: any) {
      logger.error(`Failed to save ${usersFilePath}: ${error.message}`);
      throw error;
    }
  };

  const cloneUser = (user: User): User => ({
    ...user,
    totp: user.totp
      ? { ...user.totp, recoveryCodeHashes: [...user.totp.recoveryCodeHashes] }
      : undefined,
    npmTokens: user.npmTokens?.map((npmToken) => ({
      ...npmToken,
    })),
  });

  const cloneUsers = (sourceUsers: Map<string, User>): Map<string, User> =>
    new Map<string, User>(
      Array.from(sourceUsers.entries(), ([username, user]): [string, User] => [
        username,
        cloneUser(user),
      ])
    );

  /**
   * Keeps the in-memory user state consistent with users.json by rolling back
   * changes when persisting the updated content fails.
   */
  const persistUsersMutation = async <T>(
    mutation: () => Promise<T> | T
  ): Promise<T> => {
    const previousUsers = cloneUsers(users);

    try {
      const result = await mutation();
      await saveUsersInternal();
      return result;
    } catch (error) {
      users = previousUsers;
      throw error;
    }
  };

  /**
   * Validates username format and uniqueness
   */
  const validateUsername = (
    username: string,
    excludeExisting = false
  ): void => {
    if (!username || username.trim().length === 0) {
      throw new Error('Username cannot be empty');
    }

    if (username.length > 50) {
      throw new Error('Username cannot exceed 50 characters');
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      throw new Error(
        'Username can only contain letters, numbers, dots, underscores, and hyphens'
      );
    }

    if (!excludeExisting && users.has(username)) {
      throw new Error('Username already exists');
    }
  };

  /**
   * Validates password strength
   */
  const validatePassword = (password: string, username?: string): void => {
    if (!password || password.length === 0) {
      throw new Error('Password cannot be empty');
    }

    // Minimum length check (for backward compatibility)
    if (password.length < 4) {
      throw new Error('Password must be at least 4 characters long');
    }

    // Strength check (can be disabled via config)
    if (serverConfig?.passwordStrengthCheck !== false) {
      const userInputs = username ? [username] : [];
      const strengthResult = checkPasswordStrength(password, userInputs);
      const minScore = getMinPasswordScore(serverConfig);

      if (strengthResult.score < minScore) {
        const strengthLabel = ['Weak', 'Fair', 'Good', 'Strong', 'Very Strong'][
          minScore
        ];
        throw new Error(
          `Password strength is too weak. Minimum required: ${strengthLabel}. ` +
            (strengthResult.feedback.warning ||
              strengthResult.feedback.suggestions[0] ||
              '')
        );
      }
    }
  };

  /**
   * Validates role
   */
  const validateRole = (role: string): void => {
    if (!['read', 'publish', 'admin'].includes(role)) {
      throw new Error('Role must be one of: read, publish, admin');
    }
  };

  const service: UserService = {
    mutateTotp: async (username, authVersion, mutation, invalidateSessions) => {
      const handle = await fileLock.writeLock();
      try {
        const user = users.get(username);
        if (!user || (user.authVersion ?? 0) !== authVersion) return undefined;
        await persistUsersMutation(() => {
          user.totp = mutation(cloneUser(user).totp);
          if (invalidateSessions) user.authVersion = authVersion + 1;
          user.updatedAt = new Date().toISOString();
        });
        return cloneUser(user);
      } finally {
        handle.release();
      }
    },
    /**
     * Initializes the user service and loads user data
     */
    initialize: async (): Promise<void> => {
      if (isInitialized) {
        return;
      }

      const startTime = Date.now();
      logger.info(
        `Initializing user service with config directory: ${configDir}`
      );

      await loadUsers();

      isInitialized = true;
      const duration = Date.now() - startTime;
      logger.info(`User service initialization completed in ${duration}ms`);
    },

    /**
     * Destroys the user service and cleans up resources
     */
    destroy: (): void => {
      users.clear();
      isInitialized = false;
    },

    /**
     * Creates a new user
     * @param request - User creation request
     * @returns Created user
     */
    createUser: async (request: CreateUserRequest): Promise<User> => {
      const handle = await fileLock.writeLock();
      try {
        const user = await persistUsersMutation(() => {
          validateUsername(request.username);
          validatePassword(request.password, request.username);
          validateRole(request.role);

          // Generate salts and hashes
          const passwordSalt = generateSalt();
          const passwordHash = hashPassword(request.password, passwordSalt);

          const now = new Date().toISOString();
          const createdUser: User = {
            id: generateUserId(),
            username: request.username,
            passwordHash,
            salt: passwordSalt,
            npmTokens: [],
            role: request.role,
            createdAt: now,
            updatedAt: now,
          };

          users.set(request.username, createdUser);

          return createdUser;
        });

        logger.info(
          `Created user: ${request.username} with role: ${request.role}`
        );

        return user;
      } finally {
        handle.release();
      }
    },

    /**
     * Gets a user by username
     * @param username - Username to look up
     * @returns User data or undefined if not found
     */
    getUser: async (username: string): Promise<User | undefined> => {
      const handle = await fileLock.readLock();
      try {
        const user = users.get(username);
        return user ? cloneUser(user) : undefined;
      } finally {
        handle.release();
      }
    },

    /**
     * Gets all users
     * @returns Array of all users
     */
    getAllUsers: async (): Promise<User[]> => {
      const handle = await fileLock.readLock();
      try {
        return Array.from(users.values(), cloneUser);
      } finally {
        handle.release();
      }
    },

    /**
     * Updates user properties
     * @param username - Username to update
     * @param updates - Properties to update
     * @returns Updated user or undefined if not found
     */
    updateUser: async (
      username: string,
      updates: Partial<Pick<User, 'role'>> | { password: string }
    ): Promise<User | undefined> => {
      const handle = await fileLock.writeLock();
      try {
        const user = users.get(username);
        if (!user) {
          return undefined;
        }

        const updatedUser = await persistUsersMutation(() => {
          if ('role' in updates && updates.role) {
            validateRole(updates.role);
            user.role = updates.role;
          }

          if ('password' in updates && updates.password) {
            validatePassword(updates.password, username);
            const newPasswordSalt = generateSalt();
            const newPasswordHash = hashPassword(
              updates.password,
              newPasswordSalt
            );
            user.passwordHash = newPasswordHash;
            user.salt = newPasswordSalt;
          }

          user.updatedAt = new Date().toISOString();
          user.authVersion = (user.authVersion ?? 0) + 1;
          return user;
        });

        logger.info(`Updated user: ${username}`);
        return updatedUser;
      } finally {
        handle.release();
      }
    },

    /**
     * Deletes a user
     * @param username - Username to delete
     * @returns True if user was deleted, false if not found
     */
    deleteUser: async (username: string): Promise<boolean> => {
      const handle = await fileLock.writeLock();
      try {
        if (!users.has(username)) {
          return false;
        }

        await persistUsersMutation(() => {
          users.delete(username);
          return true;
        });
        logger.info(`Deleted user: ${username}`);

        return true;
      } finally {
        handle.release();
      }
    },

    /**
     * Validates user credentials for UI login
     * @param username - Username
     * @param password - Password
     * @returns User data if valid, undefined otherwise
     */
    validateCredentials: async (
      username: string,
      password: string
    ): Promise<User | undefined> => {
      const user = await service.getUser(username);
      if (!user) {
        return undefined;
      }

      const isValid = verifyPassword(password, user.passwordHash, user.salt);
      return isValid ? user : undefined;
    },

    /**
     * Gets the total number of users
     * @returns User count
     */
    getUserCount: async (): Promise<number> => {
      return users.size;
    },

    /**
     * Checks if the service is ready
     * @returns True if initialized
     */
    isReady: (): boolean => {
      return isInitialized;
    },

    /**
     * Lists all npm bearer tokens for a user.
     * @param username - Username
     * @returns npm token list or undefined if user not found
     */
    listNpmTokens: async (
      username: string
    ): Promise<NpmTokenListResponse | undefined> => {
      const user = users.get(username);
      if (!user) {
        return undefined;
      }

      const npmTokens = [...(user.npmTokens ?? [])].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      return {
        npmTokens: npmTokens.map((token) => ({
          key: token.key,
          label: token.label,
          createdAt: token.createdAt,
          lastUsedAt: token.lastUsedAt,
        })),
      };
    },

    /**
     * Adds a new npm bearer token for a user.
     * @param username - Username
     * @param label - Token label
     * @returns Created token or undefined if user not found
     */
    addNpmToken: async (
      username: string,
      label: string
    ): Promise<NpmTokenAddResponse | undefined> => {
      const handle = await fileLock.writeLock();
      try {
        const user = users.get(username);
        if (!user) {
          return undefined;
        }

        if (!label || label.trim().length === 0) {
          throw new Error('Token label cannot be empty');
        }

        if (label.length > 80) {
          throw new Error('Token label cannot exceed 80 characters');
        }

        const result = await persistUsersMutation(() => {
          if (!user.npmTokens) {
            user.npmTokens = [];
          }

          if (user.npmTokens.length >= 50) {
            throw new Error('Maximum of 50 npm tokens allowed per user');
          }

          const token = generateNpmToken();
          const salt = generateSalt();
          const tokenHash = hashPassword(token, salt);
          const now = new Date().toISOString();
          const key = generateNpmTokenKey();

          user.npmTokens.push({
            key,
            label,
            tokenHash,
            salt,
            createdAt: now,
          });
          user.updatedAt = now;

          return {
            key,
            label,
            token,
            createdAt: now,
          };
        });

        logger.info(`Added npm token "${label}" for user: ${username}`);
        return result;
      } finally {
        handle.release();
      }
    },

    /**
     * Deletes an npm bearer token by key.
     * @param username - Username
     * @param key - Token key
     * @returns Delete response
     */
    deleteNpmToken: async (
      username: string,
      key: string
    ): Promise<NpmTokenDeleteResponse> => {
      const handle = await fileLock.writeLock();
      try {
        const user = users.get(username);
        if (!user) {
          return {
            success: false,
            message: 'User not found',
          };
        }

        const currentTokens = user.npmTokens ?? [];
        if (!currentTokens.some((token) => token.key === key)) {
          return {
            success: false,
            message: `npm token "${key}" not found`,
          };
        }

        const result = await persistUsersMutation(() => {
          user.npmTokens = currentTokens.filter((token) => token.key !== key);
          user.updatedAt = new Date().toISOString();
          return {
            success: true,
            message: `npm token "${key}" deleted successfully`,
          };
        });

        logger.info(`Deleted npm token "${key}" for user: ${username}`);
        return result;
      } finally {
        handle.release();
      }
    },

    /**
     * Validates a bearer token across all users.
     * @param token - Bearer token
     * @returns User data if valid, undefined otherwise
     */
    validateNpmToken: async (token: string): Promise<User | undefined> => {
      if (!token) {
        return undefined;
      }

      const handle = await fileLock.writeLock();
      try {
        for (const user of users.values()) {
          for (const npmToken of user.npmTokens ?? []) {
            if (verifyPassword(token, npmToken.tokenHash, npmToken.salt)) {
              await persistUsersMutation(() => {
                npmToken.lastUsedAt = new Date().toISOString();
                user.updatedAt = npmToken.lastUsedAt;
                return undefined;
              });
              return user;
            }
          }
        }

        return undefined;
      } finally {
        handle.release();
      }
    },
  };

  return service;
};
