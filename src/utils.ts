import path from 'path';
import bytes from 'bytes';
import _ from 'lodash';
import * as fs from 'fs';
import * as fsPromise from 'fs/promises';
import * as archiver from 'archiver';
import * as core from '@actions/core';
import * as streamPromise from 'stream/promises';

export class Utils {
  static async checkPathExists(path: string): Promise<boolean> {
    return await fsPromise
      .access(path, fs.constants.F_OK)
      .then(() => true)
      .catch(() => false);
  }

  static async createZipFile(sourcePath: string, destinationPath: string, compressionLevel: number): Promise<void> {
    const config_zip_buffer = process.env.CLEANUP_OPTION_ZIP_BUFFER;
    const allowedZipBuffer = _.isEmpty(config_zip_buffer) ? 8 * 1024 * 1024 : Number(config_zip_buffer);

    const zipStream = fs.createWriteStream(destinationPath, {
      flags: 'ax',
      autoClose: true,
      emitClose: true,
      flush: true
    });

    const zipArchiver = archiver.create('zip', {
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
      core.debug(`Archiver opened write stream for '${destinationPath}'`);
    });
    zipStream.on('error', (err) => {
      throw new Error(
        `An error has occurred while creating write stream for '${destinationPath}', message: ${err.message}`
      );
    });
    zipStream.on('close', () => {
      core.debug(
        `Archiver zipped '${sourcePath}' into '${destinationPath}', size: ${bytes.format(zipArchiver.pointer())}`
      );
    });

    if (await Utils.checkPathExists(sourcePath)) {
      const fileStats = await fsPromise.stat(sourcePath);

      if (fileStats.isDirectory()) {
        zipArchiver.directory(sourcePath, false);
      } else {
        zipArchiver.file(sourcePath, {
          name: path.basename(sourcePath)
        });
      }
    }

    await zipArchiver.finalize();
    await streamPromise.finished(zipStream);
  }
}
