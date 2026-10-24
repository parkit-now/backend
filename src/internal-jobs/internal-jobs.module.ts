import { Module } from '@nestjs/common';
import { LprEventsModule } from '../lpr-events/lpr-events.module';
import { GoogleOidcService } from './google-oidc.service';
import { InternalJobsController } from './internal-jobs.controller';
import { LocalJobsCron } from './local-jobs.cron';
import { SchedulerOidcGuard } from './scheduler-oidc.guard';

@Module({
  imports: [LprEventsModule],
  controllers: [InternalJobsController],
  providers: [GoogleOidcService, SchedulerOidcGuard, LocalJobsCron],
})
export class InternalJobsModule {}
