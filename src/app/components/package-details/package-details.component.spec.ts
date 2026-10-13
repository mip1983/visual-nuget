import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { PackageRowModel } from '../../models/package-row-model';
import { Solution } from '../../../../src-common/models/project';
import { PackageManagerService } from '../../services/package-manager.service';
import { PackageDetailsComponent } from './package-details.component';

describe('PackageDetailsComponent', () => {
  let fixture: ComponentFixture<PackageDetailsComponent>;
  let selectedPackage: BehaviorSubject<PackageRowModel | null>;
  let selectedPackageId: BehaviorSubject<string | null>;

  beforeEach(async () => {
    selectedPackage = new BehaviorSubject<PackageRowModel | null>(null);
    selectedPackageId = new BehaviorSubject<string | null>(null);
    const packageManagerMock = {
      currentSelectedPackage: selectedPackage,
      currentSelectedPackageId: selectedPackageId,
      currentSolution: new BehaviorSubject<Solution | null>(null),
      selectedProjectsForPackage: jest.fn(() => []),
    };

    await TestBed.configureTestingModule({
      declarations: [PackageDetailsComponent],
      providers: [{ provide: PackageManagerService, useValue: packageManagerMock }],
    })
      .overrideComponent(PackageDetailsComponent, { set: { template: '' } })
      .compileComponents();

    fixture = TestBed.createComponent(PackageDetailsComponent);
    fixture.detectChanges();
  });

  test('shows loading while package details are pending', () => {
    selectedPackageId.next('Example.Package');
    expect(fixture.componentInstance.isLoading).toBe(true);

    selectedPackage.next(createPackage());
    expect(fixture.componentInstance.isLoading).toBe(false);

    selectedPackageId.next(null);
    selectedPackage.next(null);
    expect(fixture.componentInstance.isLoading).toBe(false);
  });
});

function createPackage(): PackageRowModel {
  return {
    id: 'Example.Package',
    version: '1.0.0',
    description: '',
    authors: [],
    iconUrl: '',
    totalDownloads: undefined,
    verified: false,
    installedVersion: '',
    isInstalled: false,
    isOutdated: false,
    sourceUrl: '',
    versions: [],
  };
}
