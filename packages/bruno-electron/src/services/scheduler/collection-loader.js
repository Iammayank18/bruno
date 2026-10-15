const fs = require('node:fs');
const path = require('node:path');
const { parseDotEnv } = require('@usebruno/filestore');
const { resolveEnvironmentInheritance, toVariablesMap } = require('@usebruno/common/utils');
const { walk, defaultClassify, resolveDenylist } = require('../../utils/mount');
const { generateUidBasedOnHash } = require('../../utils/common');
const { getCollectionFormat } = require('../../utils/filesystem');
const { getCollectionConfigFile } = require('../../app/collections');
const { transformBrunoConfigAfterRead } = require('../../utils/transformBrunoConfig');
const { hydrateEnvironments } = require('../../utils/environment-secrets-hydration');
const { buildTree } = require('../mount/tree-builder');
const { JobType, getPool } = require('../pool');
const CollectionSecurityStore = require('../../store/collection-security');
const { getBrunoConfig, setBrunoConfig, clearBrunoConfig } = require('../../store/bruno-config');
const {
  setDotEnvVars,
  clearDotEnvVars,
  setWorkspaceDotEnvVars,
  clearWorkspaceDotEnvVars,
  setCollectionWorkspace,
  clearCollectionWorkspace
} = require('../../store/process-env');
const dotEnvWatcher = require('../../app/dotenv-watcher');
const { globalEnvironmentsStore } = require('../../store/global-environments');
const { globalEnvironmentsManager } = require('../../store/workspace-environments');

