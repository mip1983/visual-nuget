import * as path from 'path';
import ProjectFileLoader from './project-file-loader';

describe('ProjectFileLoader', () => {
  it('loads central versions, overrides, imports, and framework-specific versions from MSBuild evaluation', async () => {
    const projectPath = path.resolve(__dirname, '..', 'test-fixtures', 'cpm', 'CpmApp', 'CpmApp.csproj');
    const listPackages = jest.fn().mockResolvedValue(
      JSON.stringify({
        version: 1,
        projects: [
          {
            path: projectPath,
            frameworks: [
              {
                framework: 'net9.0',
                topLevelPackages: [
                  { id: 'Azure.Identity', resolvedVersion: '1.19.0' },
                  { id: 'Microsoft.Extensions.Http', resolvedVersion: '10.0.12' },
                  { id: 'Newtonsoft.Json', resolvedVersion: '13.0.4' },
                  { id: 'System.Memory.Data', resolvedVersion: '10.0.11' },
                  { id: 'System.Text.Json', resolvedVersion: '10.0.11' },
                  { id: 'Azure.Core', resolvedVersion: '1.62.0' },
                ],
                transitivePackages: [{ id: 'System.ClientModel', resolvedVersion: '1.15.0' }],
              },
              {
                framework: 'net10.0',
                topLevelPackages: [
                  { id: 'Azure.Identity', resolvedVersion: '1.19.0' },
                  { id: 'Microsoft.Extensions.Http', resolvedVersion: '10.0.12' },
                  { id: 'Newtonsoft.Json', resolvedVersion: '13.0.4' },
                  { id: 'System.Memory.Data', resolvedVersion: '10.0.11' },
                  { id: 'System.Text.Json', resolvedVersion: '10.0.12' },
                  { id: 'Azure.Core', resolvedVersion: '1.62.0' },
                ],
                transitivePackages: [{ id: 'System.ClientModel', resolvedVersion: '1.15.0' }],
              },
            ],
          },
        ],
      })
    );
    const project = await new ProjectFileLoader(undefined, listPackages).loadProjectAsync(projectPath);

    expect(project.targetFrameworks).toEqual(['net9.0', 'net10.0']);
    expect(project.managePackageVersionsCentrally).toBe(true);
    expect(project.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'Microsoft.Extensions.Http',
          version: '10.0.12',
          packageLevel: 'direct',
          versionSource: 'central',
          targetFrameworkVersions: expect.arrayContaining([
            expect.objectContaining({ targetFramework: 'net9.0', version: '10.0.12', versionSource: 'central' }),
            expect.objectContaining({ targetFramework: 'net10.0', version: '10.0.12', versionSource: 'central' }),
          ]),
        }),
        expect.objectContaining({
          id: 'Azure.Identity',
          version: '1.19.0',
          versionSource: 'central',
          versionFilePath: expect.stringMatching(/(?:^|[\\/])ImportedVersions\.props$/i),
        }),
        expect.objectContaining({
          id: 'Azure.Core',
          version: '1.62.0',
          versionSource: 'override',
        }),
        expect.objectContaining({
          id: 'System.Text.Json',
          version: 'Varies by target framework',
          packageLevel: 'direct',
          versionSource: 'central',
          targetFrameworkVersions: expect.arrayContaining([
            expect.objectContaining({ targetFramework: 'net9.0', version: '10.0.11' }),
            expect.objectContaining({ targetFramework: 'net10.0', version: '10.0.12' }),
          ]),
        }),
      ])
    );
    expect(project.packages).toContainEqual(
      expect.objectContaining({
        id: 'System.ClientModel',
        version: '1.15.0',
        packageLevel: 'transitive',
        targetFrameworkVersions: expect.arrayContaining([
          expect.objectContaining({ targetFramework: 'net9.0', packageLevel: 'transitive' }),
          expect.objectContaining({ targetFramework: 'net10.0', packageLevel: 'transitive' }),
        ]),
      })
    );
    expect(project.packageListWarning).toBeUndefined();
  }, 30_000);

  it('keeps evaluated direct packages and reports when restore graph data is unavailable', async () => {
    const projectPath = path.resolve(__dirname, '..', 'test-fixtures', 'cpm', 'CpmApp', 'CpmApp.csproj');
    const evaluation = {
      targetFrameworks: 'net9.0',
      managePackageVersionsCentrally: true,
      packageReferences: [{ identity: 'Microsoft.Extensions.Http' }],
      packageVersions: [{ identity: 'Microsoft.Extensions.Http', version: '10.0.12' }],
    };
    const project = await new ProjectFileLoader(
      async () => evaluation,
      async () => {
        throw new Error('assets file is missing');
      }
    ).loadProjectAsync(projectPath);

    expect(project.packages).toContainEqual(
      expect.objectContaining({ id: 'Microsoft.Extensions.Http', version: '10.0.12', versionSource: 'central' })
    );
    expect(project.packageListWarning).toContain('assets file is missing');
  });
});
