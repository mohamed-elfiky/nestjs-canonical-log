import { Body, Controller, Get, Param, Patch } from '@nestjs/common'
import { CanonicalLogService } from 'nestjs-canonical-log'
import { JobsService } from './jobs.service'

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly canonicalLog: CanonicalLogService,
  ) {}

  // Demo: a hung request — an await that never settles. Distilled, but the
  // failure class ships in library defaults: axios `timeout: 0` (infinite),
  // pg-pool `connectionTimeoutMillis: 0` (wait forever for a connection),
  // Postgres `lock_timeout: 0` (wait forever on a row lock).
  // pino-http logs nothing for these (or a context-free "request aborted"
  // if the client gives up). The TTL sweep emits outcome:'timeout' + stage.
  @Get('hang')
  async hang() {
    this.canonicalLog.stage('calling_dead_api')
    await new Promise(() => {}) // never resolves
    return { ok: true }
  }

  @Get(':id')
  getJob(@Param('id') id: string) {
    return this.jobsService.findById(id)
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body('status') status: string) {
    return this.jobsService.updateStatus(id, status)
  }
}
