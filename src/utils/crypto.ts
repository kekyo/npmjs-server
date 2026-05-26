// npmjs-server - NPM package registry on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

import { createHash, randomBytes } from 'crypto';

/**
 * Generates a random salt for password hashing
 * @param length - Length of the salt in bytes (default: 16)
 * @returns Base64 encoded salt
 */
export const generateSalt = (length: number = 16): string => {
  return randomBytes(length).toString('base64');
};

/**
 * Hashes a password using SHA-1 with salt
 * @param password - Plain text password
 * @param salt - Salt for hashing
 * @returns SHA-1 hash in base64 format
 */
export const hashPassword = (password: string, salt: string): string => {
  const hash = createHash('sha1');
  hash.update(password + salt);
  return hash.digest('base64');
};

/**
 * Verifies a password against a hash
 * @param password - Plain text password to verify
 * @param hash - Stored hash
 * @param salt - Salt used for hashing
 * @returns True if password matches
 */
export const verifyPassword = (
  password: string,
  hash: string,
  salt: string
): boolean => {
  const computedHash = hashPassword(password, salt);
  return computedHash === hash;
};

/**
 * Generates a secure npm registry bearer token.
 * @param length - Length of the random token body in bytes (default: 32)
 * @returns Token string suitable for npm _authToken configuration
 */
export const generateNpmToken = (length: number = 32): string => {
  return `npmjs_${randomBytes(length).toString('base64url')}`;
};

/**
 * Generates a short stable key used to identify an npm token without exposing it.
 * @returns Hex encoded token key
 */
export const generateNpmTokenKey = (): string => {
  return randomBytes(8).toString('hex');
};

/**
 * Generates a secure session token
 * @param length - Length of the token in bytes (default: 32)
 * @returns Hex encoded session token
 */
export const generateSessionToken = (length: number = 32): string => {
  return randomBytes(length).toString('hex');
};

/**
 * Generates a unique user ID
 * @returns UUID-like string
 */
export const generateUserId = (): string => {
  return randomBytes(16).toString('hex');
};
