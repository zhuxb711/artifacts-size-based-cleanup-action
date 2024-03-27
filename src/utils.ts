import path from 'path';
import _ from 'lodash';
import * as fs from 'fs';
import * as fsPromise from 'fs/promises';
import * as archiver from 'archiver';
import * as core from '@actions/core';

export class Utils {
  static async checkPathExists(path: string): Promise<boolean> {
    return await fsPromise
      .access(path, fs.constants.F_OK)
      .then(() => true)
      .catch(() => false);
  }

  static async createCompressedZipFile(
    sourcePath: string,
    destinationPath: string,
    compressionLevel: number
  ): Promise<void> {
    const config_zip_buffer = process.env.CLEANUP_OPTION_ZIP_BUFFER;
    const zipBuffer = _.isEmpty(config_zip_buffer) ? 1024 * 1024 * 8 : Number(config_zip_buffer);

    const zipStream = fs.createWriteStream(destinationPath, {
      flags: 'ax'
    });
    const zipArchiver = archiver.create('zip', {
      zlib: {
        level: compressionLevel
      },
      highWaterMark: zipBuffer
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
      console.log(`Write stream opened for '${destinationPath}'`);
    });
    zipStream.on('error', (err) => {
      throw new Error(
        `An error has occurred while creating write stream for '${destinationPath}', message: ${err.message}`
      );
    });
    zipStream.on('close', () => {
      console.log(`Archiver zipped ${zipArchiver.pointer()} total bytes`);
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
  }
}
