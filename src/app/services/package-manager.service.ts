import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

import { Category } from '../models/category';
import { PackageRowModel } from '../models/package-row-model';
import { PackageSource } from '../../../src-common/models/package-source';
import { InstalledPackage, PackageLevel, Project, Solution } from '../../../src-common/models/project';
import {
  InstallMessage,
  InstallPackageInProjectsMessage,
  RemovePackageFromProjectsMessage,
  RollbackPackageUpdateMessage,
  UIMessage,
  UninstallMessage,
  UpdatePackagesMessage,
} from '../../../src-common/models/ui-message';
import { PackageOperationResult } from '../../../src-common/models/extension-message';
import { NuGetApiService } from './nuget-api.service';
import { VscodeService } from './vscode.service';

export interface UpdateCountState {
  count: number | null;
  loading: boolean;
  error?: string;
}

@Injectable({
  providedIn: 'root',
})
export class PackageManagerService {
  private _currentSources = new BehaviorSubject<PackageSource[]>([]);
  public get currentSources(): Observable<PackageSource[]> {
    return this._currentSources.asObservable();
  }

  private _currentCategory = new BehaviorSubject<Category>(Category.Browse);
  public get currentCategory(): Observable<Category> {
    return this._currentCategory.asObservable();
  }

  private _currentProject = new BehaviorSubject<Project | null>(null);
  public get currentProject(): Observable<Project | null> {
    return this._currentProject.asObservable();
  }

  private _currentSolution = new BehaviorSubject<Solution | null>(null);
  public get currentSolution(): Observable<Solution | null> {
    return this._currentSolution.asObservable();
  }

  private _operationResults = new BehaviorSubject<PackageOperationResult[]>([]);
  public get operationResults(): Observable<PackageOperationResult[]> {
    return this._operationResults.asObservable();
  }

  private _rollbackId = new BehaviorSubject<string | null>(null);
  public get rollbackId(): Observable<string | null> {
    return this._rollbackId.asObservable();
  }

  private _packageOperationInProgress = new BehaviorSubject(false);
  public get packageOperationInProgress(): Observable<boolean> {
    return this._packageOperationInProgress.asObservable();
  }
  public get isPackageOperationInProgress(): boolean {
    return this._packageOperationInProgress.value;
  }

  private _packageOperationProgress = new BehaviorSubject<string | null>(null);
  public get packageOperationProgress(): Observable<string | null> {
    return this._packageOperationProgress.asObservable();
  }

  private _availableUpdateCount = new BehaviorSubject<UpdateCountState>({ count: null, loading: false });
  public get availableUpdateCount(): Observable<UpdateCountState> {
    return this._availableUpdateCount.asObservable();
  }

  public get consolidationCount(): number {
    return this.getConsolidatablePackageIds().size;
  }

  private _currentPackages = new BehaviorSubject<PackageRowModel[] | null>(null);
  public get currentPackages(): Observable<PackageRowModel[] | null> {
    return this._currentPackages.asObservable();
  }

  private _currentSelectedPackage = new BehaviorSubject<PackageRowModel | null>(null);
  public get currentSelectedPackage(): Observable<PackageRowModel | null> {
    return this._currentSelectedPackage.asObservable();
  }

  private _currentSelectedPackageId = new BehaviorSubject<string | null>(null);
  public get currentSelectedPackageId(): Observable<string | null> {
    return this._currentSelectedPackageId.asObservable();
  }

  private _currentSource: PackageSource | undefined;
  private _currentPrerelease = false;
  private readonly packageProjectSelections = new Map<string, string[]>();
  private readonly pendingPackageOperations = new Set<string>();
  private readonly packageOperationProgressMessages = new Map<string, string>();
  private packageOperationSequence = 0;
  private updateCountRequestSequence = 0;
  private lastUpdateCountKey: string | undefined;

  constructor(private nugetService: NuGetApiService, private vscodeService: VscodeService) {
    // tell the extension to load the project and it's installed packages
    // now we are sure the UI is loaded and ready to receive the message
    vscodeService.postMessage({
      command: 'load-project',
    });
  }

