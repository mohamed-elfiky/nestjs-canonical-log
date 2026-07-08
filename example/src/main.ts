import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.useLogger(app.get(Logger))

  // Make Ctrl+C / SIGTERM actually close the HTTP server so the port frees
  // immediately. Without this, ts-node/tsx dies before Nest has a chance to
  // tear the server down and you get EADDRINUSE on the next start.
  app.enableShutdownHooks()

  const port = Number(process.env.PORT ?? 3000)
  await app.listen(port)

  process.stderr.write(`
App running on http://localhost:${port}

Try these requests and watch the canonical log line emitted for each:

  # Success — GET with domain fields
  curl http://localhost:${port}/jobs/job-123

  # Success — PATCH with status transition fields
  curl -X PATCH http://localhost:${port}/jobs/job-123/status \\
    -H 'Content-Type: application/json' \\
    -d '{"status":"in_progress"}'

  # 404 — error path, job.status_to absent (write never started)
  curl http://localhost:${port}/jobs/not-found

  # 400 — validation error
  curl -X PATCH http://localhost:${port}/jobs/job-123/status \\
    -H 'Content-Type: application/json' \\
    -d '{"status":""}'

  # timeout — hung request; the TTL sweep emits outcome:timeout with the
  # stage after ~5s, even though the handler never returns
  curl --max-time 3 http://localhost:${port}/jobs/hang

`)
}

bootstrap()
