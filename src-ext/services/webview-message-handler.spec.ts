jest.mock('vscode', () => {
  const taskEndListeners: Array<(event: { execution: { task: unknown }; exitCode: number }) => void> = [];
  const taskExitCodes: number[] = [];
  const nodeFs = jest.requireActual<typeof import('node:fs')>('node:fs');

  class MockShellExecution {
    public constructor(
      public readonly command: string,
      public readonly args: Array<string | { value: string; quoting: number }>
    ) {}
  }

  class MockTask {
    public presentationOptions?: { reveal: number; focus?: boolean };

    public constructor(
      public readonly definition: { task: string },
      _scope: number,
      _name: string,
      _execution: string,
      public readonly taskExecution: MockShellExecution
    ) {}
  }

  return {
    Disposable: class {
      public dispose(): void {}
    },
    ShellExecution: MockShellExecution,
    ShellQuoting: { Strong: 1 },
    TaskRevealKind: { Never: 2 },
    Task: MockTask,
    TaskScope: { Workspace: 1 },
    tasks: {
      executeTask: jest.fn(async (task: MockTask) => {
        if (task.definition.task === 'add') {
          const projectArgument = task.taskExecution.args.find(
            (argument): argument is { value: string; quoting: number } =>
              typeof argument !== 'string' && argument.value.toLowerCase().endsWith('.csproj')
          );
          if (projectArgument) {
            nodeFs.writeFileSync(projectArgument.value, '<Project Updated />');
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        const exitCode = taskExitCodes.shift() ?? 0;
        taskEndListeners.forEach((listener) => listener({ execution: { task }, exitCode }));
        return { task };
      }),
      onDidEndTaskProcess: jest.fn((listener: (event: { execution: { task: unknown }; exitCode: number }) => void) => {
        taskEndListeners.push(listener);
        return {
          dispose: () => {
            const index = taskEndListeners.indexOf(listener);
            if (index >= 0) {
              taskEndListeners.splice(index, 1);
            }
          },
        };
      }),
    },
    workspace: {
      onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() })),
      textDocuments: [],
    },
    window: {
      showErrorMessage: jest.fn(),
      showInformationMessage: jest.fn(),
    },
    testHooks: { taskExitCodes },
  };
});

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExtensionMessage } from '../../src-common/models/extension-message';
import { Project } from '../../src-common/models/project';
import {
  InstallMessage,
  InstallPackageInProjectsMessage,
  RemovePackageFromProjectsMessage,
  RollbackPackageUpdateMessage,
  UIMessage,
  UpdatePackagesMessage,
} from '../../src-common/models/ui-message';
import WebviewMessageHandler from './webview-message-handler';

