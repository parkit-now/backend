import {
  ClassSerializerInterceptor,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationError } from 'class-validator';
import { raw } from 'express';

import { AppModule } from './app.module';
import { ExceptionFilter } from './utils/exceptions/http-exception/error-filter-handler';

import { ErrorCodes } from './utils/exceptions/error-codes';
import {
  FormattedExceptionWithValidation,
  ValidationErr,
} from './utils/exceptions/http-exception/formatted-exeption';

const logger = new Logger('Bootstrap');

// Orden de prioridad cuando un campo viola varios constraints a la vez:
// se reporta el primero que matchee este array. Asi una contraseña vacia
// dispara `isNotEmpty` y no `maxLength` (que tambien falla con undefined).
const CONSTRAINT_PRIORITY = [
  'isDefined',
  'isNotEmpty',
  'isString',
  'isNumber',
  'isInt',
  'isBoolean',
  'isEmail',
  'isUUID',
  'isDate',
  'isIn',
  'isEnum',
  'minLength',
  'maxLength',
  'min',
  'max',
];

function pickConstraint(
  constraints: Record<string, string>,
): [code: string, reason: string] {
  for (const key of CONSTRAINT_PRIORITY) {
    if (constraints[key]) return [key, constraints[key]];
  }
  return Object.entries(constraints)[0];
}

export function validationExceptionFactory(errors: ValidationError[]) {
  const parsedErrors: ValidationErr[] = [];

  for (const error of errors) {
    if (error.constraints) {
      const [code, reason] = pickConstraint(error.constraints);
      parsedErrors.push(new ValidationErr(error.property, reason, code));
    }
  }

  throw new FormattedExceptionWithValidation(
    'Validation Error',
    400,
    'Validation failed for the request',
    'https://tools.ietf.org/html/rfc7231#section-6.5.1',
    ErrorCodes.VALIDATION_FAILED,
    parsedErrors,
  );
}

const API_DESCRIPTION = [
  'Backend API for **Parkit**.',
  '',
  '## Conventions',
  '',
  '- **Times**: ISO-8601 UTC strings on the wire.',
].join('\n');

async function bootstrap() {
  try {
    logger.log('Starting Parkit API bootstrap...');

    logger.log(`NODE_ENV=${process.env.NODE_ENV}`);
    logger.log(`PORT=${process.env.PORT}`);
    logger.log(`DATABASE_URL exists=${Boolean(process.env.DATABASE_URL)}`);

    logger.log('Creating Nest application...');
    const app = await NestFactory.create(AppModule, {
      logger: ['log', 'error', 'warn', 'debug', 'verbose'],
    });

    logger.log('Nest application created');

    app.enableCors({
      origin: '*',
      methods: 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
      allowedHeaders: 'Content-Type, Authorization',
    });

    logger.log('CORS enabled');

    // LPR event photos arrive as raw JPEG bytes (Content-Type: image/jpeg),
    // not JSON — Nest's default body parsers skip non-matching content
    // types, so this route needs its own binary parser ahead of the
    // controller. Capped at 2MB; oversized bodies get an automatic 413.
    app.use(
      '/tenants/:tenantId/lpr-events/:eventId/image',
      raw({ type: 'image/jpeg', limit: '2mb' }),
    );

    // Mercado Pago notifications keep their body raw so it never reaches the
    // global ValidationPipe below: `forbidNonWhitelisted: true` would answer
    // 400 the day Mercado Pago adds a field to the payload, and a 4xx makes it
    // retry the notification every 15 minutes forever (and fails the
    // `webhooks_ipn` quality check). `MpWebhookService` parses it by hand.
    // Capped at 256kb — these payloads are a handful of scalars.
    app.use(
      '/integrations/mercadopago/webhook',
      raw({ type: 'application/json', limit: '256kb' }),
    );

    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        exceptionFactory: validationExceptionFactory,
      }),
    );

    logger.log('Validation pipe configured');

    app.useGlobalInterceptors(
      new ClassSerializerInterceptor(app.get(Reflector)),
    );

    logger.log('Global interceptors configured');

    const config = new DocumentBuilder()
      .setTitle('Parkit API')
      .setDescription(API_DESCRIPTION)
      .setVersion('0.1.0')
      .addServer('http://localhost:3000', 'Local development')
      .addServer(
        process.env.API_PRODUCTION_URL || 'http://localhost:3000',
        'Production',
      )
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        'bearer',
      )
      .build();

    logger.log('Swagger config created');

    const document = SwaggerModule.createDocument(app, config);

    logger.log('Swagger document generated');

    SwaggerModule.setup('api', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: 'list',
        tryItOutEnabled: true,
      },
    });

    logger.log('Swagger mounted at /api');

    const { httpAdapter } = app.get(HttpAdapterHost);

    app.useGlobalFilters(new ExceptionFilter(httpAdapter));

    logger.log('Global exception filters configured');

    const port = Number(process.env.PORT) || 8080;

    logger.log(`Attempting to listen on port ${port}...`);

    await app.listen(port, '0.0.0.0');

    logger.log(`✅ Parkit API is running on port ${port}`);
    logger.log(`✅ Health check URL: http://0.0.0.0:${port}`);
  } catch (error) {
    logger.error('❌ Fatal error during bootstrap');
    logger.error(error);

    if (error instanceof Error) {
      logger.error(error.message);
      logger.error(error.stack);
    }

    process.exit(1);
  }
}

void bootstrap();