  public queryForPackages(query: string, prerelease: boolean, source: PackageSource): void {
    const selectedPackageId = this._currentSelectedPackageId.value;
    this._currentSelectedPackage.next(null);
    this._currentSelectedPackageId.next(selectedPackageId);
    this._currentPackages.next(null);

    this._currentSource = source;
    this._currentPrerelease = prerelease;
    this.refreshAvailableUpdateCount();

    const currentCategory = this._currentCategory.value;

    if (currentCategory === Category.Browse) {
      this.nugetService.search(query, prerelease, source).subscribe((packageRowModels: PackageRowModel[]) => {
        this.setCurrentPackages(packageRowModels);
      });
    } else {
      const currentInstalledPackageIds =
        currentCategory === Category.Updates || currentCategory === Category.Consolidate
          ? this.getDirectInstalledPackageIds()
          : this.getCurrentInstalledPackageIds();
      if (currentInstalledPackageIds.length) {
        this.nugetService
          .searchByPackageIds(currentInstalledPackageIds, query, prerelease, source)
          .subscribe((packageRowModels: PackageRowModel[]) => {
            packageRowModels = this.filterResultsToMatchCategory(packageRowModels);
            this.setCurrentPackages(packageRowModels);
          });
      } else {
        this.setCurrentPackages([]);
      }
    }
  }

  public changeCurrentProject(project: Project) {
    this._currentSolution.next(null);
    this.packageProjectSelections.clear();
    this._currentProject.next(project);
    this.resetUnavailableConsolidateCategory();
    this.refreshAvailableUpdateCount();

    const currentPackages = this._currentPackages.value;
    if (currentPackages && project.packages.length) {
      this.setInstalledInformation(currentPackages);
    }
  }

  public changeCurrentSolution(solution: Solution): void {
    const previousSolution = this._currentSolution.value;
    this._currentProject.next(null);
    this._currentSolution.next(solution);
    if (previousSolution?.fsPath !== solution.fsPath) {
      this.packageProjectSelections.clear();
    } else {
      const projectPaths = new Set(solution.projects.map((project) => project.fsPath));
      this.packageProjectSelections.forEach((paths, key) => {
        this.packageProjectSelections.set(key, paths.filter((projectPath) => projectPaths.has(projectPath)));
      });
    }
    this.resetUnavailableConsolidateCategory();
    this.refreshAvailableUpdateCount();

    const currentPackages = this._currentPackages.value;
    if (currentPackages) {
      this.setInstalledInformation(currentPackages);
    }
  }

  public selectedProjectsForPackage(packageId: string): string[] {
    const solution = this._currentSolution.value;
    if (!solution) {
      return [];
    }
    return [...(this.packageProjectSelections.get(this.packageSelectionKey(solution, packageId)) ?? [])];
  }

  public selectProjectsForPackage(packageId: string, projectPaths: string[]): void {
    const solution = this._currentSolution.value;
    if (!solution) {
      return;
    }
    const knownPaths = new Set(solution.projects.map((project) => project.fsPath));
    const selectedPaths = Array.from(new Set(projectPaths)).filter((projectPath) => knownPaths.has(projectPath));
    this.packageProjectSelections.set(this.packageSelectionKey(solution, packageId), selectedPaths);
  }

  public setOperationResults(results: PackageOperationResult[], rollbackId?: string): void {
    this._operationResults.next(results);
    this._rollbackId.next(rollbackId ?? null);
  }

  public dismissOperationResults(): void {
    if (this.isPackageOperationInProgress) {
      return;
    }
    this._operationResults.next([]);
    this._rollbackId.next(null);
  }

  public setPackageOperationProgress(operationId: string, message: string): void {
    if (!this.pendingPackageOperations.has(operationId)) {
      return;
    }
    this.packageOperationProgressMessages.set(operationId, message);
    this.updatePackageOperationProgress();
  }

  public completePackageOperation(operationId: string): void {
    if (this.pendingPackageOperations.delete(operationId)) {
      this.packageOperationProgressMessages.delete(operationId);
      this._packageOperationInProgress.next(this.pendingPackageOperations.size > 0);
      this.updatePackageOperationProgress();
    }
  }

  public changeCurrentSources(sources: PackageSource[]): void {
    this._currentSources.next(sources);
  }

  public changeCurrentSelectedPackage(selectedPackage: PackageRowModel | null): void {
    // set the current selected package id so that the list highlights it
    this._currentSelectedPackageId.next(selectedPackage?.id ?? null);
    // set the current selected package to null to clear the details pane
    this._currentSelectedPackage.next(null);

    // if no package selected or if the versions/metadata for the package are already loaded, just display it
    if (selectedPackage == null || selectedPackage.versions !== undefined) {
      this._currentSelectedPackage.next(selectedPackage);
    } else if (this._currentSource) {
      // else query the api for the package metadata and use the versions from the result
      this.nugetService.searchByPackageIds([selectedPackage?.id], '', this._currentPrerelease, this._currentSource).subscribe((results) => {
        selectedPackage.versions = results[0].versions;
        this._currentSelectedPackage.next(selectedPackage);
      });
    }
  }

