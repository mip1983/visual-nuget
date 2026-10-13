import { Component, HostListener, ChangeDetectionStrategy } from '@angular/core';

import { ExtensionMessage } from '../../src-common/models/extension-message';
import { PackageSource } from '../../src-common/models/package-source';
import { Project, Solution } from '../../src-common/models/project';
import { PackageManagerService } from './services/package-manager.service';

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: false
})
export class AppComponent {
  constructor(private packageManager: PackageManagerService) {}

  @HostListener('window:message', ['$event'])
  MessageFromExtension(event: MessageEvent<ExtensionMessage>) {
    const message = event.data;
    if (message.type === 'project') {
      this.packageManager.changeCurrentProject(message.data as Project);
    } else if (message.type === 'solution') {
      this.packageManager.changeCurrentSolution(message.data as Solution);
    } else if (message.type === 'sources') {
      this.packageManager.changeCurrentSources(message.data as PackageSource[]);
    } else if (message.type === 'operation-results') {
      this.packageManager.setOperationResults(message.data, message.rollbackId);
    } else if (message.type === 'operation-progress') {
      this.packageManager.setPackageOperationProgress(message.data.operationId, message.data.message);
    } else if (message.type === 'operation-completed') {
      this.packageManager.completePackageOperation(message.data.operationId);
    }
  }
}
