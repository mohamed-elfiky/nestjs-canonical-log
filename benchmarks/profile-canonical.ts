/**
 * Profiling-focused variant: boots ONLY the canonical scenario and hammers it
 * for a while. Meant to be run under 0x/clinic/node --cpu-prof.
 *
 * Usage (from repo root):
 *   pnpm 0x -o -- node --require ts-node/register/transpile-only \
 *     --require tsconfig-paths/register benchmarks/profile-canonical.ts
 * or:
 *   pnpm bench:profile
 */
import 'reflect-metadata'
import { Writable } from 'node:stream'
import autocannon from 'autocannon'
import { Controller, Get, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ClsModule } from 'nestjs-cls'
import { LoggerModule } from 'nestjs-pino'
import { CanonicalLogModule } from '../src/index'

const DURATION_SEC = Number(process.env.PROFILE_DURATION ?? 15)
const CONNECTIONS = Number(process.env.PROFILE_CONNECTIONS ?? 50)
const PORT = 5000

const devNull = new Writable({ write: (_c, _e, cb) => cb() })

@Controller()
class HelloController {
  @Get('/ping')
  ping() {
    return { ok: true }
  }
}

@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: 'info',
        autoLogging: false,
        quietReqLogger: true,
        stream: devNull,
      },
    }),
    CanonicalLogModule.forRoot({ 'service.name': 'profile' }),
  ],
  controllers: [HelloController],
})
class ProfileModule {}

async function main() {
  const app = await NestFactory.create(ProfileModule, { logger: false })
  await app.listen(PORT)

  process.stderr.write(
    `profiling: ${CONNECTIONS} connections, ${DURATION_SEC}s. flamegraph will open at end.\n`,
  )

  await new Promise<void>((resolve, reject) => {
    autocannon(
      {
        url: `http://127.0.0.1:${PORT}/ping`,
        connections: CONNECTIONS,
        duration: DURATION_SEC,
      },
      err => (err ? reject(err) : resolve()),
    )
  })

  await app.close()
  // Give 0x a moment to finish sampling before exit.
  await new Promise(r => setTimeout(r, 200))
}

main().catch(err => {
  process.stderr.write(`profile failed: ${String(err)}\n`)
  process.exit(1)
})
