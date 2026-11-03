// An error the service answers as it is (see handle in index.js): with its
// status, and its message, said plainly for whoever asked. Each part of the
// service has its own kind of it (ShareError, CastError and the rest), so
// where it came from can still be told.
export class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
