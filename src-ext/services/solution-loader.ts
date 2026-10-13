import * as path from 'path';
import { Project, ProjectLoadFailure, Solution } from '../../src-common/models/project';
import ProjectFileLoader from './project-file-loader';
import { executeDotnet } from './dotnet-cli';

type ProjectLoader = Pick<ProjectFileLoader, 'loadProjectAsync'>;
export type SolutionProjectLister = (solutionFilePath: string) => Promise<string>;

const supportedProjectExtensions = new Set(['.csproj', '.vbproj', '.fsproj']);

function runSolutionList(solutionFilePath: string): Promise<string> {
  return executeDotnet(['sln', solutionFilePath, 'list'], path.dirname(solutionFilePath), `Project enumeration for "${solutionFilePath}"`);
}

function parseProjectPaths(output: string): string[] {
  if (/^\s*No projects found in (the )?solution\.?\s*$/im.test(output)) {
    return [];
  }

  const lines = output.split(/\r?\n/);
  const separatorIndex = lines.findIndex((line) => /^-{3,}\s*$/.test(line));
  if (separatorIndex < 0) {
    throw new Error(`Could not parse project list returned for the solution: ${output.trim()}`);
  }

  return lines
    .slice(separatorIndex + 1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class SolutionLoader {
  public constructor(
    private readonly projectLoader: ProjectLoader = new ProjectFileLoader(),
    private readonly listProjects: SolutionProjectLister = runSolutionList
  ) {}

  public async loadSolutionAsync(solutionFilePath: string): Promise<Solution> {
    const fullPath = path.resolve(solutionFilePath);
    const listedPaths = parseProjectPaths(await this.listProjects(fullPath));
    const projects: Project[] = [];
    const unsupportedProjects: string[] = [];
    const loadFailures: ProjectLoadFailure[] = [];

    for (const listedPath of listedPaths) {
      const projectPath = path.resolve(path.dirname(fullPath), listedPath);
      if (!supportedProjectExtensions.has(path.extname(projectPath).toLowerCase())) {
        unsupportedProjects.push(projectPath);
        continue;
      }

      try {
        projects.push(await this.projectLoader.loadProjectAsync(projectPath));
      } catch (error) {
        loadFailures.push({
          projectPath,
          message: errorMessage(error),
        });
      }
    }

    return {
      name: path.basename(fullPath, path.extname(fullPath)),
      fsPath: fullPath,
      projects,
      unsupportedProjects,
      loadFailures,
    };
  }
}