  public changeCurrentCategory(category: Category): void {
    this._currentCategory.next(category);
  }

  public installPackage(packageToInstall: PackageRowModel | null, version?: string, projectPaths?: string[], includeCpmExceptions = false) {
    if (packageToInstall === null || this.isPackageOperationInProgress) {
      return;
    }
    const selectedPaths = projectPaths ?? this.selectedProjectsForPackage(packageToInstall.id);
    if (this._currentSolution.value && selectedPaths.length === 0) {
      return;
    }
    const installMessage = this.mapPackageToInstallMessage(packageToInstall, version, selectedPaths, includeCpmExceptions);

    this.postPackageOperation(installMessage);
  }

  public installPackages(packagesToInstall: PackageRowModel[], buildAfterRestore = false): void {
    if (packagesToInstall.length <= 0 || this.isPackageOperationInProgress) {
      return;
    }

    const updates = packagesToInstall.flatMap((packageToInstall) => {
      const currentSolution = this._currentSolution.value;
      if (currentSolution) {
        const selectedPaths = new Set(this.selectedProjectsForPackage(packageToInstall.id));
        const projectPaths = currentSolution.projects
          .filter((project) => selectedPaths.size === 0 || selectedPaths.has(project.fsPath))
          .filter((project) => this.isDirectOutdatedPackage(project.packages, packageToInstall))
          .map((project) => project.fsPath);
        return projectPaths.length > 0
          ? [
              {
                projectPaths,
                packageId: packageToInstall.id,
                packageVersion: packageToInstall.version,
                packageSourceUrl: packageToInstall.sourceUrl,
              },
            ]
          : [];
      }

      const currentProject = this._currentProject.value;
      if (!currentProject || !this.isDirectOutdatedPackage(currentProject.packages, packageToInstall)) {
        return [];
      }
      return [
        {
          projectPaths: [currentProject.fsPath],
          packageId: packageToInstall.id,
          packageVersion: packageToInstall.version,
          packageSourceUrl: packageToInstall.sourceUrl,
          ...(currentProject.managePackageVersionsCentrally ? { includeCpmExceptions: true } : {}),
        },
      ];
    });

    if (updates.length === 0) {
      return;
    }

    const message: UpdatePackagesMessage = {
      command: 'update-packages-batch',
      updates,
      buildAfterRestore,
    };
    this.postPackageOperation(message);
  }

  public rollbackPackageUpdate(rollbackId: string): void {
    if (this.isPackageOperationInProgress || !rollbackId) {
      return;
    }
    const message: RollbackPackageUpdateMessage = { command: 'rollback-package-update', rollbackId };
    this.postPackageOperation(message);
    this._rollbackId.next(null);
  }

  public uninstallPackage(packageToUninstall: PackageRowModel | null, projectPaths?: string[]) {
    if (packageToUninstall === null || this.isPackageOperationInProgress) {
      return;
    }

    const currentSolution = this._currentSolution.value;
    if (currentSolution) {
      const selectedPaths = new Set(projectPaths ?? this.selectedProjectsForPackage(packageToUninstall.id));
      const targetPaths = currentSolution.projects
        .filter(
          (project) =>
            selectedPaths.has(project.fsPath) &&
            project.packages.some(
              (installedPackage) =>
                installedPackage.id.toLowerCase() === packageToUninstall.id.toLowerCase() && installedPackage.packageLevel !== 'transitive'
            )
        )
        .map((project) => project.fsPath);
      if (targetPaths.length > 0) {
        const message: RemovePackageFromProjectsMessage = {
          command: 'remove-package-from-projects',
          projectPaths: targetPaths,
          packageId: packageToUninstall.id,
        };
        this.postPackageOperation(message);
      }
      return;
    }

    const currentProject = this._currentProject.value;
    if (currentProject?.managePackageVersionsCentrally) {
      const message: RemovePackageFromProjectsMessage = {
        command: 'remove-package-from-projects',
        projectPaths: [currentProject.fsPath],
        packageId: packageToUninstall.id,
      };
      this.postPackageOperation(message);
      return;
    }

    this.postPackageOperation({
      command: 'remove-package',
      projectName: currentProject?.fsPath ?? '',
      packageId: packageToUninstall.id,
    } as UninstallMessage);
  }

