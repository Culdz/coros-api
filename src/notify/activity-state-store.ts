import { readFile, rename, writeFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { NotifyConfigService } from './notify.config';

export const NotifierState = z.object({
  version: z.literal(1),
  seenLabelIds: z.array(z.string()),
  lastActivityEndTime: z.string().nullable(),
  lastActivityLabelId: z.string().nullable(),
  accessToken: z.string().nullable(),
  accessTokenIssuedAt: z.string().nullable(),
  // Stored verbatim from the notifier payload (ActivityPayload); kept loosely typed here.
  recentActivities: z.array(z.unknown()),
});
export type NotifierState = z.infer<typeof NotifierState>;

export function emptyState(): NotifierState {
  return {
    version: 1,
    seenLabelIds: [],
    lastActivityEndTime: null,
    lastActivityLabelId: null,
    accessToken: null,
    accessTokenIssuedAt: null,
    recentActivities: [],
  };
}

@Injectable()
export class ActivityStateStore {
  private readonly logger = new Logger(ActivityStateStore.name);
  private readonly config: NotifyConfigService;

  constructor(config: NotifyConfigService) {
    this.config = config;
  }

  async load(): Promise<NotifierState> {
    let raw: string;
    try {
      raw = await readFile(this.config.stateFile, 'utf-8');
    } catch {
      return emptyState();
    }

    try {
      const parsed = NotifierState.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.logger.warn(`State file ${this.config.stateFile} is invalid; starting fresh`);
        return emptyState();
      }
      return parsed.data;
    } catch {
      this.logger.warn(`State file ${this.config.stateFile} is not valid JSON; starting fresh`);
      return emptyState();
    }
  }

  async save(state: NotifierState): Promise<void> {
    const tmp = `${this.config.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await rename(tmp, this.config.stateFile);
  }
}
