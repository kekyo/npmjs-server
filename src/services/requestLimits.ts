// npmjs-server - NPM package registry on Node.js
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// License under MIT.

/** Maximum requests to each login route per client IP in one minute. */
export const loginRateLimit = { max: 20 };

/** Public UI reads allow bursts when a registry lists many package icons. */
export const publicReadRateLimit = { max: 600 };
