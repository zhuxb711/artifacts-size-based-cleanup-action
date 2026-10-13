import { constants, createWriteStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { finished } from 'node:stream/promises';
import * as core from '@actions/core';
import { ZipArchive } from 'archiver';
import bytes from 'bytes';
import { glob } from 'glob';
import _ from 'lodash';

export class Utils {
  static async checkPathExists(path: string): Promise<boolean> {
    return await access(path, constants.F_OK)
      .then(() => true)
      .catch(() => false);
  }

  static async expandPaths(paths: string[]): Promise<string[]> {
    const expandedPaths = new Array<string>();

    for (const inputPath of paths) {
      if (Utils.isGlobPattern(inputPath)) {
        expandedPaths.push(...(await Utils.resolveGlobPaths(inputPath)));
      } else {
        expandedPaths.push(inputPath);
      }
    }

    return _.uniqBy(expandedPaths, (path) => path.toLowerCase());
  }

  static async createZipFile(sourcePath: string, destinationPath: string, compressionLevel: number): Promise<string> {
    const config_zip_buffer = process.env.CLEANUP_OPTION_ZIP_BUFFER;
    const allowedZipBuffer = _.isEmpty(config_zip_buffer) ? 8 * 1024 * 1024 : Number(config_zip_buffer);

    const zipStream = createWriteStream(destinationPath, {
      flags: 'ax',
      autoClose: true,
      emitClose: true,
      flush: true
    });

    const zipArchiver = new ZipArchive({
      zlib: {
        level: compressionLevel
      },
      highWaterMark: allowedZipBuffer
    });

    zipArchiver.pipe(zipStream);
    zipArchiver.on('error', (err) => {
      throw new Error(`An error has occurred during zip creation for '${sourcePath}', message: ${err.message}`);
    });
    zipArchiver.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        core.warning('ENOENT warning during artifact zip creation. No such file or directory');
      } else {
        core.warning(`A non-blocking warning has occurred during artifact zip creation: ${err.code}`);
      }
    });

    zipStream.on('open', () => {
      core.info(`Archiver opened write stream for '${destinationPath}'`);
    });
    zipStream.on('error', (err) => {
      throw new Error(
        `An error has occurred while creating write stream for '${destinationPath}', message: ${err.message}`
      );
    });
    zipStream.on('close', () => {
      core.info(
        `Archiver zipped '${sourcePath}' into '${destinationPath}', size: ${bytes.format(zipArchiver.pointer())}`
      );
    });

    if (await Utils.checkPathExists(sourcePath)) {
      const fileStats = await stat(sourcePath);

      if (fileStats.isDirectory()) {
        zipArchiver.directory(sourcePath, false);
      } else {
        zipArchiver.file(sourcePath, {
          name: basename(sourcePath)
        });
      }
    }

    await zipArchiver.finalize();
    await finished(zipStream);

    return destinationPath;
  }

  private static isGlobPattern(path: string): boolean {
    return /[*?[\]{}]/.test(path);
  }

  private static async resolveGlobPaths(pattern: string): Promise<string[]> {
    return await glob(pattern, {
      dot: false,
      follow: true,
      absolute: true
    }).catch((error) => {
      core.warning(`Glob pattern '${pattern}' failed with error: ${error.message}`);
      return [];
    });
  }
}