const readDotEnv = (dirPath) => {
  const envPath = path.join(dirPath, '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }
  try {
    return parseDotEnv(fs.readFileSync(envPath, 'utf8'));
  } catch (err) {
    console.warn('[scheduler] failed to read .env at', dirPath, err.message);
    return {};
  }
};

const readGlobalEnvironmentVariables = async (workspacePathname) => {
  try {
    const { globalEnvironments } = workspacePathname
      ? await globalEnvironmentsManager.getGlobalEnvironments(workspacePathname)
      : { globalEnvironments: globalEnvironmentsStore.getGlobalEnvironments() };

    const activeUid = workspacePathname
      ? globalEnvironmentsStore.getActiveGlobalEnvironmentUidForWorkspace(workspacePathname)
      : globalEnvironmentsStore.getActiveGlobalEnvironmentUid();

    const targetEnvironment = (globalEnvironments || []).find((env) => env.uid === activeUid);
    const resolved = resolveEnvironmentInheritance({ environments: globalEnvironments, targetEnvironment });
    return resolved ? toVariablesMap(resolved.variables) : {};
  } catch (err) {
    console.warn('[scheduler] failed to resolve global environment variables', err.message);
    return {};
  }
};

/**
 * Loads a collection from disk into the shape the collection runner expects, without
 * the renderer: walk, parse off-thread, build the tree and hydrate environment secrets,
 * the same pipeline the mount manager uses.
 */
const loadCollectionFromDisk = async (collectionPath) => {
  const resolvedPath = path.resolve(collectionPath);

  const brunoConfig = await transformBrunoConfigAfterRead(await getCollectionConfigFile(resolvedPath), resolvedPath);
  const format = getCollectionFormat(resolvedPath);
  const files = walk(resolvedPath, resolveDenylist(brunoConfig?.ignore));
  const pool = getPool();

  const parserResults = new Map();
  await Promise.allSettled(
    files.map(async ({ relativePath }) => {
      const cls = defaultClassify(relativePath);
      if (!cls) return;
      try {
        const result = await pool.run(JobType.ParseFile, {
          collectionPath: resolvedPath,
          relativePath,
          format: cls.format,
          type: cls.type
        });
        parserResults.set(relativePath, { data: result.data, error: result.error, raw: result.raw });
      } catch (err) {
        parserResults.set(relativePath, { data: {}, error: { message: err.message, stack: err.stack }, raw: null });
      }
    })
  );

  const tree = buildTree(resolvedPath, parserResults, {});
  hydrateEnvironments(resolvedPath, tree.environments);

  return {
    version: '1',
    uid: generateUidBasedOnHash(resolvedPath),
    name: brunoConfig.name,
    pathname: resolvedPath,
    format,
    root: tree.root,
    items: tree.items,
    environments: tree.environments,
    brunoConfig,
    runtimeVariables: {},
    securityConfig: new CollectionSecurityStore().getSecurityConfigForCollection(resolvedPath)
  };
};

// Collection uid -> active scheduled runs and the store entries they seeded.
const seededCollections = new Map();

/**
 * The runner reads bruno.json, .env values and the workspace link from stores keyed by
 * collection uid, which the app fills only while a collection is open. A scheduled run
 * seeds whatever the app isn't already maintaining, and cleanupRunContext removes only
 * what it seeded, once the last concurrent run of that collection ends, so an open
 * collection's state is never touched.
 */
const seedCollectionStores = (collection, workspacePathname) => {
  const { uid, pathname } = collection;
  const existing = seededCollections.get(uid);
  if (existing) {
    existing.count += 1;
    return;
  }

  const seeded = { count: 1, brunoConfig: null, dotEnv: false, workspaceDotEnv: null, workspaceLink: false };

  if (Object.keys(getBrunoConfig(uid)).length === 0) {
    setBrunoConfig(uid, collection.brunoConfig);
    seeded.brunoConfig = collection.brunoConfig;
  }

  if (!dotEnvWatcher.hasCollectionWatcher(pathname)) {
    setCollectionWorkspace(uid, workspacePathname || null);
    seeded.workspaceLink = true;

    const collectionDotEnv = readDotEnv(pathname);
    if (Object.keys(collectionDotEnv).length > 0) {
      setDotEnvVars(uid, collectionDotEnv);
      seeded.dotEnv = true;
    }
  }

  if (workspacePathname && !dotEnvWatcher.hasWorkspaceWatcher(workspacePathname)) {
    const workspaceDotEnv = readDotEnv(workspacePathname);
    if (Object.keys(workspaceDotEnv).length > 0) {
      setWorkspaceDotEnvVars(workspacePathname, workspaceDotEnv);
      seeded.workspaceDotEnv = workspacePathname;
    }
  }

  seededCollections.set(uid, seeded);
};

const prepareRunContext = async ({ collection, environmentName, workspacePathname }) => {
  let environment = null;
  if (environmentName) {
    const targetEnvironment = collection.environments.find((env) => env.name === environmentName);
    environment = resolveEnvironmentInheritance({ environments: collection.environments, targetEnvironment }) || null;
    if (!environment) {
      console.warn(`[scheduler] environment "${environmentName}" not found in ${collection.pathname}, running without it`);
    }
  }

  collection.globalEnvironmentVariables = await readGlobalEnvironmentVariables(workspacePathname);
  seedCollectionStores(collection, workspacePathname);

  return { environment };
};

const cleanupRunContext = (collection) => {
  const { uid, pathname } = collection;
  const seeded = seededCollections.get(uid);
  if (!seeded) return;

  seeded.count -= 1;
  if (seeded.count > 0) return;
  seededCollections.delete(uid);

  if (seeded.brunoConfig && getBrunoConfig(uid) === seeded.brunoConfig) {
    clearBrunoConfig(uid);
  }
  // The collection may have been opened mid-run; its watcher owns these entries now.
  if (!dotEnvWatcher.hasCollectionWatcher(pathname)) {
    if (seeded.dotEnv) clearDotEnvVars(uid);
    if (seeded.workspaceLink) clearCollectionWorkspace(uid);
  }
  if (seeded.workspaceDotEnv && !dotEnvWatcher.hasWorkspaceWatcher(seeded.workspaceDotEnv)) {
    clearWorkspaceDotEnvVars(seeded.workspaceDotEnv);
  }
};

module.exports = {
  loadCollectionFromDisk,
  prepareRunContext,
  cleanupRunContext
};
