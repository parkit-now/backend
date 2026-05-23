import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { defaultCodeForStatus, ErrorCode, ErrorCodes } from '../error-codes';
import { PrismaErrorFormatter } from '../prisma-client-exception/prisma-error-formatter.filter';
import { ProblemDetails } from './formatted-exeption';

@Catch()
export class ExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(ExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const instance = request.url;

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.handlePrisma(exception, response, instance);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      this.logger.warn(
        `Prisma validation error on ${request.method} ${instance}: ${exception.message}`,
      );
      return this.send(response, {
        title: 'Validation error',
        status: HttpStatus.BAD_REQUEST,
        detail: 'Invalid query input for the database',
        instance,
        code: ErrorCodes.DB_VALIDATION_ERROR,
      });
    }

    if (exception instanceof HttpException) {
      return this.handleHttp(exception, response, instance);
    }

    const err = exception as Error;
    this.logger.error(
      `500 Error - ${request.method} ${instance}: ${err?.message ?? 'Unknown error'}`,
      err?.stack,
    );
    return this.send(response, {
      title: 'Unexpected Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail:
        'A server error occurred, please try again or contact administrator',
      instance,
      code: ErrorCodes.INTERNAL_ERROR,
    });
  }

  private handleHttp(
    exception: HttpException,
    response: Response,
    instance: string,
  ) {
    const status = exception.getStatus();
    const body = exception.getResponse();

    if (typeof body === 'object' && body !== null && 'title' in body) {
      const problem = body as ProblemDetails;
      return this.send(response, {
        ...problem,
        status,
        instance,
        code: problem.code ?? defaultCodeForStatus(status),
      });
    }

    const message =
      typeof body === 'string'
        ? body
        : ((body as { message?: string | string[] })?.message ??
          exception.message);

    return this.send(response, {
      title: this.titleForStatus(status),
      status,
      detail: Array.isArray(message) ? message.join(', ') : message,
      instance,
      code: defaultCodeForStatus(status),
    });
  }

  private handlePrisma(
    exception: Prisma.PrismaClientKnownRequestError,
    response: Response,
    instance: string,
  ) {
    const formatter = new PrismaErrorFormatter(exception);
    const status = this.prismaCodeToStatus(exception.code);

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `Unhandled Prisma error ${exception.code} on ${instance}`,
        exception,
      );
    }

    return this.send(response, {
      title: formatter.getFriendlyTitle(),
      status,
      detail: formatter.getFriendlyMessage(),
      instance,
      code: this.prismaCodeToErrorCode(exception.code),
    });
  }

  private send(response: Response, problem: ProblemDetails) {
    response.status(problem.status).json(problem);
  }

  private titleForStatus(status: number): string {
    const map: Record<number, string> = {
      [HttpStatus.BAD_REQUEST]: 'Bad Request',
      [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
      [HttpStatus.FORBIDDEN]: 'Forbidden',
      [HttpStatus.NOT_FOUND]: 'Not Found',
      [HttpStatus.CONFLICT]: 'Conflict',
      [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
    };
    return map[status] ?? 'Error';
  }

  private prismaCodeToErrorCode(prismaCode: string): ErrorCode {
    const map: Record<string, ErrorCode> = {
      P2001: ErrorCodes.DB_NOT_FOUND,
      P2002: ErrorCodes.DB_UNIQUE_CONSTRAINT,
      P2003: ErrorCodes.DB_FOREIGN_KEY_VIOLATION,
      P2015: ErrorCodes.DB_NOT_FOUND,
      P2021: ErrorCodes.DB_NOT_FOUND,
      P2022: ErrorCodes.DB_NOT_FOUND,
      P2024: ErrorCodes.DB_CONNECTION_TIMEOUT,
      P2025: ErrorCodes.DB_NOT_FOUND,
      P2034: ErrorCodes.DB_UNIQUE_CONSTRAINT,
    };
    return map[prismaCode] ?? ErrorCodes.DB_ERROR;
  }

  private prismaCodeToStatus(code: string): HttpStatus {
    const statusMap: Record<string, HttpStatus> = {
      P2000: HttpStatus.BAD_REQUEST,
      P2001: HttpStatus.NOT_FOUND,
      P2002: HttpStatus.CONFLICT,
      P2003: HttpStatus.BAD_REQUEST,
      P2004: HttpStatus.BAD_REQUEST,
      P2005: HttpStatus.BAD_REQUEST,
      P2006: HttpStatus.BAD_REQUEST,
      P2007: HttpStatus.BAD_REQUEST,
      P2008: HttpStatus.BAD_REQUEST,
      P2009: HttpStatus.BAD_REQUEST,
      P2010: HttpStatus.BAD_REQUEST,
      P2011: HttpStatus.BAD_REQUEST,
      P2012: HttpStatus.BAD_REQUEST,
      P2013: HttpStatus.BAD_REQUEST,
      P2014: HttpStatus.BAD_REQUEST,
      P2015: HttpStatus.NOT_FOUND,
      P2016: HttpStatus.BAD_REQUEST,
      P2017: HttpStatus.BAD_REQUEST,
      P2018: HttpStatus.BAD_REQUEST,
      P2019: HttpStatus.BAD_REQUEST,
      P2020: HttpStatus.BAD_REQUEST,
      P2021: HttpStatus.NOT_FOUND,
      P2022: HttpStatus.NOT_FOUND,
      P2023: HttpStatus.BAD_REQUEST,
      P2024: HttpStatus.GATEWAY_TIMEOUT,
      P2025: HttpStatus.NOT_FOUND,
      P2026: HttpStatus.BAD_REQUEST,
      P2027: HttpStatus.BAD_REQUEST,
      P2029: HttpStatus.BAD_REQUEST,
      P2030: HttpStatus.BAD_REQUEST,
      P2031: HttpStatus.BAD_REQUEST,
      P2033: HttpStatus.BAD_REQUEST,
      P2034: HttpStatus.CONFLICT,
      P2035: HttpStatus.BAD_REQUEST,
      P2036: HttpStatus.BAD_REQUEST,
    };
    return statusMap[code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
