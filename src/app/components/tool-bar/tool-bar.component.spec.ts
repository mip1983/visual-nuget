import { UntypedFormBuilder } from '@angular/forms';
import { BehaviorSubject } from 'rxjs';

import { PackageSource } from '../../../../src-common/models/package-source';
import { Project, Solution } from '../../../../src-common/models/project';
import { Category } from '../../models/category';
import { PackageManagerService } from '../../services/package-manager.service';
import { VscodeService } from '../../services/vscode.service';
import { ToolBarComponent } from './tool-bar.component';

describe('ToolBarComponent', () => {
  test('refreshes the active package query when project or solution state reloads', () => {
    const source: PackageSource = { name: 'Test feed', url: 'https://example.test/v3/index.json', authorizationHeader: undefined };
    const packageManagerMock = {
      currentSources: new BehaviorSubject<PackageSource[]>([source]),
      currentCategory: new BehaviorSubject<Category>(Category.Updates),
      currentProject: new BehaviorSubject<Project | null>(null),
      currentSolution: new BehaviorSubject<Solution | null>(null),
      queryForPackages: jest.fn(),
    };
    const component = new ToolBarComponent(
      packageManagerMock as unknown as PackageManagerService,
      new UntypedFormBuilder(),
      { postMessage: jest.fn() } as unknown as VscodeService
    );

    component.ngOnInit();
    const project: Project = { name: 'Test project', fsPath: 'Test.csproj', packages: [] };
    packageManagerMock.currentProject.next(project);
    packageManagerMock.currentSolution.next({
      name: 'Test solution',
      fsPath: 'Test.slnx',
      projects: [project],
      unsupportedProjects: [],
      loadFailures: [],
    });

    expect(packageManagerMock.currentCategory.value).toBe(Category.Updates);
    expect(packageManagerMock.queryForPackages).toHaveBeenLastCalledWith('', false, source);
    expect(packageManagerMock.queryForPackages).toHaveBeenCalledTimes(3);

    component.ngOnDestroy();
  });
});
