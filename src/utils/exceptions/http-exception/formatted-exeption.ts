import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '../error-codes';

export interface ProblemDetails {
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  validationsErrors?: ValidationErr[];
}

export class FormattedException extends HttpException {
  constructor(
    title: string,
    status: HttpStatus,
    detail: string,
    instance: string,
    code: ErrorCode,
  ) {
    const body: ProblemDetails = { title, status, detail, instance, code };
    super(body, status);
  }
}

export class ValidationErr {
  constructor(
    public readonly field: string,
    public readonly reason: string,
    public readonly code: string,
  ) {}
}

export class FormattedExceptionWithValidation extends HttpException {
  constructor(
    title: string,
    status: HttpStatus,
    detail: string,
    instance: string,
    code: ErrorCode,
    validationsErrors: ValidationErr[],
    // Miembros de extensión del problem (RFC 7807 §3.2), p. ej. `missing`.
    // Van primero para que nunca pisen los campos estándar.
    extensions: Record<string, unknown> = {},
  ) {
    const body: ProblemDetails = {
      ...extensions,
      title,
      status,
      detail,
      instance,
      code,
      validationsErrors,
    };
    super(body, status);
  }
}
