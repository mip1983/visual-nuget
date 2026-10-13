import * as path from 'path';
import { InstalledPackage, PackageLevel, PackageVersionSource, Project, TargetFrameworkPackageVersion } from '../../src-common/models/project';
import { executeDotnet } from './dotnet-cli';

interface MsbuildItem {
  identity: string;
  version?: string;
  versionOverride?: string;
  definingProjectFullPath?: string;
  condition?: string;
}

export interface ProjectEvaluation {
  targetFramework?: string;
  targetFrameworks?: string;
  managePackageVersionsCentrally: boolean;
  packageReferences: MsbuildItem[];
  packageVersions: MsbuildItem[];
}

export type ProjectEvaluationRunner = (projectFilePath: string, targetFramework?: string) => Promise<ProjectEvaluation>;

interface PackageListEntry {
  id: string;
  targetFramework: string;
  version: string;
  packageLevel: 'direct' | 'transitive';
}

export type ProjectPackageLister = (projectFilePath: string) => Promise<string>;

interface EvaluationJson {
  Properties?: Record<string, unknown>;
  Items?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readItems(items: unknown, itemName: string): MsbuildItem[] {
  if (items === undefined) {
    return [];
  }
  if (!Array.isArray(items)) {
    throw new Error(`MSBuild returned an invalid ${itemName} item list.`);
  }

  return items.map((item: unknown, index: number) => {
    if (!isRecord(item) || typeof item['Identity'] !== 'string') {
      throw new Error(`MSBuild returned an invalid ${itemName} item at index ${index}.`);
    }

    return {
      identity: item['Identity'],
      version: readString(item['Version']),
      versionOverride: readString(item['VersionOverride']),
      definingProjectFullPath: readString(item['DefiningProjectFullPath']),
      condition: readString(item['Condition']),
    };
  });
}

function runPackageList(projectFilePath: string): Promise<string> {
  return executeDotnet(
    ['list', 'package', '--include-transitive', '--format', 'json', '--no-restore', '--project', projectFilePath],
    path.dirname(projectFilePath),
    `Package listing for "${projectFilePath}"`
  );
}

function parsePackageList(output: string): PackageListEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse dotnet package list output: ${detail}`);
  }

  if (!isRecord(parsed) || !Array.isArray(parsed['projects'])) {
    throw new Error('dotnet package list returned an invalid project list.');
  }

  const entries: PackageListEntry[] = [];
  for (const project of parsed['projects']) {
    if (!isRecord(project) || !Array.isArray(project['frameworks'])) {
      throw new Error('dotnet package list returned an invalid framework list.');
    }
    for (const framework of project['frameworks']) {
      if (!isRecord(framework) || typeof framework['framework'] !== 'string') {
        throw new Error('dotnet package list returned an invalid framework entry.');
      }
      for (const [key, packageLevel] of [
        ['topLevelPackages', 'direct'],
        ['transitivePackages', 'transitive'],
      ] as const) {
        const packages = framework[key];
        if (packages === undefined) {
          continue;
        }
        if (!Array.isArray(packages)) {
          throw new Error(`dotnet package list returned an invalid ${key} list.`);
        }
        for (const packageItem of packages) {
          if (!isRecord(packageItem) || typeof packageItem['id'] !== 'string') {
            throw new Error(`dotnet package list returned an invalid ${key} entry.`);
          }
          const version = readString(packageItem['resolvedVersion']);
          if (!version) {
            continue;
          }
          entries.push({
            id: packageItem['id'],
            targetFramework: framework['framework'],
            version,
            packageLevel,
          });
        }
      }
    }
  }
  return entries;
}

function runMsbuildEvaluation(projectFilePath: string, targetFramework?: string): Promise<ProjectEvaluation> {
  const args = [
    'msbuild',
    projectFilePath,
    '-nologo',
    '-property:Configuration=Debug',
    '-getProperty:TargetFramework,TargetFrameworks,ManagePackageVersionsCentrally',
    '-getItem:PackageReference,PackageVersion',
  ];
  if (targetFramework) {
    args.push(`-property:TargetFramework=${targetFramework}`);
  }

  return executeDotnet(args, path.dirname(projectFilePath), `MSBuild evaluation for "${projectFilePath}"`).then((stdout) => {
    let result: unknown;
    try {
      result = JSON.parse(stdout) as unknown;
    } catch (parseError) {
      const detail = parseError instanceof Error ? parseError.message : String(parseError);
      throw new Error(`Could not parse MSBuild evaluation output for "${projectFilePath}": ${detail}`);
    }

    if (!isRecord(result)) {
      throw new Error(`MSBuild returned an invalid evaluation result for "${projectFilePath}".`);
    }
    const output = result as EvaluationJson;
    const properties = output.Properties;
    const items = output.Items;
    if (!isRecord(properties) || !isRecord(items)) {
      throw new Error(`MSBuild returned an incomplete evaluation result for "${projectFilePath}".`);
    }

    return {
      targetFramework: readString(properties['TargetFramework']),
      targetFrameworks: readString(properties['TargetFrameworks']),
      managePackageVersionsCentrally: readString(properties['ManagePackageVersionsCentrally'])?.toLowerCase() === 'true',
      packageReferences: readItems(items['PackageReference'], 'PackageReference'),
      packageVersions: readItems(items['PackageVersion'], 'PackageVersion'),
    };
  });
}

function effectivePackageVersion(
  reference: MsbuildItem,
  packageVersions: MsbuildItem[],
  targetFramework: string
): TargetFrameworkPackageVersion {
  const centralVersions = packageVersions.filter((item) => item.identity.toLowerCase() === reference.identity.toLowerCase());
  const centralVersion =
    centralVersions.find((item) => item.condition?.includes(`'$(TargetFramework)' == '${targetFramework}'`)) ??
    centralVersions.find((item) => item.condition === undefined) ??
    (centralVersions.length === 1 ? centralVersions[0] : undefined);
  const version = reference.versionOverride ?? reference.version ?? centralVersion?.version ?? '';
  let versionSource: PackageVersionSource = 'unknown';
  let versionFilePath = reference.definingProjectFullPath;

  if (reference.versionOverride) {
    versionSource = 'override';
  } else if (reference.version) {
    versionSource = 'project';
  } else if (centralVersion?.version) {
    versionSource = 'central';
    versionFilePath = centralVersion.definingProjectFullPath;
  }

  return {
    targetFramework: '',
    version,
    versionSource,
    packageLevel: 'direct',
    condition: centralVersion?.condition ?? reference.condition,
    versionFilePath,
  };
}

function mergePackages(evaluations: ProjectEvaluation[]): InstalledPackage[] {
  const packages = new Map<string, { id: string; versions: TargetFrameworkPackageVersion[] }>();

  for (const evaluation of evaluations) {
    const referencesById = new Map<string, MsbuildItem>();
    for (const reference of evaluation.packageReferences) {
      const key = reference.identity.toLowerCase();
      const existing = referencesById.get(key);
      if (existing) {
        const existingVersion = effectivePackageVersion(existing, evaluation.packageVersions, evaluation.targetFramework ?? '').version;
        const duplicateVersion = effectivePackageVersion(reference, evaluation.packageVersions, evaluation.targetFramework ?? '').version;
        if (existingVersion !== duplicateVersion) {
          throw new Error(`Project has conflicting evaluated PackageReference entries for "${reference.identity}".`);
        }
      }
      referencesById.set(key, reference);
    }

    for (const [key, reference] of referencesById) {
      const entry = packages.get(key) ?? { id: reference.identity, versions: [] };
      const resolvedVersion = effectivePackageVersion(reference, evaluation.packageVersions, evaluation.targetFramework ?? '');
      resolvedVersion.targetFramework = evaluation.targetFramework ?? '';
      entry.versions.push(resolvedVersion);
      packages.set(key, entry);
    }
  }

  return Array.from(packages.values()).map(({ id, versions }) => {
    const uniqueVersions = new Set(versions.map((entry) => entry.version));
    const uniqueSources = new Set(versions.map((entry) => entry.versionSource));
    const uniqueFiles = new Set(versions.map((entry) => entry.versionFilePath).filter((filePath): filePath is string => filePath !== undefined));
    return {
      id,
      version: uniqueVersions.size === 1 ? versions[0].version : 'Varies by target framework',
      versionSource: uniqueSources.size === 1 ? versions[0].versionSource : 'mixed',
      packageLevel: packageLevelFor(versions),
      targetFrameworkVersions: versions,
      versionFilePath: uniqueFiles.size === 1 ? Array.from(uniqueFiles)[0] : undefined,
    };
  });
}

function packageLevelFor(versions: TargetFrameworkPackageVersion[]): PackageLevel {
  const levels = new Set<'direct' | 'transitive'>(versions.flatMap((entry) => (entry.packageLevel ? [entry.packageLevel] : [])));
  if (levels.has('direct') && levels.has('transitive')) {
    return 'mixed';
  }
  if (levels.has('direct')) {
    return 'direct';
  }
  if (levels.has('transitive')) {
    return 'transitive';
  }
  return 'unknown';
}

function validateDirectPackageListing(evaluations: ProjectEvaluation[], entries: PackageListEntry[]): void {
  const resolvedPackageIds = new Set(entries.filter((entry) => entry.packageLevel === 'direct').map((entry) => entry.id.toLowerCase()));
  const missingIds = Array.from(
    new Set(evaluations.flatMap((evaluation) => evaluation.packageReferences.map((item) => item.identity.toLowerCase())))
  ).filter((id) => !resolvedPackageIds.has(id));
  if (missingIds.length > 0) {
    throw new Error(`No resolved package data was returned for ${missingIds.join(', ')}. Restore the project to show installed versions and transitive packages.`);
  }
}

function mergeResolvedPackages(packages: InstalledPackage[], entries: PackageListEntry[]): InstalledPackage[] {
  const packagesById = new Map(packages.map((item) => [item.id.toLowerCase(), item]));
  for (const item of entries) {
    const key = item.id.toLowerCase();
    let installedPackage = packagesById.get(key);
    if (!installedPackage) {
      installedPackage = {
        id: item.id,
        version: item.version,
        versionSource: 'unknown',
        packageLevel: item.packageLevel,
        targetFrameworkVersions: [],
      };
      packagesById.set(key, installedPackage);
      packages.push(installedPackage);
    }

    const frameworkVersion = installedPackage.targetFrameworkVersions?.find(
      (entry) => entry.targetFramework.toLowerCase() === item.targetFramework.toLowerCase()
    );
    if (frameworkVersion) {
      frameworkVersion.version = item.version;
      frameworkVersion.packageLevel = item.packageLevel;
    } else {
      installedPackage.targetFrameworkVersions ??= [];
      installedPackage.targetFrameworkVersions.push({
        targetFramework: item.targetFramework,
        version: item.version,
        versionSource: installedPackage.versionSource ?? 'unknown',
        packageLevel: item.packageLevel,
        versionFilePath: installedPackage.versionFilePath,
      });
    }
  }

  return packages.map((item) => {
    const versions = item.targetFrameworkVersions ?? [];
    const uniqueVersions = new Set(versions.map((entry) => entry.version));
    item.version = uniqueVersions.size === 1 ? versions[0].version : uniqueVersions.size > 1 ? 'Varies by target framework' : item.version;
    item.packageLevel = packageLevelFor(versions);
    return item;
  });
}

export default class ProjectFileLoader {
  public constructor(
    private readonly evaluate: ProjectEvaluationRunner = runMsbuildEvaluation,
    private readonly listPackages: ProjectPackageLister = runPackageList
  ) {}

  public async loadProjectAsync(projectFilePath: string): Promise<Project> {
    const fullPath = path.resolve(projectFilePath);
    const initialEvaluation = await this.evaluate(fullPath);
    const targetFrameworks = (initialEvaluation.targetFrameworks ?? initialEvaluation.targetFramework ?? '')
      .split(';')
      .map((framework) => framework.trim())
      .filter((framework) => framework.length > 0);

    const evaluations: ProjectEvaluation[] = [];
    if (targetFrameworks.length > 0) {
      for (const targetFramework of targetFrameworks) {
        evaluations.push(await this.evaluate(fullPath, targetFramework));
      }
    } else {
      evaluations.push(initialEvaluation);
    }

    let packages = mergePackages(evaluations);
    let packageListWarning: string | undefined;
    try {
      const packageList = parsePackageList(await this.listPackages(fullPath));
      validateDirectPackageListing(evaluations, packageList);
      packages = mergeResolvedPackages(packages, packageList);
    } catch (error) {
      packageListWarning = error instanceof Error ? error.message : String(error);
    }

    return {
      name: path.basename(fullPath),
      fsPath: fullPath,
      packages,
      targetFrameworks,
      managePackageVersionsCentrally: initialEvaluation.managePackageVersionsCentrally,
      packageListWarning,
    };
  }
}
