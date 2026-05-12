import {
  ClassSerializerInterceptor,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationError } from 'class-validator';

import { AppModule } from './app.module';
import { ExceptionFilter } from './utils/exceptions/http-exception/error-filter-handler';

import {
  FormattedExceptionWithValidation,
  ValidationErr,
} from './utils/exceptions/http-exception/formatted-exeption';

const logger = new Logger('Bootstrap');

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

    const port = Number(process.env.PORT) || 3000;

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
