export interface UIMessage {
  command: string;
  operationId?: string;
}

export interface LoadSolutionMessage extends UIMessage {
  command: 'load-solution';
  solutionFilePath: string;
}

export interface UninstallMessage extends UIMessage {
  projectName: string;
  packageId: string;
}

export interface InstallMessage extends UninstallMessage {
  packageVersion: string;
  packageSourceUrl: string;
}

export interface InstallPackageInProjectsMessage extends UIMessage {
  command: 'add-package-to-projects';
  projectPaths: string[];
  packageId: string;
  packageVersion: string;
  packageSourceUrl: string;
  includeCpmExceptions?: boolean;
}

export interface RemovePackageFromProjectsMessage extends UIMessage {
  command: 'remove-package-from-projects';
  projectPaths: string[];
  packageId: string;
}

export interface PackageUpdateOperation {
  projectPaths: string[];
  packageId: string;
  packageVersion: string;
  packageSourceUrl: string;
  includeCpmExceptions?: boolean;
}

export interface UpdatePackagesMessage extends UIMessage {
  command: 'update-packages-batch';
  updates: PackageUpdateOperation[];
  buildAfterRestore: boolean;
}

export interface RollbackPackageUpdateMessage extends UIMessage {
  command: 'rollback-package-update';
  rollbackId: string;
}