describe('WebviewMessageHandler package update batches', () => {
  let temporaryDirectory: string;
  let projectPath: string;
  let handler: WebviewMessageHandler;
  let receiveMessage: ((message: UIMessage) => void) | undefined;
  let messages: ExtensionMessage[];
  let waitForCompletion: (operationId: string) => Promise<void>;
  let webview: {
    onDidReceiveMessage: jest.Mock;
    postMessage: jest.Mock;
  };
  let waiters: Map<string, () => void>;

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-nuget-batch-'));
    projectPath = path.join(temporaryDirectory, 'Batch.csproj');
    await fs.writeFile(projectPath, '<Project />');

    const project: Project = {
      name: 'Batch',
      fsPath: projectPath,
      managePackageVersionsCentrally: false,
      packages: [
        { id: 'Package.One', version: '1.0.0', packageLevel: 'direct', versionFilePath: projectPath },
        { id: 'Package.Two', version: '1.0.0', packageLevel: 'direct', versionFilePath: projectPath },
      ],
    };
    const testHooks = vscode as unknown as { testHooks: { taskExitCodes: number[] } };
    testHooks.testHooks.taskExitCodes.length = 0;
    waiters = new Map<string, () => void>();
    messages = [];
    waitForCompletion = (operationId) =>
      new Promise((resolve) => {
        waiters.set(operationId, resolve);
      });

    webview = {
      onDidReceiveMessage: jest.fn((listener: (message: UIMessage) => void) => {
        receiveMessage = listener;
        return { dispose: jest.fn() };
      }),
      postMessage: jest.fn((message: ExtensionMessage) => {
        messages.push(message);
        if (message.type === 'operation-completed') {
          waiters.get(message.data.operationId)?.();
        }
        return Promise.resolve(true);
      }),
    };

    handler = new WebviewMessageHandler(webview as unknown as vscode.Webview, { type: 'project', filePath: projectPath });
    const privateHandler = handler as unknown as { solutionProjects: Map<string, Project>; loadContext: () => void };
    privateHandler.solutionProjects = new Map([[projectPath, project]]);
    jest.spyOn(privateHandler, 'loadContext').mockImplementation(() => {});
    (vscode.tasks.executeTask as jest.Mock).mockClear();
  });

  afterEach(async () => {
    handler.dispose();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  test('continues a solution update batch after failure and reports each project outcome', async () => {
    const projectPaths = ['ProjectA.csproj', 'ProjectB.csproj'].map((name) => path.join(temporaryDirectory, name));
    await Promise.all(projectPaths.map((projectPath) => fs.writeFile(projectPath, '<Project />')));
    const projects: Project[] = projectPaths.map((projectPath) => ({
      name: path.basename(projectPath),
      fsPath: projectPath,
      packages: [{ id: 'Package.Shared', version: '1.0.0', packageLevel: 'direct', versionFilePath: projectPath }],
    }));
    const solutionPath = path.join(temporaryDirectory, 'Sample.sln');
    configureSolutionHandler(solutionPath, projects);

    const testHooks = vscode as unknown as { testHooks: { taskExitCodes: number[] } };
    testHooks.testHooks.taskExitCodes.push(0, 1, 0);
    const operationId = 'solution-update-partial-failure';
    const completed = waitForCompletion(operationId);
    const request: UpdatePackagesMessage = {
      command: 'update-packages-batch',
      operationId,
      buildAfterRestore: false,
      updates: projectPaths.map((projectPath, index) => ({
        projectPaths: [projectPath],
        packageId: 'Package.Shared',
        packageVersion: `${index + 2}.0.0`,
        packageSourceUrl: 'https://packages.example/v3/index.json',
      })),
    };

    receiveMessage?.(request);
    await completed;

    const executedTasks = (vscode.tasks.executeTask as jest.Mock).mock.calls.map(
      ([task]) =>
        task as unknown as {
          definition: { task: string };
          taskExecution: { args: Array<string | { value: string; quoting: number }> };
        }
    );
    expect(executedTasks.map((task) => task.definition.task)).toEqual(['add', 'add', 'restore']);
    expect(executedTasks.slice(0, 2).every((task) => task.taskExecution.args.includes('--no-restore'))).toBe(true);
    expect(executedTasks[2].taskExecution.args[0]).toBe('restore');

    const operationResults = messages.filter((message) => message.type === 'operation-results').pop();
    expect(operationResults?.type).toBe('operation-results');
    if (operationResults?.type !== 'operation-results') {
      throw new Error('A solution batch should report project and restore outcomes.');
    }
    expect(operationResults.data.map((result) => [result.projectPath, result.operation, result.succeeded])).toEqual([
      [projectPaths[0], 'add', true],
      [projectPaths[1], 'add', false],
      [solutionPath, 'restore', true],
    ]);
    expect(operationResults.data[1].message).toContain('exited with code 1');
    expect(operationResults.rollbackId).toEqual(expect.any(String));
    expect(messages.filter((message) => message.type === 'operation-completed')).toHaveLength(1);
  });

  test('preserves solution CPM overrides and framework versions unless explicitly selected', async () => {
    const projectPaths = ['Override.csproj', 'Conditional.csproj'].map((name) => path.join(temporaryDirectory, name));
    await Promise.all(projectPaths.map((projectPath) => fs.writeFile(projectPath, '<Project />')));
    const centralFilePath = path.join(temporaryDirectory, 'Directory.Packages.props');
    const projects: Project[] = [
      {
        name: 'Override.csproj',
        fsPath: projectPaths[0],
        managePackageVersionsCentrally: true,
        packages: [
          {
            id: 'Package.Cpm',
            version: '1.0.0',
            versionSource: 'override',
            packageLevel: 'direct',
            versionFilePath: centralFilePath,
          },
        ],
      },
      {
        name: 'Conditional.csproj',
        fsPath: projectPaths[1],
        managePackageVersionsCentrally: true,
        packages: [
          {
            id: 'Package.Cpm',
            version: 'Varies by target framework',
            versionSource: 'central',
            packageLevel: 'direct',
            versionFilePath: centralFilePath,
            targetFrameworkVersions: [
              {
                targetFramework: 'net9.0',
                version: '1.0.0',
                versionSource: 'central',
                packageLevel: 'direct',
                condition: "'$(TargetFramework)' == 'net9.0'",
              },
              {
                targetFramework: 'net10.0',
                version: '2.0.0',
                versionSource: 'central',
                packageLevel: 'direct',
                condition: "'$(TargetFramework)' == 'net10.0'",
              },
            ],
          },
        ],
      },
    ];
    configureSolutionHandler(path.join(temporaryDirectory, 'Sample.sln'), projects);

    const defaultOperationId = 'preserve-cpm-exceptions';
    const defaultCompleted = waitForCompletion(defaultOperationId);
    const defaultRequest: InstallPackageInProjectsMessage = {
      command: 'add-package-to-projects',
      operationId: defaultOperationId,
      projectPaths,
      packageId: 'Package.Cpm',
      packageVersion: '3.0.0',
      packageSourceUrl: 'https://packages.example/v3/index.json',
    };
    receiveMessage?.(defaultRequest);
    await defaultCompleted;

    const skippedResults = messages.filter((message) => message.type === 'operation-results').pop();
    expect(skippedResults?.type).toBe('operation-results');
    if (skippedResults?.type !== 'operation-results') {
      throw new Error('CPM exception decisions should be reported.');
    }
    expect(skippedResults.data.map((result) => [result.projectPath, result.succeeded, result.skipped])).toEqual([
      [projectPaths[0], false, true],
      [projectPaths[1], false, true],
    ]);
    expect(skippedResults.data.every((result) => result.message?.includes('preserve'))).toBe(true);
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();

    const selectedOperationId = 'update-cpm-exceptions';
    const selectedCompleted = waitForCompletion(selectedOperationId);
    const selectedRequest: InstallPackageInProjectsMessage = {
      ...defaultRequest,
      operationId: selectedOperationId,
      includeCpmExceptions: true,
    };
    receiveMessage?.(selectedRequest);
    await selectedCompleted;

    const executedTasks = (vscode.tasks.executeTask as jest.Mock).mock.calls.map(
      ([task]) =>
        task as unknown as {
          taskExecution: { args: Array<string | { value: string; quoting: number }> };
        }
    );
    expect(executedTasks).toHaveLength(2);
    expect(executedTasks.map((task) => task.taskExecution.args.slice(0, 6))).toEqual([
      ['package', 'add', 'Package.Cpm', '--version', '3.0.0', '--project'],
      ['package', 'add', 'Package.Cpm', '--version', '3.0.0', '--project'],
    ]);
    expect(executedTasks.map((task) => task.taskExecution.args[6])).toEqual([
      { value: projectPaths[0], quoting: vscode.ShellQuoting.Strong },
      { value: projectPaths[1], quoting: vscode.ShellQuoting.Strong },
    ]);
    const updatedResults = messages.filter((message) => message.type === 'operation-results').pop();
    expect(updatedResults?.type === 'operation-results' ? updatedResults.data.map((result) => result.succeeded) : []).toEqual([
      true,
      true,
    ]);
  });

  test('rejects stale solution projects and skips transitive package removal', async () => {
    const transitiveProjectPath = path.join(temporaryDirectory, 'Transitive.csproj');
    const missingProjectPath = path.join(temporaryDirectory, 'Missing.csproj');
    await fs.writeFile(transitiveProjectPath, '<Project />');
    const project: Project = {
      name: 'Transitive.csproj',
      fsPath: transitiveProjectPath,
      packages: [{ id: 'Package.Shared', version: '1.0.0', packageLevel: 'transitive' }],
    };
    configureSolutionHandler(path.join(temporaryDirectory, 'Sample.sln'), [project]);

    const addOperationId = 'stale-project-add';
    const addCompleted = waitForCompletion(addOperationId);
    receiveMessage?.({
      command: 'add-package-to-projects',
      operationId: addOperationId,
      projectPaths: [missingProjectPath],
      packageId: 'Package.Shared',
      packageVersion: '2.0.0',
      packageSourceUrl: 'https://packages.example/v3/index.json',
    } as InstallPackageInProjectsMessage);
    await addCompleted;

    const staleProjectResults = messages.filter((message) => message.type === 'operation-results').pop();
    expect(staleProjectResults?.type).toBe('operation-results');
    if (staleProjectResults?.type !== 'operation-results') {
      throw new Error('A stale project operation should report its failure.');
    }
    expect(staleProjectResults.data).toEqual([
      expect.objectContaining({
        projectPath: missingProjectPath,
        succeeded: false,
        message: 'The project is no longer part of the loaded solution.',
      }),
    ]);

    const staleRemoveOperationId = 'stale-project-remove';
    const staleRemoveCompleted = waitForCompletion(staleRemoveOperationId);
    receiveMessage?.({
      command: 'remove-package-from-projects',
      operationId: staleRemoveOperationId,
      projectPaths: [missingProjectPath],
      packageId: 'Package.Shared',
    } as RemovePackageFromProjectsMessage);
    await staleRemoveCompleted;

    const staleRemovalResults = messages.filter((message) => message.type === 'operation-results').pop();
    expect(staleRemovalResults?.type).toBe('operation-results');
    if (staleRemovalResults?.type !== 'operation-results') {
      throw new Error('A stale project removal should report its failure.');
    }
    expect(staleRemovalResults.data).toEqual([
      expect.objectContaining({
        projectPath: missingProjectPath,
        succeeded: false,
        message: 'The project is no longer part of the loaded solution.',
      }),
    ]);

    const removeOperationId = 'transitive-package-remove';
    const removeCompleted = waitForCompletion(removeOperationId);
    const removeRequest: RemovePackageFromProjectsMessage = {
      command: 'remove-package-from-projects',
      operationId: removeOperationId,
      projectPaths: [transitiveProjectPath],
      packageId: 'Package.Shared',
    };
    receiveMessage?.(removeRequest);
    await removeCompleted;

    const removalResults = messages.filter((message) => message.type === 'operation-results').pop();
    expect(removalResults?.type).toBe('operation-results');
    if (removalResults?.type !== 'operation-results') {
      throw new Error('A transitive package removal should report that it was skipped.');
    }
    expect(removalResults.data).toEqual([
      expect.objectContaining({
        projectPath: transitiveProjectPath,
        succeeded: false,
        skipped: true,
      }),
    ]);
    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
  });

  test('applies every package edit without restore and runs one final restore', async () => {
    const operationId = 'batch-operation';
    const completed = waitForCompletion(operationId);
    const request: UpdatePackagesMessage = {
      command: 'update-packages-batch',
      operationId,
      buildAfterRestore: false,
      updates: [
        {
          projectPaths: [projectPath],
          packageId: 'Package.One',
          packageVersion: '2.0.0',
          packageSourceUrl: 'https://packages.example/v3/index.json',
        },
        {
          projectPaths: [projectPath],
          packageId: 'Package.Two',
          packageVersion: '3.0.0',
          packageSourceUrl: 'https://packages.example/v3/index.json',
        },
      ],
    };
    receiveMessage?.(request);
    await completed;

    const executedTasks = (vscode.tasks.executeTask as jest.Mock).mock.calls.map(
      ([task]) =>
        task as unknown as {
          definition: { task: string };
          taskExecution: { args: Array<string | { value: string; quoting: number }> };
          presentationOptions?: { reveal: number; focus?: boolean };
        }
    );
    expect(executedTasks.map((task) => task.definition.task)).toEqual(['add', 'add', 'restore']);
    expect(executedTasks.slice(0, 2).every((task) => task.taskExecution.args.includes('--no-restore'))).toBe(true);
    expect(executedTasks[2].taskExecution.args[0]).toBe('restore');
    expect(executedTasks.every((task) => task.presentationOptions?.reveal === vscode.TaskRevealKind.Never)).toBe(true);
    expect(executedTasks.every((task) => !task.taskExecution.args.includes('--interactive'))).toBe(true);
    expect(messages.filter((message) => message.type === 'operation-completed')).toHaveLength(1);

    const operationResults = messages.filter((message) => message.type === 'operation-results').pop();
    expect(operationResults?.type === 'operation-results' ? operationResults.data.map((result) => result.operation) : []).toEqual([
      'add',
      'add',
      'restore',
    ]);
    expect(
      operationResults?.type === 'operation-results'
        ? operationResults.data.slice(0, 2).map((result) => [result.fromVersion, result.toVersion])
        : []
    ).toEqual([
      ['1.0.0', '2.0.0'],
      ['1.0.0', '3.0.0'],
    ]);
  });

  test('reports a failed single-package install without revealing an interactive terminal', async () => {
    const testHooks = vscode as unknown as { testHooks: { taskExitCodes: number[] } };
    testHooks.testHooks.taskExitCodes.push(1);
    const operationId = 'single-package-failure';
    const completed = waitForCompletion(operationId);
    receiveMessage?.({
      command: 'add-package',
      operationId,
      projectName: projectPath,
      packageId: 'Package.Failed',
      packageVersion: '1.0.0',
      packageSourceUrl: 'https://packages.example/v3/index.json',
    } as InstallMessage);
    await completed;

    const operationResults = messages.filter((message) => message.type === 'operation-results').pop();
    expect(operationResults?.type).toBe('operation-results');
    if (operationResults?.type !== 'operation-results') {
      throw new Error('A single-package install should report its result.');
    }
    expect(operationResults.data).toEqual([
      expect.objectContaining({
        packageId: 'Package.Failed',
        operation: 'add',
        succeeded: false,
        message: 'dotnet add package exited with code 1.',
      }),
    ]);

    const task = (vscode.tasks.executeTask as jest.Mock).mock.calls[0][0] as {
      presentationOptions?: { reveal: number; focus?: boolean };
      taskExecution: { args: Array<string | { value: string; quoting: number }> };
    };
    expect(task.presentationOptions?.reveal).toBe(vscode.TaskRevealKind.Never);
    expect(task.taskExecution.args).not.toContain('--interactive');
  });

  test('loads project context through the fast package inventory path', async () => {
    const project: Project = {
      name: 'Batch',
      fsPath: projectPath,
      packages: [],
      packageMetadataComplete: false,
    };
    const loadProjectInventoryAsync = jest.fn().mockResolvedValue(project);
    const loadProjectAsync = jest.fn();
    const internals = handler as unknown as {
      projectFileLoader: {
        loadProjectInventoryAsync: typeof loadProjectInventoryAsync;
        loadProjectAsync: typeof loadProjectAsync;
      };
      loadContext: () => void;
    };
    internals.projectFileLoader = { loadProjectInventoryAsync, loadProjectAsync };

    (internals.loadContext as jest.Mock).mockRestore();
    internals.loadContext();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadProjectInventoryAsync).toHaveBeenCalledWith(projectPath);
    expect(loadProjectAsync).not.toHaveBeenCalled();
    expect(messages).toContainEqual({ type: 'project', data: project });
  });

  test('loads CPM metadata before adding to a fast-loaded project inventory', async () => {
    const initialProject = {
      name: 'Batch',
      fsPath: projectPath,
      packages: [],
      packageMetadataComplete: false,
    };
    const metadataProject = {
      ...initialProject,
      managePackageVersionsCentrally: true,
      packageMetadataComplete: true,
    };
    const loadProjectAsync = jest.fn().mockResolvedValue(metadataProject);
    const internals = handler as unknown as {
      projectFileLoader: { loadProjectAsync: typeof loadProjectAsync };
      solutionProjects: Map<string, Project>;
    };
    internals.projectFileLoader = { loadProjectAsync };
    internals.solutionProjects.set(projectPath, initialProject);

    const operationId = 'fast-inventory-cpm-install';
    const completed = waitForCompletion(operationId);
    receiveMessage?.({
      command: 'add-package',
      operationId,
      projectName: projectPath,
      packageId: 'Package.Cpm',
      packageVersion: '2.0.0',
      packageSourceUrl: 'https://packages.example/v3/index.json',
    } as InstallMessage);
    await completed;

    expect(loadProjectAsync).toHaveBeenCalledWith(projectPath);
    expect(messages).toContainEqual({ type: 'project', data: metadataProject });
    const task = (vscode.tasks.executeTask as jest.Mock).mock.calls[0][0] as {
      taskExecution: { args: Array<string | { value: string; quoting: number }> };
    };
    expect(task.taskExecution.args.slice(0, 2)).toEqual(['package', 'add']);
  });

  test('does not edit a project when required metadata cannot be loaded', async () => {
    const initialProject = {
      name: 'Batch',
      fsPath: projectPath,
      packages: [],
      packageMetadataComplete: false,
    };
    const loadProjectAsync = jest.fn().mockRejectedValue(new Error('MSBuild evaluation failed'));
    const internals = handler as unknown as {
      projectFileLoader: { loadProjectAsync: typeof loadProjectAsync };
      solutionProjects: Map<string, Project>;
    };
    internals.projectFileLoader = { loadProjectAsync };
    internals.solutionProjects.set(projectPath, initialProject);

    const operationId = 'fast-inventory-metadata-failure';
    const completed = waitForCompletion(operationId);
    receiveMessage?.({
      command: 'add-package',
      operationId,
      projectName: projectPath,
      packageId: 'Package.Cpm',
      packageVersion: '2.0.0',
      packageSourceUrl: 'https://packages.example/v3/index.json',
    } as InstallMessage);
    await completed;

    expect(vscode.tasks.executeTask).not.toHaveBeenCalled();
    expect(messages.filter((message) => message.type === 'operation-results').pop()).toMatchObject({
      type: 'operation-results',
      data: [expect.objectContaining({ succeeded: false, message: 'MSBuild evaluation failed' })],
    });
  });

  test('restores original files after build failure when the user requests rollback', async () => {
    const testHooks = vscode as unknown as { testHooks: { taskExitCodes: number[] } };
    testHooks.testHooks.taskExitCodes.push(0, 0, 1, 0);
    const batchId = 'failing-build';
    const batchCompleted = waitForCompletion(batchId);
    const request: UpdatePackagesMessage = {
      command: 'update-packages-batch',
      operationId: batchId,
      buildAfterRestore: true,
      updates: [
        {
          projectPaths: [projectPath],
          packageId: 'Package.One',
          packageVersion: '2.0.0',
          packageSourceUrl: 'https://packages.example/v3/index.json',
        },
      ],
    };
    receiveMessage?.(request);
    await batchCompleted;

    const batchResults = messages.filter((message) => message.type === 'operation-results').pop();
    expect(batchResults?.type).toBe('operation-results');
    if (batchResults?.type !== 'operation-results' || !batchResults.rollbackId) {
      throw new Error('A failed build should provide a rollback action.');
    }

    const rollbackId = batchResults.rollbackId;
    const rollbackOperationId = 'rollback-operation';
    const rollbackCompleted = waitForCompletion(rollbackOperationId);
    const rollbackRequest: RollbackPackageUpdateMessage = {
      command: 'rollback-package-update',
      operationId: rollbackOperationId,
      rollbackId,
    };
    receiveMessage?.(rollbackRequest);
    await rollbackCompleted;

    expect(await fs.readFile(projectPath, 'utf8')).toBe('<Project />');
    const rollbackResults = messages.filter((message) => message.type === 'operation-results').pop();
    expect(rollbackResults?.type === 'operation-results' ? rollbackResults.data.at(-1)?.operation : undefined).toBe('rollback');
    expect(rollbackResults?.type === 'operation-results' ? rollbackResults.data.at(-1)?.succeeded : false).toBe(true);
  });

  test('does not roll back files changed after the batch', async () => {
    const testHooks = vscode as unknown as { testHooks: { taskExitCodes: number[] } };
    testHooks.testHooks.taskExitCodes.push(0, 0, 1);
    const operationId = 'user-edit-guard';
    const completed = waitForCompletion(operationId);
    const request: UpdatePackagesMessage = {
      command: 'update-packages-batch',
      operationId,
      buildAfterRestore: true,
      updates: [
        {
          projectPaths: [projectPath],
          packageId: 'Package.One',
          packageVersion: '2.0.0',
          packageSourceUrl: 'https://packages.example/v3/index.json',
        },
      ],
    };
    receiveMessage?.(request);
    await completed;
    const batchResults = messages.filter((message) => message.type === 'operation-results').pop();
    if (batchResults?.type !== 'operation-results' || !batchResults.rollbackId) {
      throw new Error('A failed build should provide a rollback action.');
    }

    await fs.writeFile(projectPath, '<Project UserEdit />');
    const rollbackOperationId = 'guarded-rollback';
    const rollbackCompleted = waitForCompletion(rollbackOperationId);
    const rollbackRequest: RollbackPackageUpdateMessage = {
      command: 'rollback-package-update',
      operationId: rollbackOperationId,
      rollbackId: batchResults.rollbackId,
    };
    receiveMessage?.(rollbackRequest);
    await rollbackCompleted;

    expect(await fs.readFile(projectPath, 'utf8')).toBe('<Project UserEdit />');
    const rollbackResults = messages.filter((message) => message.type === 'operation-results').pop();
    expect(
      rollbackResults?.type === 'operation-results' ? rollbackResults.data.at(-1)?.message : undefined
    ).toContain('changed after the update');
  });

  function configureSolutionHandler(solutionPath: string, projects: Project[]): void {
    handler.dispose();
    messages = [];
    waiters.clear();
    handler = new WebviewMessageHandler(webview as unknown as vscode.Webview, { type: 'solution', filePath: solutionPath });
    const privateHandler = handler as unknown as { solutionProjects: Map<string, Project>; loadContext: () => void };
    privateHandler.solutionProjects = new Map(projects.map((project) => [project.fsPath, project]));
    jest.spyOn(privateHandler, 'loadContext').mockImplementation(() => {});
    (vscode.tasks.executeTask as jest.Mock).mockClear();
  }
});
