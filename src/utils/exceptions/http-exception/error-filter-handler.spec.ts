import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCodes } from '../error-codes';
import { ExceptionFilter } from './error-filter-handler';
import { FormattedException } from './formatted-exeption';

type Sent = { status: number; body: Record<string, unknown> };

/** Corre el filtro sobre `exception` y devuelve lo que respondió. */
function run(exception: unknown, url = '/tenants/t/entries'): Sent {
  const sent: Sent = { status: 0, body: {} };
  const response = {
    status: (code: number) => {
      sent.status = code;
      return response;
    },
    json: (body: Record<string, unknown>) => {
      sent.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ url, method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;
  new ExceptionFilter().catch(exception, host);
  return sent;
}

function prismaError(code: string, meta: Record<string, unknown> = {}) {
  return new Prisma.PrismaClientKnownRequestError('db error', {
    code,
    clientVersion: 'test',
    meta,
  });
}

describe('ExceptionFilter', () => {
  beforeEach(() => {
    // Los 500 se loguean a propósito: acá sólo ensuciarían la salida.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('respeta el code de una FormattedException y pisa el instance', () => {
    const sent = run(
      new FormattedException(
        'Not Found',
        HttpStatus.NOT_FOUND,
        'Parking p-1 not found',
        '/otro',
        ErrorCodes.PARKING_NOT_FOUND,
      ),
    );

    expect(sent).toEqual({
      status: 404,
      body: {
        title: 'Not Found',
        status: 404,
        detail: 'Parking p-1 not found',
        instance: '/tenants/t/entries',
        code: ErrorCodes.PARKING_NOT_FOUND,
      },
    });
  });

  it('a una HttpException plana le pone el code por status', () => {
    expect(run(new NotFoundException('no está')).body).toMatchObject({
      title: 'Not Found',
      status: 404,
      detail: 'no está',
      code: ErrorCodes.NOT_FOUND,
    });

    const validation = run(new BadRequestException(['a falta', 'b falta']));
    expect(validation.body).toMatchObject({
      title: 'Bad Request',
      detail: 'a falta, b falta',
      code: ErrorCodes.BAD_REQUEST,
    });

    expect(run(new HttpException('tetera', 418)).body).toMatchObject({
      title: 'Error',
      detail: 'tetera',
      status: 418,
    });
  });

  it('mapea los errores conocidos de Prisma a status y code DB_*', () => {
    expect(run(prismaError('P2002', { target: 'plate' }))).toMatchObject({
      status: 409,
      body: {
        code: ErrorCodes.DB_UNIQUE_CONSTRAINT,
        detail: 'This plate already exists.',
      },
    });
    expect(run(prismaError('P2003')).body.code).toBe(
      ErrorCodes.DB_FOREIGN_KEY_VIOLATION,
    );
    expect(run(prismaError('P2025')).status).toBe(404);
    expect(run(prismaError('P2024')).body.code).toBe(
      ErrorCodes.DB_CONNECTION_TIMEOUT,
    );
  });

  it('un código de Prisma desconocido es un 500 DB_ERROR', () => {
    expect(run(prismaError('P9999'))).toMatchObject({
      status: 500,
      body: {
        code: ErrorCodes.DB_ERROR,
        detail: 'An unexpected error occurred.',
        title: 'Unexpected database error',
      },
    });
  });

  it('todo código de Prisma tiene título y mensaje legibles', () => {
    const meta = {
      model_name: 'Entry',
      argument_name: 'id',
      argument_value: 'e-1',
      target: ['tenant_id', 'plate'],
      field_name: 'plate',
      field_value: 'X',
      database_error: 'boom',
      details: 'details',
      relation_name: 'rel',
      table: 'entries',
      column: 'plate',
      message: 'msg',
      cause: 'Record to update not found.',
    };
    for (let n = 2000; n <= 2037; n += 1) {
      const sent = run(prismaError(`P${n}`, meta));
      expect(typeof sent.body.title).toBe('string');
      expect(typeof sent.body.detail).toBe('string');
      expect(sent.body.detail).not.toContain('undefined');
    }
  });

  it('un error de validación de Prisma es un 400 DB_VALIDATION_ERROR', () => {
    const sent = run(
      new Prisma.PrismaClientValidationError('campo inválido', {
        clientVersion: 'test',
      }),
    );

    expect(sent).toMatchObject({
      status: 400,
      body: { code: ErrorCodes.DB_VALIDATION_ERROR },
    });
  });

  it('cualquier otro error es un 500 sin filtrar el mensaje', () => {
    const sent = run(new Error('secreto interno'));

    expect(sent.status).toBe(500);
    expect(sent.body.code).toBe(ErrorCodes.INTERNAL_ERROR);
    expect(JSON.stringify(sent.body)).not.toContain('secreto interno');
  });
});
