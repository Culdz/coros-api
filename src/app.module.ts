import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { BackfillHistoryCommandRunner } from './command-runner/backfill-history.command-runner';
import { ExportActivitiesCommandRunner } from './command-runner/export-activities.command-runner';
import { ExportTrainingScheduleCommandRunner } from './command-runner/export-training-schedule.command-runner';
import { NotifyActivitiesCommandRunner } from './command-runner/notify-activities.command-runner';
import { DownloadFile } from './core/download-file.service';
import { CorosModule } from './coros/coros.module';
import { ActivityStateStore } from './notify/activity-state-store';
import { ActivityWatcher } from './notify/activity-watcher';
import { Clock } from './notify/clock';
import { FitMetricsParser } from './notify/fit-metrics-parser';
import { HermesNotifier } from './notify/hermes-notifier';
import { NotifyConfigService } from './notify/notify.config';

@Module({
  imports: [CorosModule, HttpModule],
  providers: [
    ExportActivitiesCommandRunner,
    ExportTrainingScheduleCommandRunner,
    NotifyActivitiesCommandRunner,
    BackfillHistoryCommandRunner,
    DownloadFile,
    NotifyConfigService,
    Clock,
    ActivityStateStore,
    FitMetricsParser,
    HermesNotifier,
    ActivityWatcher,
  ],
})
export class AppModule {}
