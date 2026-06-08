import { createHmac } from 'node:crypto';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { NotifyConfigService } from './notify.config';

@Injectable()
export class HermesNotifier {
  private readonly logger = new Logger(HermesNotifier.name);
  private readonly httpService: HttpService;
  private readonly config: NotifyConfigService;

  constructor(httpService: HttpService, config: NotifyConfigService) {
    this.httpService = httpService;
    this.config = config;
  }

  async notify(payload: unknown, url: string = this.config.webhookUrl): Promise<boolean> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (this.config.webhookSecret) {
      headers['X-Webhook-Signature'] = createHmac('sha256', this.config.webhookSecret).update(body).digest('hex');
    }

    try {
      await this.httpService.axiosRef.post(url, body, { headers });
      return true;
    } catch (error) {
      this.logger.error(`Failed to notify Hermes: ${error}`);
      return false;
    }
  }
}
