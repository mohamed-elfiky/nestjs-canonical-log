import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { AuthMiddleware } from './auth.middleware'

// Auth lives in its own module so its middleware is registered AFTER
// ClsModule's middleware. nestjs-cls is what opens the AsyncLocalStorage
// scope per request — without it, addFields() has nowhere to write.
// Middleware in AppModule.configure() runs before any imported module's
// middleware, including ClsModule's, so AppModule-level auth would lose
// its fields. Imported-module middleware runs in module-import order.
@Module({
  providers: [AuthMiddleware],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes('*')
  }
}
