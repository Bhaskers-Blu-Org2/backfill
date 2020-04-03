import yargs from "yargs";

import { loadDotenv } from "backfill-utils-dotenv";
import { getCacheStorageProvider, ICacheStorage } from "backfill-cache";
import { Logger, makeLogger } from "backfill-logger";
import { createConfig, Config } from "backfill-config";
import { IHasher, Hasher } from "backfill-hasher";
export { createDefaultConfig } from "backfill-config";

import {
  getRawBuildCommand,
  createBuildCommand,
  BuildCommand
} from "./commandRunner";
import { initializeWatcher, closeWatcher } from "./audit";

// Load environment variables
loadDotenv();

export async function backfill(
  config: Config,
  cacheStorage: ICacheStorage,
  buildCommand: BuildCommand,
  hasher: IHasher,
  logger: Logger
): Promise<void> {
  const {
    cacheStorageConfig,
    outputGlob,
    name,
    mode,
    logFolder,
    producePerformanceLogs,
    validateOutput
  } = config;

  logger.setName(name);
  logger.setMode(mode, mode === "READ_WRITE" ? "info" : "verbose");
  logger.setCacheProvider(cacheStorageConfig.provider);

  const createPackageHash = async () => await hasher.createPackageHash();
  const fetch = async (hash: string) => await cacheStorage.fetch(hash);
  const run = async () => {
    try {
      await buildCommand();
    } catch (err) {
      throw new Error(`Command failed with the following error:\n\n${err}`);
    }
  };
  const put = async (hash: string) => {
    try {
      await cacheStorage.put(hash, outputGlob);
    } catch (err) {
      logger.error(
        `Failed to persist the cache with the following error:\n\n${err}`
      );
    }
  };

  switch (mode) {
    case "READ_WRITE": {
      const hash = await createPackageHash();

      if (!(await fetch(hash))) {
        await run();
        await put(hash);
      }

      break;
    }
    case "READ_ONLY": {
      const hash = await createPackageHash();

      if (!(await fetch(hash))) {
        await run();
      }

      break;
    }
    case "WRITE_ONLY": {
      const hash = await createPackageHash();

      await run();
      await put(hash);

      break;
    }
    case "PASS": {
      await run();
      break;
    }
  }

  if (validateOutput) {
    const hashOfOutput = await hasher.hashOfOutput();
    logger.setHashOfOutput(hashOfOutput);
  }

  if (producePerformanceLogs) {
    await logger.toFile(logFolder);
  }
}

export async function main(): Promise<void> {
  let logger = makeLogger("info");
  const cwd = process.cwd();
  try {
    const config = createConfig(logger, cwd);
    const {
      cacheStorageConfig,
      clearOutput,
      hashGlobs,
      internalCacheFolder,
      logFolder,
      logLevel,
      outputGlob,
      packageRoot
    } = config;

    if (logLevel) {
      logger = makeLogger(logLevel);
    }

    const helpString = "Backfills unchanged packages.";

    const argv = yargs
      .strict()
      .usage(helpString)
      .alias("h", "help")
      .version(false)
      .option("audit", {
        description: "Compare files changed with those cached",
        type: "boolean"
      }).argv;

    const buildCommand = createBuildCommand(
      argv["_"],
      clearOutput,
      outputGlob,
      logger
    );

    const cacheStorage = getCacheStorageProvider(
      cacheStorageConfig,
      internalCacheFolder,
      logger
    );

    const hasher = new Hasher(
      { packageRoot, outputGlob },
      getRawBuildCommand(),
      logger
    );

    if (argv["audit"]) {
      initializeWatcher(
        packageRoot,
        internalCacheFolder,
        logFolder,
        outputGlob,
        hashGlobs,
        logger
      );
    }

    await backfill(config, cacheStorage, buildCommand, hasher, logger);

    if (argv["audit"]) {
      await closeWatcher(logger);
    }
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}
