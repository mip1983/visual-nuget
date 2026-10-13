import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';

import { PackageSource } from '../../../src-common/models/package-source';
import { ApiIndexResponse } from '../models/api-index-response';
import { CatalogEntry, PackageMetaResponse, RegistrationLeaf, RegistrationPage } from '../models/package-meta';
import { SearchResults } from '../models/search-results';
import { NuGetApiService } from './nuget-api.service';

describe('NuGetApiService', () => {
  let service: NuGetApiService;
  let http: HttpTestingController;
  const source: PackageSource = {
    name: 'Private feed',
    url: 'https://packages.example.test/v3/index.json',
    authorizationHeader: 'Bearer test-token',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [NuGetApiService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(NuGetApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  test('search_prefersVersionedEndpoint_andMapsResultsFromTheSelectedSource', async () => {
    const result = firstValueFrom(service.search('widget', false, source));
    const indexRequest = http.expectOne(source.url);
    expect(indexRequest.request.headers.get('authorization')).toBe(source.authorizationHeader);
    indexRequest.flush(
      apiIndex([
        ['SearchQueryService', 'https://packages.example.test/v3/search/'],
        ['SearchQueryService/Versioned', 'https://packages.example.test/v3/search-versioned/'],
      ])
    );

    const searchRequest = http.expectOne((request) => request.url === 'https://packages.example.test/v3/search-versioned/');
    expect(searchRequest.request.params.get('q')).toBe('widget');
    expect(searchRequest.request.params.get('prerelease')).toBe('false');
    expect(searchRequest.request.params.get('semVerLevel')).toBe('2.0.0');
    expect(searchRequest.request.headers.get('authorization')).toBe(source.authorizationHeader);
    searchRequest.flush({
      totalHits: 1,
      data: [
        {
          id: 'Widget.Package',
          version: '2.1.0',
          description: 'A widget package',
          authors: ['Ada'],
          iconUrl: 'https://packages.example.test/icon.png',
          totalDownloads: 42,
          verified: true,
          vulnerabilities: [{ advisoryUrl: 'https://advisories.example.test/widget', severity: 3 }],
          deprecation: {
            message: 'Use Widget.Next instead.',
            reasons: ['Legacy'],
            alternatePackage: { id: 'Widget.Next', range: '[2.0.0, )' },
          },
        },
      ],
    } satisfies SearchResults);

    await expect(result).resolves.toEqual([
      {
        id: 'Widget.Package',
        version: '2.1.0',
        description: 'A widget package',
        authors: ['Ada'],
        iconUrl: 'https://packages.example.test/icon.png',
        totalDownloads: 42,
        verified: true,
        isInstalled: false,
        installedVersion: '',
        isOutdated: false,
        sourceUrl: source.url,
        versions: undefined,
        vulnerabilities: [{ advisoryUrl: 'https://advisories.example.test/widget', severity: 3 }],
        deprecation: {
          message: 'Use Widget.Next instead.',
          reasons: ['Legacy'],
          alternatePackage: { id: 'Widget.Next', range: '[2.0.0, )' },
        },
      },
    ]);
  });

  test('search_fallsBackToSupportedEndpointVersions_andSendsPrereleaseFlag', async () => {
    const result = firstValueFrom(service.search('', true, source));
    http.expectOne(source.url).flush(
      apiIndex([
        ['SearchQueryService/3.5.0', 'https://packages.example.test/v3/search-350/'],
        ['SearchQueryService', 'https://packages.example.test/v3/search/'],
      ])
    );

    const searchRequest = http.expectOne((request) => request.url === 'https://packages.example.test/v3/search-350/');
    expect(searchRequest.request.params.get('prerelease')).toBe('true');
    searchRequest.flush({ totalHits: 0, data: [] } satisfies SearchResults);

    await expect(result).resolves.toEqual([]);
  });

  test('search_serviceIndexFailurePropagatesWithoutCallingSearchEndpoint', async () => {
    const result = firstValueFrom(service.search('widget', false, source));
    http.expectOne(source.url).flush({ message: 'Feed unavailable' }, { status: 503, statusText: 'Service Unavailable' });

    await expect(result).rejects.toMatchObject({ status: 503 });
    http.expectNone('https://packages.example.test/v3/search/');
  });

  test('search_withoutSupportedEndpoint_rejectsInsteadOfRequestingAnEmptyUrl', async () => {
    const result = firstValueFrom(service.search('widget', false, source));
    http.expectOne(source.url).flush(apiIndex([['PackagePublish/2.0.0', 'https://packages.example.test/publish/']]));

    await expect(result).rejects.toThrow('The package source does not provide a supported search endpoint.');
    http.expectNone('');
  });

  test('searchByPackageIds_withoutSupportedEndpoint_rejectsInsteadOfRequestingAnEmptyUrl', async () => {
    const result = firstValueFrom(service.searchByPackageIds(['Widget.Package'], '', false, source));
    http.expectOne(source.url).flush(apiIndex([['PackagePublish/2.0.0', 'https://packages.example.test/publish/']]));

    await expect(result).rejects.toThrow('The package source does not provide a supported registration endpoint.');
    http.expectNone('');
  });

  test('searchByPackageIds_serviceIndexFailurePropagatesWithoutCallingRegistration', async () => {
    const result = firstValueFrom(service.searchByPackageIds(['Widget.Package'], '', false, source));
    http.expectOne(source.url).flush({ message: 'Feed unavailable' }, { status: 503, statusText: 'Service Unavailable' });

    await expect(result).rejects.toMatchObject({ status: 503 });
    http.expectNone('https://packages.example.test/v3/registration/widget.package/index.json');
  });

  test('searchByPackageIds_usesInlineRegistrationAndFiltersVersions', async () => {
    const result = firstValueFrom(service.searchByPackageIds(['Widget.Package'], 'widget', false, source));
    http.expectOne(source.url).flush(registrationIndex());
    const metadataRequest = http.expectOne('https://packages.example.test/v3/registration/widget.package/index.json');
    expect(metadataRequest.request.headers.get('authorization')).toBe(source.authorizationHeader);
    metadataRequest.flush(
      registration([
        catalogEntry('1.0.0', { listed: false }),
        catalogEntry('1.1.0-beta.1'),
        catalogEntry('1.0.9'),
        catalogEntry('1.2.0', {
          vulnerabilities: [{ advisoryUrl: 'https://advisories.example.test/widget', severity: 2 }],
          deprecation: { reasons: ['Other'], message: 'Use Widget.Next instead.' },
        }),
      ])
    );

    const packages = await result;
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      id: 'Widget.Package',
      version: '1.2.0',
      sourceUrl: source.url,
      vulnerabilities: [{ advisoryUrl: 'https://advisories.example.test/widget', severity: 2 }],
      deprecation: { reasons: ['Other'], message: 'Use Widget.Next instead.' },
      versions: [expect.objectContaining({ version: '1.2.0' }), expect.objectContaining({ version: '1.0.9' })],
    });
  });

  test('searchByPackageIds_fetchesPagedRegistrationWithAuthorization', async () => {
    const result = firstValueFrom(service.searchByPackageIds(['Widget.Package'], '', true, source));
    http.expectOne(source.url).flush(registrationIndex());
    http
      .expectOne('https://packages.example.test/v3/registration/widget.package/index.json')
      .flush({
        count: 1,
        items: [{ '@id': 'https://packages.example.test/v3/registration/widget.package/page.json', count: 1, items: undefined }],
      } satisfies PackageMetaResponse);

    const pageRequest = http.expectOne('https://packages.example.test/v3/registration/widget.package/page.json');
    expect(pageRequest.request.headers.get('authorization')).toBe(source.authorizationHeader);
    pageRequest.flush({
      '@id': 'https://packages.example.test/v3/registration/widget.package/page.json',
      count: 1,
      items: [registrationLeaf(catalogEntry('3.0.0-beta.1'))],
    } satisfies RegistrationPage);

    await expect(result).resolves.toEqual([
      expect.objectContaining({
        id: 'Widget.Package',
        version: '3.0.0-beta.1',
        versions: [expect.objectContaining({ version: '3.0.0-beta.1' })],
      }),
    ]);
  });

  test('searchByPackageIds_pagedRegistrationFailurePropagates', async () => {
    const result = firstValueFrom(service.searchByPackageIds(['Widget.Package'], '', false, source));
    http.expectOne(source.url).flush(registrationIndex());
    http
      .expectOne('https://packages.example.test/v3/registration/widget.package/index.json')
      .flush({
        count: 1,
        items: [{ '@id': 'https://packages.example.test/v3/registration/widget.package/page.json', count: 1, items: undefined }],
      } satisfies PackageMetaResponse);
    http.expectOne('https://packages.example.test/v3/registration/widget.package/page.json').flush(
      { message: 'Gateway failure' },
      { status: 502, statusText: 'Bad Gateway' }
    );

    await expect(result).rejects.toMatchObject({ status: 502 });
  });

  test('searchByPackageIds_emptyPagedRegistrationPageReturnsNoPackages', async () => {
    const result = firstValueFrom(service.searchByPackageIds(['Empty.Page.Package'], '', false, source));
    http.expectOne(source.url).flush(registrationIndex());
    http
      .expectOne('https://packages.example.test/v3/registration/empty.page.package/index.json')
      .flush({
        count: 1,
        items: [
          {
            '@id': 'https://packages.example.test/v3/registration/empty.page.package/page.json',
            count: 1,
            items: undefined,
          },
        ],
      } satisfies PackageMetaResponse);
    http
      .expectOne('https://packages.example.test/v3/registration/empty.page.package/page.json')
      .flush({
        '@id': 'https://packages.example.test/v3/registration/empty.page.package/page.json',
        count: 1,
        items: undefined,
      } satisfies RegistrationPage);

    await expect(result).resolves.toEqual([]);
  });

  test('searchByPackageIds_returnsEmptyForNoIdsOrEmptyRegistration', async () => {
    await expect(firstValueFrom(service.searchByPackageIds([], '', false, source))).resolves.toEqual([]);
    http.expectNone(source.url);

    const result = firstValueFrom(service.searchByPackageIds(['Empty.Package'], '', false, source));
    http.expectOne(source.url).flush(registrationIndex());
    http
      .expectOne('https://packages.example.test/v3/registration/empty.package/index.json')
      .flush({ count: 0, items: [] } satisfies PackageMetaResponse);

    await expect(result).resolves.toEqual([]);
  });

  test('searchByPackageIds_ignoresNotFoundPackagesButPropagatesFeedFailures', async () => {
    const missingResult = firstValueFrom(service.searchByPackageIds(['Missing.Package'], '', false, source));
    http.expectOne(source.url).flush(registrationIndex());
    http.expectOne('https://packages.example.test/v3/registration/missing.package/index.json').flush(
      { message: 'Not found' },
      { status: 404, statusText: 'Not Found' }
    );
    await expect(missingResult).resolves.toEqual([]);

    const failedResult = firstValueFrom(service.searchByPackageIds(['Unavailable.Package'], '', false, source));
    http.expectOne(source.url).flush(registrationIndex());
    http.expectOne('https://packages.example.test/v3/registration/unavailable.package/index.json').flush(
      { message: 'Service unavailable' },
      { status: 503, statusText: 'Service Unavailable' }
    );
    await expect(failedResult).rejects.toMatchObject({ status: 503 });
  });

  test('searchByPackageIds_usesQueryAgainstPackageIdAndDescription', async () => {
    const result = firstValueFrom(service.searchByPackageIds(['Other.Package', 'Widget.Package'], 'widget', false, source));
    http.expectOne(source.url).flush(registrationIndex());
    const otherMetadata = http.expectOne('https://packages.example.test/v3/registration/other.package/index.json');
    const widgetMetadata = http.expectOne('https://packages.example.test/v3/registration/widget.package/index.json');
    otherMetadata.flush(registration([catalogEntry('1.0.0', { description: 'A library for strings' })]));
    widgetMetadata.flush(registration([catalogEntry('1.0.0', { description: 'Widget support' })]));

    await expect(result).resolves.toEqual([
      expect.objectContaining({ id: 'Widget.Package', description: 'Widget support' }),
    ]);
  });

  test('searchByPackageIds_keepsPackagesWithMissingDescriptionsAndFiltersById', async () => {
    const result = firstValueFrom(service.searchByPackageIds(['Widget.Package'], 'widget', false, source));
    http.expectOne(source.url).flush(registrationIndex());
    http
      .expectOne('https://packages.example.test/v3/registration/widget.package/index.json')
      .flush(registration([catalogEntry('1.0.0', { description: undefined })]));

    await expect(result).resolves.toEqual([
      expect.objectContaining({ id: 'Widget.Package', description: '' }),
    ]);
  });
});

function apiIndex(resources: [string, string][]): ApiIndexResponse {
  return { resources: resources.map(([type, id]) => ({ '@type': type, '@id': id })) };
}

function registrationIndex(): ApiIndexResponse {
  return apiIndex([['RegistrationsBaseUrl/Versioned', 'https://packages.example.test/v3/registration/']]);
}

function registration(entries: CatalogEntry[]): PackageMetaResponse {
  return {
    count: 1,
    items: [
      {
        '@id': 'https://packages.example.test/v3/registration/package/page.json',
        count: entries.length,
        items: entries.map(registrationLeaf),
      },
    ],
  };
}

function registrationLeaf(entry: CatalogEntry): RegistrationLeaf {
  return {
    '@id': `https://packages.example.test/v3/registration/package/${entry.version}.json`,
    catalogEntry: entry,
  };
}

function catalogEntry(
  version: string,
  overrides: Partial<CatalogEntry> = {}
): CatalogEntry {
  return {
    '@id': `https://packages.example.test/v3/catalog/package/${version}.json`,
    id: 'Widget.Package',
    version,
    description: 'A useful package',
    authors: ['Ada'],
    iconUrl: '',
    licenseUrl: '',
    projectUrl: '',
    tags: [],
    dependencyGroups: [],
    published: '2025-01-01T00:00:00Z',
    listed: true,
    vulnerabilities: undefined,
    ...overrides,
  };
}