  private mapPackageToInstallMessage(
    packageToInstall: PackageRowModel,
    version?: string,
    projectPaths: string[] = [],
    includeCpmExceptions = false
  ): InstallMessage | InstallPackageInProjectsMessage {
    const currentSolution = this._currentSolution.value;
    if (currentSolution) {
      const message: InstallPackageInProjectsMessage = {
        command: 'add-package-to-projects',
        projectPaths: [...projectPaths],
        packageId: packageToInstall.id,
        packageVersion: version ?? packageToInstall.version,
        packageSourceUrl: packageToInstall.sourceUrl,
        includeCpmExceptions,
      };
      return message;
    }

    const currentProject = this._currentProject.value;
    if (!currentProject) {
      throw new Error('Current project cannot be undefined');
    }

    // if no specific version is provided just install the latest on the package
    const versionToInstall = version ?? packageToInstall.version;

    if (currentProject.managePackageVersionsCentrally) {
      return {
        command: 'add-package-to-projects',
        projectPaths: [currentProject.fsPath],
        packageId: packageToInstall.id,
        packageVersion: versionToInstall,
        packageSourceUrl: packageToInstall.sourceUrl,
        includeCpmExceptions: true,
      };
    }

    return {
      command: 'add-package',
      projectName: currentProject.fsPath,
      packageId: packageToInstall.id,
      packageVersion: versionToInstall,
      packageSourceUrl: packageToInstall.sourceUrl,
    };
  }

  private packageSelectionKey(solution: Solution, packageId: string): string {
    return `${solution.fsPath.toLowerCase()}|${packageId.toLowerCase()}`;
  }

  private postPackageOperation(message: UIMessage): void {
    if (message.command !== 'rollback-package-update') {
      this._operationResults.next([]);
      this._rollbackId.next(null);
    }
    const operationId = `${Date.now().toString(36)}-${(++this.packageOperationSequence).toString(36)}`;
    this.pendingPackageOperations.add(operationId);
    this._packageOperationInProgress.next(true);
    this._packageOperationProgress.next(null);
    try {
      this.vscodeService.postMessage({ ...message, operationId });
    } catch (error) {
      this.completePackageOperation(operationId);
      throw error;
    }
  }

  private setInstalledInformation(packageRowModels: PackageRowModel[]): void {
    const currentSolution = this._currentSolution.value;
    if (currentSolution) {
      packageRowModels.forEach((packageRowModel) => {
        const projectStates = currentSolution.projects.map((project) => {
          const installedPackage = project.packages.find((item) => item.id.toLowerCase() === packageRowModel.id.toLowerCase());
          return {
            projectPath: project.fsPath,
            projectName: project.name,
            isInstalled: installedPackage !== undefined,
            isDirectlyInstalled: installedPackage !== undefined && installedPackage.packageLevel !== 'transitive',
            installedVersion: installedPackage?.version ?? '',
            versionSource: installedPackage?.versionSource,
            packageLevel: installedPackage?.packageLevel,
            managePackageVersionsCentrally: project.managePackageVersionsCentrally,
            targetFrameworkVersions: installedPackage?.targetFrameworkVersions,
            packageListWarning: project.packageListWarning,
          };
        });
        const installedStates = projectStates.filter((state) => state.isInstalled);
        const installedVersions = new Set(installedStates.map((state) => state.installedVersion));
        const versionSources = new Set(installedStates.map((state) => state.versionSource).filter((source) => source !== undefined));
        packageRowModel.solutionProjectStates = projectStates;
        packageRowModel.isInstalled = installedStates.length > 0;
        packageRowModel.installedVersion =
          installedVersions.size === 1 ? installedStates[0].installedVersion : installedVersions.size > 1 ? 'Varies by project' : '';
        packageRowModel.versionSource = versionSources.size === 1 ? Array.from(versionSources)[0] : versionSources.size > 1 ? 'mixed' : undefined;
        const packageLevels = new Set<PackageLevel>(installedStates.flatMap((state) => (state.packageLevel ? [state.packageLevel] : [])));
        packageRowModel.packageLevel = packageLevels.size === 1 ? Array.from(packageLevels)[0] : packageLevels.size > 1 ? 'mixed' : undefined;
        packageRowModel.isOutdated = installedStates.some((state) => state.installedVersion !== packageRowModel.version);
      });
      return;
    }

    const currentInstalledPackages = this._currentProject.value?.packages;

    if (currentInstalledPackages) {
      packageRowModels.forEach((packageRowModel: PackageRowModel) => {
        const installedPackage = currentInstalledPackages.find(
          (currentPackage: InstalledPackage) => currentPackage.id.toLowerCase() === packageRowModel.id.toLowerCase()
        );

        packageRowModel.isInstalled = installedPackage !== undefined;
        packageRowModel.installedVersion = installedPackage ? installedPackage.version : '';
        packageRowModel.versionSource = installedPackage?.versionSource;
        packageRowModel.packageLevel = installedPackage?.packageLevel;
        packageRowModel.isOutdated = packageRowModel.isInstalled && packageRowModel.installedVersion !== packageRowModel.version;
      });
    }
  }

