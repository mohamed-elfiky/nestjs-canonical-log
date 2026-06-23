import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { CanonicalLogService } from 'nestjs-canonical-log'

type JobFields = {
  'job.id'?: string
  'job.status_from'?: string
  'job.status_to'?: string
}

const JOBS: Record<string, { id: string; status: string; title: string }> = {
  'job-123': { id: 'job-123', status: 'scheduled', title: 'Install HVAC Unit' },
  'job-456': { id: 'job-456', status: 'in_progress', title: 'Plumbing Repair' },
}

@Injectable()
export class JobsService {
  constructor(private readonly canonicalLog: CanonicalLogService) {}

  async findById(id: string) {
    const job = JOBS[id]
    if (!job) throw new NotFoundException(`Job ${id} not found`)

    // Contribute domain fields as soon as we have them.
    this.canonicalLog.addFields<JobFields>({ 'job.id': id })
    return job
  }

  async updateStatus(id: string, newStatus: string) {
    if (!newStatus) throw new BadRequestException('status is required')

    const job = JOBS[id]
    if (!job) throw new NotFoundException(`Job ${id} not found`)

    // Set before the write — if the write throws, job.status_to is absent
    // from the canonical line. That gap tells you exactly where it died.
    this.canonicalLog.addFields<JobFields>({
      'job.id': id,
      'job.status_from': job.status,
    })

    job.status = newStatus

    // Only set after the write succeeds.
    this.canonicalLog.addFields<JobFields>({ 'job.status_to': newStatus })

    return job
  }
}
