import * as vscode from 'vscode';
import * as quickPick from './services/quick-pick';

import UiPanel from './ui-panel';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('visualnuget.managePackages', (uri: vscode.Uri) => {
      if (uri) {
        UiPanel.createOrShow(context.extensionPath, uri, 'project');
      }
    }),
    vscode.commands.registerCommand('visualnuget.managePackagesPalette', async () => {
      const projectFileUri = await quickPick.pickProjectFile();
      if (projectFileUri) {
        UiPanel.createOrShow(context.extensionPath, projectFileUri, 'project');
      }
    }),
    vscode.commands.registerCommand('visualnuget.manageSolutionPackages', (uri: vscode.Uri) => {
      if (uri) {
        UiPanel.createOrShow(context.extensionPath, uri, 'solution');
      }
    }),
    vscode.commands.registerCommand('visualnuget.manageSolutionPackagesPalette', async () => {
      const solutionFileUri = await quickPick.pickSolutionFile();
      if (solutionFileUri) {
        UiPanel.createOrShow(context.extensionPath, solutionFileUri, 'solution');
      }
    })
  );
}
