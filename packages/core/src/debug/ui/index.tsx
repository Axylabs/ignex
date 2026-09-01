/**
 * @fileoverview Debugbar SPA entry — boots the application shell. The bundle
 * produced from this module is served as a classic script with a `data-base`
 * attribute carrying the dashboard mount path (see api.ts).
 */

import { mountApp } from "./app";

mountApp();
