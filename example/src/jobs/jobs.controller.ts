import { Body, Controller, Get, Param, Patch } from '@nestjs/common'
import { JobsService } from './jobs.service'

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get(':id')
  getJob(@Param('id') id: string) {
    return this.jobsService.findById(id)
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body('status') status: string) {
    return this.jobsService.updateStatus(id, status)
  }
}
