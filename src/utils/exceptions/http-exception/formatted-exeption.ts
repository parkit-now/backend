import { HttpException, HttpStatus } from '@nestjs/common';

export interface ProblemDetails {
  title: string;
  status: number;
  detail: string;
  instance: string;
  validationsErrors?: ValidationErr[];
}

export class FormattedException extends HttpException {
  constructor(
    title: string,
    status: HttpStatus,
    detail: string,
    instance: string,
  ) {
    const body: ProblemDetails = { title, status, detail, instance };
    super(body, status);
  }
}

export class ValidationErr {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {}
}

export class FormattedExceptionWithValidation extends HttpException {
  constructor(
    title: string,
    status: HttpStatus,
    detail: string,
    instance: string,
    validationsErrors: ValidationErr[],
  ) {
    const body: ProblemDetails = {
      title,
      status,
      detail,
      instance,
      validationsErrors,
    };
    super(body, status);
  }
}
