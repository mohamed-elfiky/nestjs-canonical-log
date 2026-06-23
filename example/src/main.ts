import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.useLogger(app.get(Logger))
  await app.listen(3000)

  // Print usage instructions directly to stderr so they don't mix with JSON logs on stdout
  process.stderr.write(`
App running on http://localhost:3000

Try these requests and watch the canonical log line emitted for each:

  # Success — GET with domain fields
  curl http://localhost:3000/jobs/job-123

  # Success — PATCH with status transition fields
  curl -X PATCH http://localhost:3000/jobs/job-123/status \\
    -H 'Content-Type: application/json' \\
    -d '{"status":"in_progress"}'

  # 404 — error path, job.status_to absent (write never started)
  curl http://localhost:3000/jobs/not-found

  # 400 — validation error
  curl -X PATCH http://localhost:3000/jobs/job-123/status \\
    -H 'Content-Type: application/json' \\
    -d '{"status":""}'

`)
}

bootstrap()
