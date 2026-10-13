import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { Category } from '../../models/category';
import { PackageRowModel, SolutionProjectPackageState } from '../../models/package-row-model';
import { PackageLevel, Solution } from '../../../../src-common/models/project';
import { PackageManagerService } from '../../services/package-manager.service';
import { PackageListComponent } from './package-list.component';

describe('PackageListComponent', () => {
  let fixture: ComponentFixture<PackageListComponent>;
  let category: BehaviorSubject<Category>;

  beforeEach(async () => {
    category = new BehaviorSubject<Category>(Category.Browse);
    const packageManagerMock = {
      currentPackages: new BehaviorSubject<PackageRowModel[] | null>([]),
      currentSelectedPackageId: new BehaviorSubject<string | null>(null),
      currentCategory: category,
      currentSolution: new BehaviorSubject<Solution | null>(null),
      installPackages: jest.fn(),
    };

    await TestBed.configureTestingModule({
      declarations: [PackageListComponent],
      providers: [{ provide: PackageManagerService, useValue: packageManagerMock }],
    })
      .overrideComponent(PackageListComponent, { set: { template: '' } })
      .compileComponents();

    fixture = TestBed.createComponent(PackageListComponent);
    fixture.detectChanges();
  });

  test('groups Installed packages by direct or transitive usage', () => {
    const directPackage = createPackage('Direct.Package', 'direct');
    const transitivePackage = createPackage('Transitive.Package', 'transitive');
    const mixedSolutionPackage = createPackage('Mixed.Package', 'mixed', [
      createProjectState(true, 'direct'),
      createProjectState(true, 'transitive'),
    ]);
    const transitiveSolutionPackage = createPackage('Solution.Transitive', 'transitive', [
      createProjectState(true, 'transitive'),
      createProjectState(false, undefined),
    ]);
    const unknownPackage = createPackage('Unknown.Package', 'unknown', [createProjectState(true, 'unknown')]);

    fixture.componentInstance.packages = [
      directPackage,
      transitivePackage,
      mixedSolutionPackage,
      transitiveSolutionPackage,
      unknownPackage,
    ];
    category.next(Category.Installed);

    expect(fixture.componentInstance.showTransitivePackages).toBe(true);
    expect(fixture.componentInstance.topLevelPackages).toEqual([directPackage, mixedSolutionPackage, unknownPackage]);
    expect(fixture.componentInstance.transitivePackages).toEqual([transitivePackage, transitiveSolutionPackage]);
  });

  test('does not group Browse packages', () => {
    expect(fixture.componentInstance.showTransitivePackages).toBe(false);
  });

  test('shows bulk update selection in solution mode', () => {
    fixture.componentInstance.packages = [createPackage('Direct.Package', 'direct')];
    fixture.componentInstance.isSolution = true;
    category.next(Category.Updates);

    expect(fixture.componentInstance.showSelectCheckboxes).toBe(true);
  });
});

function createPackage(
  id: string,
  packageLevel: PackageLevel,
  solutionProjectStates?: SolutionProjectPackageState[]
): PackageRowModel {
  return {
    id,
    version: '1.0.0',
    description: '',
    authors: [],
    iconUrl: '',
    totalDownloads: undefined,
    verified: false,
    installedVersion: '1.0.0',
    isInstalled: true,
    isOutdated: false,
    sourceUrl: '',
    packageLevel,
    versions: undefined,
    solutionProjectStates,
  };
}

function createProjectState(isInstalled: boolean, packageLevel: PackageLevel | undefined): SolutionProjectPackageState {
  return {
    projectPath: 'project.csproj',
    projectName: 'project',
    isInstalled,
    installedVersion: isInstalled ? '1.0.0' : '',
    packageLevel,
  };
}
