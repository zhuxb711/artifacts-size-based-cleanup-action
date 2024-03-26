export declare class Utils {
    static checkPathExists(path: string): Promise<boolean>;
    static parseMultiLineInputs(input: string): string[];
    static calcuateMultiPathSize(paths: string[]): Promise<number>;
    static calculateFolderSize(folderPath: string): Promise<number>;
}
