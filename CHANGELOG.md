# Changelog

## Unreleased

- Rename `drain()` → `flush()` (breaking if you were calling it directly; interceptor/filter do this internally).
- Emit `outcome: 'timeout'` when a record's TTL expires instead of silently dropping the line.
- Move internal record state to Symbol keys so callers can't overwrite it via `addFields()`.
- Deliberately do NOT emit `error.stack` on the canonical line — too large, not group-by-able, and better handled by a dedicated error tracker correlated via trace ID.
- Wrap the underlying logger call in try/catch — observability failures no longer break the request.
- Skip `super.catch()` for non-HTTP transports (was misbehaving in hybrid apps).
- Fix deprecated `rxjs/operators` import.
- Remove load shedding (`maxActiveRecords`). It silently dropped canonical lines under load, exactly when you need them. The TTL sweep is the memory bound now: `recordTtlMs` clamps to a 1s minimum and can no longer be disabled.
- Guard `initialize()` against running outside a CLS context (was throwing per-request when ClsModule wasn't mounted).
- Validate `service` at boot — throw if empty.
- Add integration tests (13, all real Nest + supertest — no mocks).
- Add PII / redaction guidance to the README.

## 0.1.0

Initial release. Interceptor + filter + middleware + CLS-backed record; one structured canonical line per HTTP request.
