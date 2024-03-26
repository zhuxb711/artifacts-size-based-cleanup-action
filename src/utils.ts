import * as fsPromise from 'fs/promises';
import path from 'path';

export class Utils {
  static parseMultiLineInputs(input: string): string[] {
    return input
      .split(/\r?\n/)
      .filter((path) => path)
      .map((path) => path.trim());
  }

  static async calcuateMultiPathSize(paths: string[]): Promise<number> {
    let totalSize = 0;

    for (const path of paths) {
      const fileStats = await fsPromise.stat(path);

      if (fileStats.isDirectory()) {
        totalSize += await Utils.calculateFolderSize(path);
      } else {
        totalSize += fileStats.size;
      }
    }

    return totalSize;
  }

  static async calculateFolderSize(folderPath: string): Promise<number> {
    let totalSize = 0;

    for (const subName of await fsPromise.readdir(folderPath)) {
      const subPath = path.join(folderPath, subName);
      const fileStats = await fsPromise.stat(subPath);

      if (fileStats.isDirectory()) {
        totalSize += await Utils.calculateFolderSize(subPath);
      } else {
        totalSize += fileStats.size;
      }
    }

    return totalSize;
  }
}
