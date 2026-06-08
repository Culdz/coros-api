import { Logger } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { ActivityWatcher } from '../notify/activity-watcher';

type Flags = { days: number };

@Command({
  name: 'backfill-history',
  description: "One-time: send recent COROS history to Hermes to seed the skills' memory",
})
export class BackfillHistoryCommandRunner extends CommandRunner {
  private readonly logger = new Logger(BackfillHistoryCommandRunner.name);
  private readonly watcher: ActivityWatcher;

  constructor(watcher: ActivityWatcher) {
    super();
    this.watcher = watcher;
  }

  async run(_passedParams: string[], flags: Flags): Promise<void> {
    try {
      await this.watcher.backfill(flags.days ?? 30);
    } catch (error) {
      this.logger.error(`backfill-history failed: ${error}`);
    }
  }

  @Option({
    flags: '--days <days>',
    description: 'How many days of history to send (default 30)',
    required: false,
  })
  parseDays(value: string): number {
    const days = Number(value);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(`Invalid --days value: ${value}`);
    }
    return days;
  }
}