  private setCurrentPackages(packageRowModels: PackageRowModel[]): void {
    this.setInstalledInformation(packageRowModels);
    this._currentPackages.next(packageRowModels);

    const selectedPackageId = this._currentSelectedPackageId.value;
    const selectedPackage = selectedPackageId
      ? packageRowModels.find((packageRow) => packageRow.id.toLowerCase() === selectedPackageId.toLowerCase()) ?? null
      : null;
    this.changeCurrentSelectedPackage(selectedPackage);
  }

  private filterResultsToMatchCategory(packageRowModels: PackageRowModel[]): PackageRowModel[] {
    const currentCategory = this._currentCategory.value;

    if (currentCategory === Category.Updates) {
      return packageRowModels.filter((packageRowModel: PackageRowModel) => this.hasDirectUpdate(packageRowModel));
    }
    if (currentCategory === Category.Consolidate) {
      const consolidatablePackageIds = this.getConsolidatablePackageIds();
      return packageRowModels.filter((packageRowModel) => consolidatablePackageIds.has(packageRowModel.id.toLowerCase()));
    }

    return packageRowModels;
  }

  private getCurrentInstalledPackageIds(): string[] {
    const currentSolution = this._currentSolution.value;
    if (currentSolution) {
      return Array.from(new Set(currentSolution.projects.flatMap((project) => project.packages.map((installedPackage) => installedPackage.id))));
    }

    const currentInstalledPackages = this._currentProject.value?.packages;

    if (!currentInstalledPackages) {
      return [];
    }

    return currentInstalledPackages.map((installedPackage: InstalledPackage) => installedPackage.id);
  }

  private getDirectInstalledPackages(): Array<{ id: string; version: string; projectPath: string }> {
    const currentSolution = this._currentSolution.value;
    if (currentSolution) {
      return currentSolution.projects.flatMap((project) =>
        project.packages
          .filter((installedPackage) => installedPackage.packageLevel !== 'transitive')
          .map((installedPackage) => ({ id: installedPackage.id, version: installedPackage.version, projectPath: project.fsPath }))
      );
    }

    const currentProject = this._currentProject.value;
    return (
      currentProject?.packages
        .filter((installedPackage) => installedPackage.packageLevel !== 'transitive')
        .map((installedPackage) => ({ id: installedPackage.id, version: installedPackage.version, projectPath: currentProject.fsPath })) ?? []
    );
  }

  private getDirectInstalledPackageIds(): string[] {
    return Array.from(
      new Map(this.getDirectInstalledPackages().map((installedPackage) => [installedPackage.id.toLowerCase(), installedPackage.id])).values()
    );
  }

  private isDirectOutdatedPackage(installedPackages: InstalledPackage[], packageToUpdate: PackageRowModel): boolean {
    const installedPackage = installedPackages.find((item) => item.id.toLowerCase() === packageToUpdate.id.toLowerCase());
    return (
      installedPackage !== undefined &&
      installedPackage.packageLevel !== 'transitive' &&
      installedPackage.version !== packageToUpdate.version
    );
  }

  private hasDirectUpdate(packageRowModel: PackageRowModel): boolean {
    if (this._currentSolution.value) {
      return this._currentSolution.value.projects.some((project) =>
        this.isDirectOutdatedPackage(project.packages, packageRowModel)
      );
    }
    return this.isDirectOutdatedPackage(this._currentProject.value?.packages ?? [], packageRowModel);
  }

