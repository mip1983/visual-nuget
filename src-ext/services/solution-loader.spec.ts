import * as path from 'path';
import { Project } from '../../src-common/models/project';
import ProjectFileLoader from './project-file-loader';
import SolutionLoader, { SolutionProjectLister } from './solution-loader';

describe('SolutionLoader', () => {
  it('loads supported projects from an SLNX list and reports unsupported projects', async () => {
    const solutionPath = path.resolve('workspace', 'Sample.slnx');
    const projectPath = path.resolve('workspace', 'src', 'App.csproj');
    const project: Project = {
      name: 'App.csproj',
      fsPath: projectPath,
      packages: [],
    };
    const projectLoader: Pick<ProjectFileLoader, 'loadProjectAsync'> = {
      loadProjectAsync: jest.fn().mockResolvedValue(project),
    };
    const listProjects: SolutionProjectLister = jest.fn().mockResolvedValue(
      ['Project(s)', '----------', 'src\\App.csproj', 'tools\\Legacy.proj', ''].join('\n')
    );
    const loader = new SolutionLoader(projectLoader, listProjects);

    const solution = await loader.loadSolutionAsync(solutionPath);

    expect(listProjects).toHaveBeenCalledWith(solutionPath);
    expect(projectLoader.loadProjectAsync).toHaveBeenCalledWith(projectPath);
    expect(solution.projects).toEqual([project]);
    expect(solution.unsupportedProjects).toEqual([path.resolve('workspace', 'tools', 'Legacy.proj')]);
    expect(solution.loadFailures).toEqual([]);
  });

  it('returns an empty project list for an empty solution', async () => {
    const loader = new SolutionLoader(undefined, async () => 'No projects found in the solution.');

    await expect(loader.loadSolutionAsync('Empty.slnx')).resolves.toMatchObject({ projects: [], unsupportedProjects: [], loadFailures: [] });
  });

  it('continues loading other projects when one project cannot be evaluated', async () => {
    const projectLoader: Pick<ProjectFileLoader, 'loadProjectAsync'> = {
      loadProjectAsync: jest.fn().mockRejectedValueOnce(new Error('MSBuild evaluation failed')).mockResolvedValueOnce({
        name: 'Good.csproj',
        fsPath: path.resolve('Good.csproj'),
        packages: [],
      }),
    };
    const loader = new SolutionLoader(projectLoader, async () => ['Project(s)', '----------', 'Bad.csproj', 'Good.csproj'].join('\n'));

    const solution = await loader.loadSolutionAsync('Sample.slnx');

    expect(solution.projects.map((project) => project.name)).toEqual(['Good.csproj']);
    expect(solution.loadFailures).toEqual([{ projectPath: path.resolve('Bad.csproj'), message: 'MSBuild evaluation failed' }]);
  });

  it('uses the dotnet SLNX project list for the CPM fixture', async () => {
    const solutionPath = path.resolve(__dirname, '..', 'test-fixtures', 'cpm', 'CpmFixture.slnx');
    const solution = await new SolutionLoader().loadSolutionAsync(solutionPath);

    expect(solution.projects.map((project) => path.basename(project.fsPath))).toEqual(['CpmApp.csproj']);
    expect(solution.projects[0].packages.find((item) => item.id === 'Microsoft.Extensions.Http')?.version).toBe('10.0.12');
  }, 30_000);
});
