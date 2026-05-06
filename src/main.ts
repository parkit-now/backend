import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationError } from 'class-validator';
import { AppModule } from './app.module';
import { ExceptionFilter } from './utils/exceptions/http-exception/error-filter-handler';
import {
  FormattedExceptionWithValidation,
  ValidationErr,
} from './utils/exceptions/http-exception/formatted-exeption';

export function validationExceptionFactory(errors: ValidationError[]) {
  const parsedErrors: ValidationErr[] = [];
  for (const error of errors) {
    if (error.constraints) {
      parsedErrors.push(
        new ValidationErr(error.property, Object.values(error.constraints)[0]),
      );
    }
  }

  throw new FormattedExceptionWithValidation(
    'Validation Error',
    400,
    'Validation failed for the request',
    'https://tools.ietf.org/html/rfc7231#section-6.5.1',
    parsedErrors,
  );
}

const API_DESCRIPTION = [
  'Backend API for **Parkit**.',
  '',
  '## Conventions',
  '',
  '- **Auth**: every protected endpoint expects `Authorization: Bearer <jwt>`. Tokens are issued by **Supabase Auth** through this API (`POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`). The backend verifies the JWT signature against the Supabase project keys.',
  '- **Errors**: every non-2xx response follows the [RFC 7807 Problem Details](https://www.rfc-editor.org/rfc/rfc7807) shape: `{ title, status, detail, instance }`. Validation errors add a `validationsErrors: [{ field, reason }]` array.',
  '- **IDs**: UUIDs assigned by Supabase Auth (users) or `gen_random_uuid()` (everything else). Treat them as opaque strings.',
  '- **Roles**: `admin` (platform-wide), `owner` (parking-lot owner), `operator` (booth staff), `driver` (mobile-app end user). Authorization is enforced server-side via `RolesGuard`.',
  '- **Multi-tenancy**: a tenant is a parking lot. Association is N:M between users and tenants — see `user_memberships`. Owners and operators may hold several memberships (one per lot); drivers and admins have none. The "active tenant" for a session is carried in the JWT (`app_metadata.tenant_id`) and selected at login or via switch-tenant. Business rows carry that `tenant_id`; isolation is enforced server-side by `prismaForTenant(prisma, tenantId)` (the backend uses the service role and bypasses RLS).',
  '- **Times**: ISO-8601 UTC strings on the wire.',
  '',
].join('\n');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: '*',
    methods: 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
    allowedHeaders: 'Content-Type, Authorization',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  const config = new DocumentBuilder()
    .setTitle('Parkit API')
    .setDescription(API_DESCRIPTION)
    .setVersion('0.1.0')
    .addServer('http://localhost:3000', 'Local development')
    .addTag(
      'Auth',
      'Public authentication endpoints (`register`, `login`, `refresh`, `logout`) — thin wrappers over Supabase Auth.',
    )
    .addTag(
      'Users',
      'User-domain endpoints. Currently exposes the current-user lookup; future user management routes (list, update, delete) will land here.',
    )
    .addTag(
      'Health',
      'Liveness + readiness probe. Reports the status of every external dependency (database, etc.). Safe to call without authentication.',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Paste a Supabase `access_token` (from `supabase.auth.signInWithPassword(...)` or any other Supabase Auth flow). The Swagger UI will then attach `Authorization: Bearer <token>` to every protected request.',
      },
      'bearer',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      docExpansion: 'list',
      tryItOutEnabled: true,
    },
  });

  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new ExceptionFilter(httpAdapter));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(
    `Parkit API running on http://localhost:${port} (docs: /api, JSON: /api-json)`,
  );
}

void bootstrap();
