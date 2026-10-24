import { ConfigService } from '@nestjs/config';
import { LprImageRetentionService } from '../lpr-events/lpr-image-retention.service';
import { LocalJobsCron } from './local-jobs.cron';

const config = { get: jest.fn() };
const retention = { run: jest.fn() };

const cron = new LocalJobsCron(
  config as unknown as ConfigService,
  retention as unknown as LprImageRetentionService,
);

function configure(values: Record<string, string | undefined>) {
  config.get.mockImplementation((key: string) => values[key]);
}

describe('LocalJobsCron', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sin Cloud Scheduler configurado (local), el cron corre la retención', async () => {
    configure({});

    await cron.lprImageRetentionRun();

    expect(retention.run).toHaveBeenCalledTimes(1);
  });

  it('con Cloud Scheduler configurado no corre: el único disparador es Scheduler', async () => {
    configure({
      INTERNAL_JOBS_AUDIENCE: 'https://backend.example.run.app',
      INTERNAL_JOBS_INVOKER_EMAIL: 'scheduler@parkit.iam.gserviceaccount.com',
    });

    await cron.lprImageRetentionRun();

    expect(retention.run).not.toHaveBeenCalled();
  });

  it('con la configuración a medias se considera sin Scheduler', async () => {
    configure({ INTERNAL_JOBS_AUDIENCE: 'https://backend.example.run.app' });

    await cron.lprImageRetentionRun();

    expect(retention.run).toHaveBeenCalledTimes(1);
  });
});