  private getConsolidatablePackageIds(): Set<string> {
    const solution = this._currentSolution.value;
    if (!solution) {
      return new Set();
    }

    const versionsByPackage = new Map<string, Map<string, Set<string>>>();
    solution.projects.forEach((project) => {
      project.packages.forEach((installedPackage) => {
        if (installedPackage.packageLevel === 'transitive') {
          return;
        }

        const id = installedPackage.id.toLowerCase();
        const frameworkVersions = installedPackage.targetFrameworkVersions?.filter(
          (item) => item.packageLevel !== 'transitive' && item.version.length > 0
        );
        const versions = new Set(
          frameworkVersions?.length
            ? frameworkVersions.map((item) => item.version)
            : installedPackage.targetFrameworkVersions?.length
              ? []
            : installedPackage.version && installedPackage.version !== 'Varies by target framework'
              ? [installedPackage.version]
              : []
        );
        if (versions.size === 0) {
          return;
        }

        const versionsByProject = versionsByPackage.get(id) ?? new Map<string, Set<string>>();
        const existingVersions = versionsByProject.get(project.fsPath) ?? new Set<string>();
        versions.forEach((version) => existingVersions.add(version));
        versionsByProject.set(project.fsPath, existingVersions);
        versionsByPackage.set(id, versionsByProject);
      });
    });

    const consolidatablePackageIds = new Set<string>();
    versionsByPackage.forEach((versionsByProject, id) => {
      if (versionsByProject.size < 2) {
        return;
      }
      const projectVersionSets = Array.from(versionsByProject.values()).map((versions) => JSON.stringify(Array.from(versions).sort()));
      if (new Set(projectVersionSets).size > 1) {
        consolidatablePackageIds.add(id);
      }
    });
    return consolidatablePackageIds;
  }

  private resetUnavailableConsolidateCategory(): void {
    if (this._currentCategory.value === Category.Consolidate && this.consolidationCount === 0) {
      this._currentCategory.next(Category.Installed);
    }
  }

  private refreshAvailableUpdateCount(): void {
    if (!this._currentSource || (!this._currentProject.value && !this._currentSolution.value)) {
      this.updateCountRequestSequence++;
      this.lastUpdateCountKey = undefined;
      this._availableUpdateCount.next({ count: null, loading: false });
      return;
    }

    const installedPackages = this.getDirectInstalledPackages();
    const key = JSON.stringify([
      this._currentSource.url,
      this._currentSource.authorizationHeader ?? '',
      this._currentPrerelease,
      ...installedPackages.map((item) => `${item.projectPath.toLowerCase()}|${item.id.toLowerCase()}|${item.version}`).sort(),
    ]);
    if (key === this.lastUpdateCountKey && !this._availableUpdateCount.value.error) {
      return;
    }
    this.lastUpdateCountKey = key;

    const requestId = ++this.updateCountRequestSequence;
    const versionsByPackageId = new Map<string, string[]>();
    installedPackages.forEach((installedPackage) => {
      const id = installedPackage.id.toLowerCase();
      versionsByPackageId.set(id, [...(versionsByPackageId.get(id) ?? []), installedPackage.version]);
    });
    const packageIds = Array.from(new Map(installedPackages.map((item) => [item.id.toLowerCase(), item.id])).values());
    if (packageIds.length === 0) {
      this._availableUpdateCount.next({ count: 0, loading: false });
      return;
    }

    const source = this._currentSource;
    const prerelease = this._currentPrerelease;
    this._availableUpdateCount.next({ count: null, loading: true });
    this.nugetService.searchByPackageIds(packageIds, '', prerelease, source).subscribe({
      next: (packages) => {
        if (requestId !== this.updateCountRequestSequence) {
          return;
        }
        const updatedPackageIds = new Set(
          packages
            .filter((packageRow) =>
              (versionsByPackageId.get(packageRow.id.toLowerCase()) ?? []).some((installedVersion) => installedVersion !== packageRow.version)
            )
            .map((packageRow) => packageRow.id.toLowerCase())
        );
        this._availableUpdateCount.next({ count: updatedPackageIds.size, loading: false });
      },
      error: (error: unknown) => {
        if (requestId !== this.updateCountRequestSequence) {
          return;
        }
        this._availableUpdateCount.next({
          count: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  private updatePackageOperationProgress(): void {
    const messages = Array.from(this.packageOperationProgressMessages.values());
    this._packageOperationProgress.next(messages[messages.length - 1] ?? null);
  }
}
