import { Module } from '@nestjs/common'
import { ClsModule } from 'nestjs-cls'
import { LoggerModule } from 'nestjs-pino'
import { CanonicalLogModule } from 'nestjs-canonical-log'
import { AuthModule } from './auth/auth.module'
import { JobsModule } from './jobs/jobs.module'

@Module({
  imports: [
    // ClsModule first — opens the AsyncLocalStorage scope per request.
    // Everything that calls addFields() depends on this scope being active.
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),

    LoggerModule.forRoot({
      pinoHttp: {
        level: 'info',
        // Suppress pino-http's own per-request line — our canonical line replaces it.
        autoLogging: false,
        // pino-http auto-attaches a `req` object to every log call during a request.
        // Without this flag, the canonical line nests its fields under `req`, breaking
        // flatness. quietReqLogger keeps the per-request `reqId` binding for
        // correlation but stops attaching the full request object.
        quietReqLogger: true,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,req,reqId' },
        },
      },
    }),

    CanonicalLogModule.forRoot({
      service: 'example-api',
      env: process.env.NODE_ENV ?? 'development',
    }),

    // AuthModule after the above — middleware in imported modules runs in
    // import order, so its addFields() call lands inside an active CLS scope.
    AuthModule,
    JobsModule,
  ],
})
export class AppModule {}
