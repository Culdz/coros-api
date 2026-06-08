import { Logger } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { ActivityWatcher } from '../notify/activity-watcher';

@Command({ name: 'notify-activities', description: 'Poll COROS for new activities and notify the Hermes agent' })
export class NotifyActivitiesCommandRunner extends CommandRunner {
  private readonly logger = new Logger(NotifyActivitiesCommandRunner.name);
  private readonly watcher: ActivityWatcher;

  constructor(watcher: ActivityWatcher) {
    super();
    this.watcher = watcher;
  }

  async run(_passedParams: string[], _options?: Record<string, unknown>): Promise<void> {
    try {
      await this.watcher.run();
    } catch (error) {
      this.logger.error(`notify-activities failed: ${error}`);
    }
  }
}
